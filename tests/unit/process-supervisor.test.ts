import type { HeldLaunch } from '../../src/shared/process-supervisor.ts'
import type { StandInProcess, StandInWorld } from './process-supervisor-world.ts'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { describe, test } from 'node:test'
import { promisify } from 'node:util'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'
import { jobSystem, readReply, Supervisor, unreadableImage } from '../../src/shared/process-supervisor.ts'
import { JobLaunches } from '../../src/shared/process-system.ts'
import { standInProcess as entry, standInStart as started, standInSupervisor } from './process-supervisor-world.ts'

// Every case runs the stand-in through the real metadata worker, as the runner runs retest-supervisor on Windows, so the
// command lines, the bounded readings and the reply checks are the ones Windows gets; only the answers are the stand-in's.

const runner = 4242
const word = '0123456789abcdef'

function world(overrides: Partial<StandInWorld> = {}): ReturnType<typeof standInSupervisor> {
  return standInSupervisor(runner, overrides)
}

describe('the supervisor client', () => {
  test('names every job after the runner and its own word, and reads each answer the supervisor gives', async () => {
    const stand = world({ processes: [entry(runner, 1), entry(5000, runner), entry(5001, 5000)] })
    const supervisor = new Supervisor(stand.program, runner, word)
    assert.equal(supervisor.runnerJob, `Local\\retest-${runner}-${word}`)
    assert.equal(supervisor.launchJob(5000), `Local\\retest-${runner}-${word}-5000-1`)
    assert.deepEqual(supervisor.hold(), { job: supervisor.runnerJob, handle: 100 })
    const launch = supervisor.adopt(5000)
    assert.equal(launch.job, `Local\\retest-${runner}-${word}-5000-1`)
    assert.equal(supervisor.launchJob(5000), `Local\\retest-${runner}-${word}-5000-2`, 'a later launch given the same pid gets a name of its own')
    assert.deepEqual(supervisor.launchJobs, [launch.job])
    assert.equal(launch.handle, 104)
    assert.deepEqual(launch.root, { pid: 5000, parentPid: runner, startedAt: started(5000), image: 'C:\\Apps\\5000.exe' })
    assert.deepEqual(launch.late.map((entry) => entry.pid), [5001], 'a helper started before the hold is held with its launch')
    assert.deepEqual([launch.byParent, launch.unheld, launch.complete], [[], [], true])
    assert.deepEqual(supervisor.members(launch.job).map((entry) => entry.pid), [5000, 5001])
    assert.deepEqual((await supervisor.membersAsync(launch.job)).map((entry) => entry.pid), [5000, 5001])
    assert.deepEqual(supervisor.process(5001, launch.job), { process: { pid: 5001, parentPid: 5000, startedAt: started(5001), image: 'C:\\Apps\\5001.exe' }, inJob: true })
    assert.deepEqual(await supervisor.processAsync(77, launch.job), { process: undefined, inJob: false })
    assert.equal(supervisor.terminate(launch.job, 5001, '1'), 'different')
    assert.equal(supervisor.terminate(launch.job, 5001, started(5001)), 'terminated')
    assert.equal(supervisor.terminate(launch.job, 5001, started(5001)), 'absent')
    supervisor.end(launch.job)
    assert.deepEqual(supervisor.members(launch.job), [])
    supervisor.release(launch.job, launch.handle)
    assert.equal(stand.read().jobs[launch.job], undefined)
    assert.deepEqual(supervisor.launchJobs, [], 'a released job is no longer read beside the runner')
    assert.deepEqual(stand.read().calls.map((call) => call[0]), ['hold', 'adopt', 'members', 'members', 'process', 'process', 'terminate', 'terminate', 'terminate', 'end', 'members', 'release'])
    assert.deepEqual(stand.read().calls[1], ['adopt', '--runner', `${runner}`, '--within', supervisor.runnerJob, '--job', launch.job, '--pid', '5000'])
  })

  test('the runner job is read beside every launch job it holds, for what no launch job holds', async () => {
    const stand = world({ processes: [entry(runner, 1), entry(5000, runner), entry(6000, runner), entry(6100, 6050)], orphans: [6100] })
    const supervisor = new Supervisor(stand.program, runner, word)
    supervisor.hold()
    const first = supervisor.adopt(5000)
    const second = supervisor.adopt(6000)
    assert.deepEqual(supervisor.strays().map((entry) => entry.pid), [6100])
    assert.deepEqual((await supervisor.straysAsync()).map((entry) => entry.pid), [6100])
    assert.deepEqual(stand.read().calls.at(-1), ['strays', '--runner', `${runner}`, '--job', supervisor.runnerJob, '--launches', `${first.job},${second.job}`])
  })

  test('a refusal keeps the Windows call behind it apart from its sentence, as the cause', () => {
    const detail = 'TerminateJobObject failed with Windows error 5.'
    const stand = world({ refuse: { end: { problem: 'The job Local\\retest-x could not be ended.', detail } } })
    const supervisor = new Supervisor(stand.program, runner, word)
    assert.throws(() => supervisor.end('Local\\retest-x'), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, 'The job Local\\retest-x could not be ended.')
      assert.ok(error.cause instanceof Error)
      assert.equal(error.cause.message, detail)
      return true
    })
  })

  test('an adoption that is refused, or whose answer is lost, ends whatever its job came to hold', () => {
    const stand = world({ processes: [entry(runner, 1), entry(5000, runner)], exit: { adopt: 3 } })
    const supervisor = new Supervisor(stand.program, runner, word)
    supervisor.hold()
    const name = supervisor.launchJob(5000)
    assert.throws(() => supervisor.adopt(5000), /metadata process ended without a successful reading/)
    assert.deepEqual(stand.read().calls.at(-1), ['end', '--runner', `${runner}`, '--job', name])
    assert.equal(stand.read().calls.filter((call) => call[0] === 'end').length, 3, 'a job an answer was lost for is looked for a few times')
    assert.deepEqual(supervisor.launchJobs, [])
    stand.change((current) => { Reflect.deleteProperty(current, 'exit'); current.refuse = { adopt: 'Process 5000 could not be held in a job of its own.' } })
    const before = stand.read().calls.length
    assert.throws(() => supervisor.adopt(5000), { message: 'Process 5000 could not be held in a job of its own.' })
    assert.deepEqual(stand.read().calls.slice(before).map((call) => call[0]), ['adopt', 'end'], 'a refusal is final, so its job is asked to end once')
  })

  test('a launch whose own process ended is named with what its job still holds, at the run end', async () => {
    const stand = world({ processes: [entry(runner, 1), entry(5000, runner), entry(6000, runner)] })
    const supervisor = new Supervisor(stand.program, runner, word)
    supervisor.hold()
    supervisor.adopt(5000)
    supervisor.adopt(6000)
    stand.change((current) => {
      current.processes.push(entry(5001, 5000))
      current.jobs[`Local\\retest-${runner}-${word}-5000-1`]?.members.push(5001)
      for (const each of current.processes) if (each.pid === 5000) each.running = false
    })
    assert.deepEqual((await supervisor.leftoversAsync()).found.map((leftover) => [leftover.root, leftover.process.pid]), [[5000, 5001]], 'the launch that is still running is not read for leftovers')
  })

  test("a run's end reads only its own launches when one host holds several runs at once", async () => {
    const stand = world({ processes: [entry(runner, 1), entry(5000, runner), entry(5001, 5000), entry(6000, runner), entry(6001, 6000)] })
    const supervisor = new Supervisor(stand.program, runner, word)
    supervisor.hold()
    const first = supervisor.adopt(5000)
    const second = supervisor.adopt(6000)
    stand.change((current) => { for (const each of current.processes) if (each.pid === 5000 || each.pid === 6000) each.running = false })
    const own = await supervisor.leftoversAsync(undefined, new Set([first.job]))
    assert.deepEqual(own.found.map((leftover) => [leftover.root, leftover.process.pid]), [[5000, 5001]], "the other run's launch is not read")
    const every = await supervisor.leftoversAsync()
    assert.deepEqual(every.found.map((leftover) => leftover.root), [5000, 6000])
    assert.equal(second.job.endsWith('-6000-2'), true)
  })

  test('a console host is never named as left running, in a launch job or outside every one; its programs are', async () => {
    const host = 'C:\\Windows\\System32\\conhost.exe'
    const stand = world({ processes: [entry(runner, 1), entry(5000, runner), entry(5001, 5000, host), entry(6100, 6050), entry(6200, 6150, host)], orphans: [6100, 6200] })
    const supervisor = new Supervisor(stand.program, runner, word)
    supervisor.hold()
    const launch = supervisor.adopt(5000)
    assert.deepEqual(launch.late.map((each) => each.pid), [5001], 'the console host of a launch is held with it')
    stand.change((current) => { for (const each of current.processes) if (each.pid === 5000) each.running = false })
    assert.deepEqual((await supervisor.leftoversAsync()).found, [], 'the console host of a launch that ended is not a leftover')
    assert.deepEqual(supervisor.strays().map((each) => each.pid), [6100], 'nor is one outside every launch a stray, while the program beside it is')
  })

  test("a launch's job gone or unread at the run's end leaves the reading whole, and what it holds is read as no launch's", async () => {
    const stand = world({ processes: [entry(runner, 1), entry(5000, runner), entry(5001, 5000), entry(6000, runner), entry(6001, 6000)], orphans: [5001, 6001] })
    const supervisor = new Supervisor(stand.program, runner, word)
    supervisor.hold()
    const gone = supervisor.adopt(5000)
    const unread = supervisor.adopt(6000)
    stand.change((current) => {
      for (const each of current.processes) if (each.pid === 5000 || each.pid === 6000) each.running = false
      // As a release whose answer was lost leaves it: the runner's handle closed, the launch still on the client's list.
      Reflect.deleteProperty(current.jobs, gone.job)
    })
    const leftovers = await supervisor.leftoversAsync()
    assert.deepEqual([leftovers.found.map((leftover) => [leftover.root, leftover.process.pid]), leftovers.unread], [[[6000, 6001]], [gone.job]])
    stand.change((current) => { current.refuse = { members: 'Retest could not open what it holds.' } })
    const refused = await supervisor.leftoversAsync()
    assert.deepEqual([refused.found, refused.unread], [[], [gone.job, unread.job]])
    assert.deepEqual((await supervisor.straysAsync()).map((each) => each.pid), [5001], "a process of a job still there is its launch's")
    assert.deepEqual((await supervisor.straysAsync(undefined, refused.unread)).map((each) => each.pid), [5001, 6001], 'left out, what an unread job holds is named')
    assert.deepEqual(stand.read().calls.at(-1), ['strays', '--runner', `${runner}`, '--job', supervisor.runnerJob])
  })

  test('a refusal throws the supervisor own sentence, and ending the runner own job is refused', async () => {
    const stand = world({ processes: [entry(runner, 1), entry(5000, 1)] })
    const supervisor = new Supervisor(stand.program, runner, word)
    supervisor.hold()
    assert.throws(() => supervisor.hold(), { message: 'Another job already has this name, so it was not used.' })
    assert.throws(() => supervisor.adopt(5000), { message: `Process 5000 was not started by process ${runner}, so it was not held.` })
    assert.throws(() => supervisor.end(supervisor.runnerJob), { message: 'These processes include Retest itself, so they were not ended.' })
    await assert.rejects(supervisor.membersAsync('Local\\retest-nobody'), { message: 'Retest no longer holds these processes.' })
  })

  test('an answer that is not one checked line of the asked type is a failed reading, never an answer', () => {
    const cases: [string, Partial<StandInWorld>, RegExp][] = [
      ['two lines', { print: { members: '{"schemaVersion":1,"type":"ended","job":"x"}\n{"schemaVersion":1,"type":"ended","job":"x"}\n' } }, /did not answer with one line/],
      ['not JSON', { print: { members: 'members: none\n' } }, /not JSON/],
      ['another schema', { print: { members: '{"schemaVersion":2,"type":"members","job":"x","processes":[]}\n' } }, /cannot read/],
      ['another type', { print: { members: '{"schemaVersion":1,"type":"ended","job":"x"}\n' } }, /answered ended where members was asked for/],
      ['a start that is not ticks', { print: { members: '{"schemaVersion":1,"type":"members","job":"x","processes":[{"pid":5,"parentPid":4,"startedAt":"Mon Oct 12","image":null}]}\n' } }, /not a count of ticks/],
      ['a failing exit', { exit: { members: 3 } }, /metadata process ended without a successful reading/],
    ]
    for (const [name, overrides, problem] of cases) {
      const supervisor = new Supervisor(world(overrides).program, runner, word)
      assert.throws(() => supervisor.members('Local\\retest-x'), problem, name)
    }
  })

  test('a reply is read whole: its one line, with or without its newline', () => {
    assert.deepEqual(readReply('{"schemaVersion":1,"type":"released","job":"Local\\\\retest-1-ab-2"}'), { schemaVersion: 1, type: 'released', job: 'Local\\retest-1-ab-2' })
    assert.throws(() => readReply('\n'), /did not answer with one line/)
    assert.throws(() => readReply('{"schemaVersion":1,"type":"released","job":"x","extra":1}\n'), /cannot read/)
  })

  test('an awaited reading completes in a standalone process with no other live handle', async () => {
    const stand = world({ processes: [entry(runner, 1), entry(5000, runner)], jobs: { 'Local\\retest-x': { members: [5000], handle: 8 } } })
    const module = new URL('../../src/shared/process-supervisor.ts', import.meta.url).href
    const source = `import { Supervisor } from ${JSON.stringify(module)}; const members = await new Supervisor(${JSON.stringify(stand.program)}, ${runner}).membersAsync('Local\\\\retest-x'); process.stdout.write(String(members.length))`
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--conditions=retest-source', '--input-type=module', '-e', source])
    assert.equal(stdout, '1')
    assert.equal(stderr, '')
  })

  test('a job word that is not hexadecimal is refused before any job is named', () => {
    assert.throws(() => new Supervisor(world().program, runner, 'Local\\x'), RangeError)
  })
})

describe('a launch held in a job', () => {
  function held(processes: StandInProcess[], overrides: Partial<StandInWorld> = {}): { stand: ReturnType<typeof world>; supervisor: Supervisor; launch: HeldLaunch; ownership: OwnedProcessGroup } {
    const stand = world({ processes: [entry(runner, 1), ...processes], ...overrides })
    const supervisor = new Supervisor(stand.program, runner, word)
    supervisor.hold()
    const launch = supervisor.adopt(5000)
    return { stand, supervisor, launch, ownership: new OwnedProcessGroup(5000, runner, jobSystem(supervisor, launch)) }
  }

  const launchJob = `Local\\retest-${runner}-${word}-5000-1`

  test('owns every member of its job, a helper whose parent is gone included, and is ended whole by its job', async () => {
    const { stand, ownership } = held([entry(5000, runner), entry(5001, 5000), entry(5002, 9999)])
    stand.change((current) => { current.jobs[launchJob]?.members.push(5002) })
    assert.ok(ownership.heldByJob)
    assert.deepEqual(ownership.capture(), [], 'a member whose parent is not in the job is still owned, never an unverified one')
    assert.deepEqual(ownership.verifiedIdentity(5002)?.pid, 5002)
    assert.ok(ownership.remains())
    assert.deepEqual(ownership.signal('SIGTERM'), [])
    assert.equal(await ownership.remainsAsync(), false)
    const asked = stand.read().calls.map((call) => call[0])
    assert.ok(asked.includes('end'), 'the job was ended')
    assert.ok(!asked.includes('terminate'), 'no process was ended one by one')
    assert.deepEqual(asked.slice(-3), ['members', 'release', 'strays'], 'a job read empty gives its handle back, and the runner job is read for what it left')
    assert.deepEqual(stand.read().jobs[launchJob], undefined)
    assert.deepEqual(ownership.readProblems, [])
  })

  test('a launch read empty while the runner job holds a process nothing stands behind leaves its cleanup unconfirmed, naming it', async () => {
    const { stand, ownership } = held([entry(5000, runner), entry(6100, 6050, 'C:\\Apps\\orphan.exe')], { orphans: [6100] })
    assert.deepEqual(ownership.capture(), [])
    assert.deepEqual(ownership.signal('SIGKILL'), [])
    assert.equal(await ownership.remainsAsync(), false, 'the launch job itself is empty')
    assert.deepEqual(ownership.readProblems, ['Process 6100 (orphan.exe) is still running after process 5000 ended. Retest ends it when Retest exits.'])
    assert.equal(stand.read().calls.filter((call) => call[0] === 'strays').length, 1, 'the runner job is read once, when the launch job is first read empty')
  })

  test('a process held by its parent, and what it starts, belong to the launch until they are gone, as a Windows Firefox launcher browser does', () => {
    const { stand, ownership, launch } = held([entry(5000, runner), entry(5001, 5000), entry(5002, 5001)], { byParent: [5001] })
    assert.deepEqual(launch.byParent.map((each) => each.pid), [5001])
    assert.deepEqual(stand.read().jobs[launchJob]?.members, [5000], 'only the launcher is in the launch job')
    assert.deepEqual(ownership.capture(), [])
    assert.ok(ownership.verifiedIdentity(5001) !== undefined, 'the browser its launcher holds is the launch own')
    assert.ok(ownership.verifiedIdentity(5002) !== undefined, 'and so is what the browser started')
    assert.deepEqual(ownership.signal('SIGKILL'), [])
    assert.ok(ownership.remains(), 'the browser outlives its launcher for a moment, and the launch is not gone while it runs')
    stand.change((current) => { for (const each of current.processes) if (each.pid === 5001 || each.pid === 5002) each.running = false })
    assert.equal(ownership.remains(), false)
    assert.deepEqual(ownership.readProblems, [], 'nothing is left and nothing is unconfirmed')
  })

  test('a process left running is named once, for the first launch it is seen after, and later launches leave it alone', async () => {
    const stand = world({ processes: [entry(runner, 1), entry(5000, runner), entry(6000, runner), entry(7000, runner), entry(6100, 6050)], orphans: [6100] })
    const supervisor = new Supervisor(stand.program, runner, word)
    supervisor.hold()
    const owners = [5000, 6000, 7000].map((pid) => new OwnedProcessGroup(pid, runner, jobSystem(supervisor, supervisor.adopt(pid))))
    for (const owner of owners) {
      assert.deepEqual(owner.capture(), [])
      assert.deepEqual(owner.signal('SIGKILL'), [])
      assert.equal(await owner.remainsAsync(), false)
    }
    assert.deepEqual(owners.map((owner) => owner.readProblems), [['Process 6100 (6100.exe) is still running after process 5000 ended. Retest ends it when Retest exits.'], [], []])
  })

  test('a runner job that cannot be read leaves the cleanup unconfirmed, saying why', () => {
    const { stand, ownership } = held([entry(5000, runner)])
    stand.change((current) => { current.refuse = { strays: 'Windows would not list the processes in a job.' } })
    assert.deepEqual(ownership.signal('SIGKILL'), [])
    assert.equal(ownership.remains(), false)
    assert.deepEqual(ownership.readProblems, ['Retest could not look for processes still running after process 5000 ended: Windows would not list the processes in a job.'])
  })

  test('SIGINT is Ctrl+C on the console of the launch, sent once, and a launch that cannot be asked is still ended by its job', () => {
    const asked = held([entry(5000, runner), entry(5001, 5000)], { stopsOnCtrlC: true })
    assert.deepEqual(asked.ownership.capture(), [])
    assert.deepEqual(asked.ownership.signal('SIGINT'), [])
    assert.deepEqual(asked.stand.read().calls.filter((call) => call[0] === 'interrupt'), [['interrupt', '--runner', `${runner}`, '--job', launchJob]])
    assert.equal(asked.ownership.remains(), false, 'the launch stopped on Ctrl+C')
    const shared = held([entry(5000, runner)], { console: 'shared' })
    assert.deepEqual(shared.ownership.signal('SIGINT'), [], 'a launch on Retest console is not asked, and that is no cleanup problem')
    assert.ok(shared.ownership.remains())
    assert.deepEqual(shared.ownership.signal('SIGKILL'), [])
    assert.equal(shared.ownership.remains(), false)
  })

  test('a job read empty answers empty from then on without asking, and its end asks nothing', async () => {
    const { stand, supervisor, launch } = held([entry(5000, runner)])
    const system = jobSystem(supervisor, launch)
    stand.change((current) => { for (const entry of current.processes) if (entry.pid === 5000) entry.running = false })
    assert.deepEqual(system.read(), [])
    const before = stand.read().calls.length
    assert.deepEqual(await system.readAsync?.(), [])
    system.job?.end()
    await system.job?.endAsync()
    assert.equal(stand.read().calls.length, before)
  })

  test('a descendant handed off on its own is ended by its recorded start, and a pause is refused by name', async () => {
    const { stand, ownership } = held([entry(5000, runner), entry(5001, 5000, null)])
    assert.deepEqual(ownership.capture(), [])
    const helper = ownership.groupFor(5001)
    assert.ok(helper !== undefined)
    assert.equal(helper.heldByJob, false, 'a descendant is not its job root')
    assert.equal(helper.verifiedIdentity()?.command, unreadableImage)
    assert.match(helper.signal('SIGSTOP').join(' '), /Windows has no SIGSTOP; Retest only ends a process there, through its job\./)
    assert.deepEqual(helper.signal('SIGKILL'), [])
    assert.deepEqual(stand.read().calls.at(-1), ['terminate', '--runner', `${runner}`, '--job', launchJob, '--pid', '5001', '--started', started(5001)])
    assert.equal(await helper.remainsAsync(), false)
    assert.ok(ownership.remains(), 'the launch itself is still there')
  })

  test('a launch that ended before it was held is recorded from its adoption, and what it left running is its own', () => {
    const stand = world({ processes: [entry(runner, 1), { ...entry(5000, runner), running: false }, entry(5001, 5000)] })
    const supervisor = new Supervisor(stand.program, runner, word)
    supervisor.hold()
    const launch = supervisor.adopt(5000)
    assert.equal(launch.ended, true)
    assert.deepEqual(launch.late.map((each) => each.pid), [5001])
    const ownership = new OwnedProcessGroup(5000, runner, jobSystem(supervisor, launch))
    assert.deepEqual(ownership.capture(), [], 'the launch was read alive when it was held, so it is recorded, not missed')
    assert.equal(ownership.initialProcessAbsent, false)
    assert.ok(ownership.verifiedIdentity(5001) !== undefined)
    assert.ok(ownership.remains(), 'what the launch left running keeps it there')
    assert.deepEqual(ownership.signal('SIGKILL'), [])
    assert.equal(ownership.remains(), false)
  })

  test('a job that could not be ended is a cleanup problem naming the launch', () => {
    const { stand, ownership } = held([entry(5000, runner)])
    stand.change((current) => { current.refuse = { end: { problem: `The job ${launchJob} could not be ended.`, detail: 'TerminateJobObject failed with Windows error 5.' } } })
    assert.deepEqual(ownership.signal('SIGKILL'), [`Could not end the job holding process 5000 and what it started: The job ${launchJob} could not be ended.`])
    assert.ok(ownership.remains())
  })
})

describe('launches held through one supervisor', () => {
  async function child(): Promise<ReturnType<typeof spawn>> {
    const launched = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
    await once(launched, 'spawn')
    return launched
  }

  test('the runner is held once, before its first launch, and each launch in a job of its own', async () => {
    const launched = await child()
    const pid = launched.pid ?? 0
    const stand = world({ runner: process.pid, processes: [entry(process.pid, 1), entry(pid, process.pid)] })
    const launches = new JobLaunches(() => stand.program)
    launches.prepare()
    launches.prepare()
    const ownership = launches.hold(launched)
    assert.deepEqual(ownership.capture(), [])
    assert.ok(ownership.heldByJob)
    assert.deepEqual(launches.ownership(pid).capture(), [], 'a second owner of the same launch reads the same job')
    assert.deepEqual(stand.read().calls.map((call) => call[0]), ['hold', 'adopt', 'members', 'members'])
    launched.kill('SIGKILL')
    await once(launched, 'exit')
  })

  test('a hold that fails says so and is tried again at the next launch', () => {
    const stand = world({ refuse: { hold: { problem: `Process ${runner} could not be put in a job.`, detail: 'AssignProcessToJobObject failed with Windows error 5.' } } })
    const launches = new JobLaunches(() => stand.program, runner)
    assert.throws(() => launches.prepare(), { message: `Retest could not hold the processes it starts in a Windows job, so it started none: Process ${runner} could not be put in a job.` })
    stand.change((current) => { Reflect.deleteProperty(current, 'refuse') })
    launches.prepare()
    assert.deepEqual(stand.read().calls.map((call) => call[0]), ['hold', 'hold'])
    assert.notEqual(stand.read().calls[0]?.[4], stand.read().calls[1]?.[4], 'the second hold is under a new name')
  })

  test('a child that could not be held is ended through its own handle, and its ownership fails every reading with why', async () => {
    const launched = await child()
    const pid = launched.pid ?? 0
    const stand = world({ runner: process.pid, processes: [entry(process.pid, 1), entry(pid, process.pid)], refuse: { adopt: { problem: `Process ${pid} could not be held in a job of its own.`, detail: 'AssignProcessToJobObject failed with Windows error 5.' } } })
    const launches = new JobLaunches(() => stand.program)
    launches.prepare()
    const exited = once(launched, 'exit')
    const ownership = launches.hold(launched)
    await exited
    assert.deepEqual(ownership.capture(), [`Could not read ownership of process ${pid}: Process ${pid} could not be held in a job of its own, so it was ended: Process ${pid} could not be held in a job of its own.`])
    assert.ok(ownership.remains(), 'a launch whose ownership was never read keeps what it holds')
  })

  test('helpers the supervisor could not hold with their launch fail its first reading, and later ones read the job', async () => {
    const launched = await child()
    const pid = launched.pid ?? 0
    const job = 'Local\\retest-x'
    const stand = world({ runner: process.pid, processes: [entry(process.pid, 1), entry(pid, process.pid)], jobs: { [job]: { members: [pid], handle: 8 } }, print: { adopt: `${JSON.stringify({ schemaVersion: 1, type: 'adopted', job, handle: 8, root: { pid, parentPid: process.pid, startedAt: started(pid), image: null }, ended: false, late: [], byParent: [], unheld: [7001, 7002], complete: true })}\n` } })
    const launches = new JobLaunches(() => stand.program)
    launches.prepare()
    const ownership = launches.hold(launched)
    assert.match(ownership.capture().join(' '), /Retest could not hold processes 7001 and 7002, which process \d+ started before Retest held it\. They end when Retest exits\./)
    assert.deepEqual(ownership.capture(), [], 'the next reading reads the job and owns its members')
    assert.equal(ownership.readProblems.length, 1, 'the first refusal is kept')
    launched.kill('SIGKILL')
    await once(launched, 'exit')
  })

  test('a helper its parent holds in a job of its own is held, and a search that did not finish fails the first reading', async () => {
    for (const [byParent, complete, problem] of [[true, true, undefined], [false, false, /kept starting processes while Retest took hold of them\. Any Retest missed end when Retest exits\./]] as const) {
      const launched = await child()
      const pid = launched.pid ?? 0
      const job = 'Local\\retest-y'
      const helper = { pid: 7003, parentPid: pid, startedAt: started(7003), image: null }
      const stand = world({ runner: process.pid, processes: [entry(process.pid, 1), entry(pid, process.pid)], jobs: { [job]: { members: [pid], handle: 8 } }, print: { adopt: `${JSON.stringify({ schemaVersion: 1, type: 'adopted', job, handle: 8, root: { pid, parentPid: process.pid, startedAt: started(pid), image: null }, ended: false, late: [], byParent: byParent ? [helper] : [], unheld: [], complete })}\n` } })
      const launches = new JobLaunches(() => stand.program)
      launches.prepare()
      const ownership = launches.hold(launched)
      assert.deepEqual(launches.launchOf(pid)?.byParent.map((each) => each.pid), byParent ? [7003] : [])
      if (problem === undefined) assert.deepEqual(ownership.capture(), [])
      else assert.match(ownership.capture().join(' '), problem)
      launched.kill('SIGKILL')
      await once(launched, 'exit')
    }
  })
})
