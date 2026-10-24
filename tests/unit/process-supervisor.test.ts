import type { HeldLaunch } from '../../src/shared/process-supervisor.ts'
import type { StandInProcess, StandInWorld } from './process-supervisor-world.ts'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'
import { jobSystem, readReply, Supervisor, unreadableImage } from '../../src/shared/process-supervisor.ts'
import { JobLaunches, runEndProblems } from '../../src/shared/process-system.ts'
import { standInProcess as entry, standInStart as started, standInSupervisor } from './process-supervisor-world.ts'

// Every case runs the stand-in through the real metadata worker, as the runner runs retest-supervisor on Windows, so the
// command lines, the bounded readings and the reply checks are the ones Windows gets; only the answers are the stand-in's.

const runner = 4242
const word = '0123456789abcdef'
const spawning = fileURLToPath(new URL('./process-supervisor-spawning.ts', import.meta.url))

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
    stand.change((current) => { for (const each of current.processes) if (each.pid === 5000) each.running = false })
    assert.ok(ownership.remains(), 'the browser outlives its launcher, and the launch is not gone while it runs')
    stand.change((current) => { for (const each of current.processes) if (each.pid === 5001 || each.pid === 5002) each.running = false })
    assert.equal(ownership.remains(), false)
    assert.deepEqual(ownership.readProblems, [], 'nothing is left and nothing is unconfirmed')
  })

  test("a launch's end ends what its parent holds too, and what that started, each by its recorded start, and leaves a pid now another process's alone", async () => {
    const { stand, ownership } = held([entry(5000, runner), entry(5001, 5000), entry(5002, 5001), entry(5003, 5000)], { byParent: [5001, 5003] })
    assert.deepEqual(ownership.capture(), [])
    // 5003's pid went to another process since: the same pid, another start.
    stand.change((current) => { for (const each of current.processes) if (each.pid === 5003) each.startedAt = '1' })
    assert.deepEqual(ownership.signal('SIGKILL'), [])
    const running = (pid: number): boolean => stand.read().processes.some((each) => each.pid === pid && each.running)
    assert.deepEqual([5000, 5001, 5002, 5003].map(running), [false, false, false, true], "the launcher by its job; the browser its launcher held, and what the browser started, by their starts; the reused pid is left alone")
    const ends = stand.read().calls.filter((call) => call[0] === 'terminate').map((call) => call[call.indexOf('--pid') + 1])
    assert.deepEqual(ends, ['5001', '5002'], 'a pid whose start is not the recorded one is not even asked to end')
    assert.equal(await ownership.remainsAsync(), false, 'nothing of the launch is left')
    assert.deepEqual(ownership.readProblems, [])
  })

  test("a launch's end ends what a process its parent held started, though that process ended first", async () => {
    const { stand, ownership } = held([entry(5000, runner), entry(5001, 5000)], { byParent: [5001] })
    assert.deepEqual(ownership.capture(), [])
    stand.change((current) => {
      for (const each of current.processes) if (each.pid === 5001) each.running = false
      current.processes.push(entry(5005, 5001))
    })
    assert.deepEqual(ownership.signal('SIGKILL'), [])
    assert.equal(stand.read().processes.some((each) => each.pid === 5005 && each.running), false)
    assert.equal(await ownership.remainsAsync(), false)
    assert.deepEqual(ownership.readProblems, [])
  })

  test("a launch's end leaves alone what a reused pid started, where a process its parent held ended first", async () => {
    const { stand, ownership } = held([entry(5000, runner), entry(5001, 5000)], { byParent: [5001] })
    assert.deepEqual(ownership.capture(), [])
    // 5001 has ended, leaving 5005 it started; 5001's pid then went to 7001's parent, which started after 5005, as a
    // pid is given again only once its process ended.
    stand.change((current) => {
      for (const each of current.processes) if (each.pid === 5001) each.running = false
      current.processes.push(entry(5005, 5001), { ...entry(5001, runner), startedAt: '13437009000006000' }, entry(7001, 5001))
    })
    assert.deepEqual(ownership.signal('SIGKILL'), [])
    const running = (pid: number): boolean => stand.read().processes.some((each) => each.pid === pid && each.running)
    assert.equal(running(5005), false, "a process that started before its parent's pid was given again is that parent's, the launch's")
    assert.equal(running(7001), true, 'what started after the pid was given again may be its new holder\'s, and is left alone')
    assert.equal(running(5001), true, 'as is the new holder')
    assert.equal(await ownership.remainsAsync(), false, "the reused pid's processes are not the launch's")
    assert.deepEqual(ownership.readProblems, [])
  })

  test("a launch's end ends no process another launch's job holds, though it started under a pid one of its own held", async () => {
    // Launch 5000 holds browser 5001 by its parent; 6000 is another launch of the same runner.
    const stand = world({ processes: [entry(runner, 1), entry(5000, runner), entry(5001, 5000), entry(6000, runner)], byParent: [5001] })
    const supervisor = new Supervisor(stand.program, runner, word)
    supervisor.hold()
    const launch = supervisor.adopt(5000)
    const other = supervisor.adopt(6000)
    const ownership = new OwnedProcessGroup(5000, runner, jobSystem(supervisor, launch))
    assert.deepEqual(ownership.capture(), [])
    // 5001 ends; launch 6000 then starts a short-lived process given pid 5001 again, which starts 7001 and exits, as a
    // launcher does. No reading came between, so 5001's record still stands behind what its pid started.
    stand.change((current) => {
      for (const each of current.processes) if (each.pid === 5001) each.running = false
      current.processes.push({ ...entry(5001, 6000, 'C:\\Apps\\launcher.exe'), startedAt: '13437009000006500', running: false }, entry(7001, 5001))
      current.jobs[other.job]?.members.push(7001)
    })
    assert.deepEqual(ownership.signal('SIGKILL'), [])
    const running = (pid: number): boolean => stand.read().processes.some((each) => each.pid === pid && each.running)
    assert.deepEqual([running(7001), running(6000)], [true, true], "launch 6000's processes are left running")
    assert.deepEqual(stand.read().calls.filter((call) => call[0] === 'terminate'), [], 'none is even asked to end')
    assert.equal(await ownership.remainsAsync(), false)
    assert.deepEqual(ownership.readProblems, [])
  })

  test("a parent that ended stands behind what it started for one reading only, so a later holder of its pid is never the launch's", async () => {
    const { stand, ownership } = held([entry(5000, runner), entry(5001, 5000)], { byParent: [5001] })
    assert.deepEqual(ownership.capture(), [])
    stand.change((current) => { for (const each of current.processes) if (each.pid === 5001) each.running = false })
    assert.equal(await ownership.remainsAsync(), true, 'the launcher still runs; this reading is the first to find 5001 gone')
    // Then a process given pid 5001 again, in no launch's job, starts 7001 and exits.
    stand.change((current) => { current.processes.push({ ...entry(5001, runner), startedAt: '13437009000006500', running: false }, entry(7001, 5001)) })
    assert.equal(await ownership.remainsAsync(), true)
    assert.equal(ownership.verifiedIdentity(7001), undefined, '7001 is not the launch\'s')
    assert.deepEqual(ownership.signal('SIGKILL'), [])
    assert.equal(stand.read().processes.some((each) => each.pid === 7001 && each.running), true)
    assert.deepEqual(stand.read().calls.filter((call) => call[0] === 'terminate'), [])
  })

  test("a launch's end ends no process it cannot tell from another launch's while that launch's job cannot be read, and ends it once one can", async () => {
    const stand = world({ processes: [entry(runner, 1), entry(5000, runner), entry(5001, 5000), entry(5002, 5001), entry(6000, runner)], byParent: [5001] })
    const supervisor = new Supervisor(stand.program, runner, word)
    supervisor.hold()
    const launch = supervisor.adopt(5000)
    const other = supervisor.adopt(6000)
    const ownership = new OwnedProcessGroup(5000, runner, jobSystem(supervisor, launch))
    assert.deepEqual(ownership.capture(), [])
    // The browser 5001 ends, and 5005, which started under its pid since the last reading, may be another launch's.
    const otherJob = stand.read().jobs[other.job]
    stand.change((current) => {
      for (const each of current.processes) if (each.pid === 5001) each.running = false
      current.processes.push(entry(5005, 5001))
      Reflect.deleteProperty(current.jobs, other.job)
    })
    assert.deepEqual(ownership.signal('SIGKILL'), [])
    const running = (pid: number): boolean => stand.read().processes.some((each) => each.pid === pid && each.running)
    assert.deepEqual([running(5000), running(5002), running(5005)], [false, false, true], 'what is the launch\'s by its record ends; what may be another launch\'s is left')
    assert.equal(await ownership.remainsAsync(), true, 'and it is still the launch\'s')
    stand.change((current) => { if (otherJob !== undefined) current.jobs[other.job] = otherJob })
    assert.deepEqual(ownership.signal('SIGKILL'), [])
    assert.equal(running(5005), false)
    assert.equal(await ownership.remainsAsync(), false)
  })

  test("a launch's readings ask only of its own job and the runner's, and its end reads the other launches' jobs once at most", async () => {
    const stand = world({ processes: [entry(runner, 1), entry(5000, runner), entry(5001, 5000), entry(6000, runner)], byParent: [5001] })
    stand.change((current) => { Object.assign(current, { spawnLimit: 2 }) })
    const supervisor = new Supervisor({ ...stand.program, args: [spawning, ...stand.program.args] }, runner, word)
    supervisor.hold()
    const launch = supervisor.adopt(5000)
    const other = supervisor.adopt(6000)
    const ownership = new OwnedProcessGroup(5000, runner, jobSystem(supervisor, launch))
    assert.deepEqual(ownership.capture(), [])
    stand.change((current) => {
      for (const each of current.processes) if (each.pid === 5001) each.running = false
      current.processes.push(entry(5005, 5001))
    })
    const asked = (): string[][] => stand.read().calls
    const before = asked().length
    assert.equal(await ownership.remainsAsync(), true, '5005 is counted through 5001, which has just ended')
    assert.deepEqual(asked().slice(before).map((call) => [call[0], call[call.indexOf('--job') + 1]]), [['members', launch.job], ['members', supervisor.runnerJob]])
    const ending = asked().length
    assert.deepEqual(ownership.signal('SIGKILL'), [])
    const otherReadings = asked().slice(ending).filter((call) => call[0] === 'members' && call.includes(other.job))
    assert.equal(otherReadings.length, 1, 'once, though each process the end ends starts another')
    assert.equal(stand.read().processes.some((each) => each.pid === 5005 && each.running), false)
  })

  test("a launch's end reads the runner's job once more, so what its parent's process started since the last reading ends too", async () => {
    const { stand, ownership } = held([entry(5000, runner), entry(5001, 5000)], { byParent: [5001] })
    assert.deepEqual(ownership.capture(), [])
    stand.change((current) => { current.processes.push(entry(5004, 5001)) })
    assert.deepEqual(ownership.signal('SIGKILL'), [])
    const running = (pid: number): boolean => stand.read().processes.some((each) => each.pid === pid && each.running)
    assert.deepEqual([5000, 5001, 5004].map(running), [false, false, false])
    assert.equal(await ownership.remainsAsync(), false)
    assert.deepEqual(ownership.readProblems, [])
  })

  // Each process ended starts another as it goes, the next one ending in the round after; the wrapper stops after
  // `spawnLimit` children. Three rounds end the browser and two children of it; a third child is a fourth process.
  for (const [spawnLimit, left] of [[2, []], [3, [8003]]] as const) {
    test(`a launch's end reads the runner's job up to three times, so ${spawnLimit} processes started as their parents end ${left.length === 0 ? 'all end' : 'leave the last, which the launch still holds'}`, async () => {
      const stand = world({ processes: [entry(runner, 1), entry(5000, runner), entry(5001, 5000)], byParent: [5001] })
      stand.change((current) => { Object.assign(current, { spawnLimit }) })
      const program = { ...stand.program, args: [spawning, ...stand.program.args] }
      const supervisor = new Supervisor(program, runner, word)
      supervisor.hold()
      const ownership = new OwnedProcessGroup(5000, runner, jobSystem(supervisor, supervisor.adopt(5000)))
      assert.deepEqual(ownership.capture(), [])
      assert.deepEqual(ownership.signal('SIGKILL'), [])
      const running = stand.read().processes.filter((each) => each.running && each.pid !== runner).map((each) => each.pid)
      assert.deepEqual(running, left)
      assert.equal(stand.read().calls.filter((call) => call[0] === 'members' && call.includes(supervisor.runnerJob)).length, 4, 'the capture, then three rounds')
      assert.equal(await ownership.remainsAsync(), left.length > 0)
      const look = ownership.lastLook
      assert.deepEqual(look !== undefined && 'running' in look ? look.running.map((each) => each.pid) : look, left, 'the reading names what is left')
      assert.deepEqual(ownership.readProblems, [])
      if (left.length === 0) return
      assert.deepEqual(ownership.signal('SIGKILL'), [])
      assert.equal(await ownership.remainsAsync(), false, 'a second end ends it')
    })
  }

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

describe("a run's end in a host that holds several runs", () => {
  // Run A's launch 5000 holds its browser 5001 by its parent, run B's launch 6000 holds 6001 so, and 6100 is a process
  // nothing ties to either. Each run is its launches by job, with what each has on record, as `asOneRun` keeps them.
  function twoRuns(): { stand: ReturnType<typeof world>; supervisor: Supervisor; first: Map<string, () => ReadonlyMap<number, string>>; second: Map<string, () => ReadonlyMap<number, string>>; owners: OwnedProcessGroup[] } {
    const stand = world({ processes: [entry(runner, 1), entry(5000, runner), entry(5001, 5000), entry(6000, runner), entry(6001, 6000), entry(6100, 6050)], byParent: [5001, 6001] })
    const supervisor = new Supervisor(stand.program, runner, word)
    supervisor.hold()
    const runs = [5000, 6000].map((pid) => {
      const launch = supervisor.adopt(pid)
      const system = jobSystem(supervisor, launch)
      return { run: new Map([[launch.job, system.onRecord]]), owner: new OwnedProcessGroup(pid, runner, system) }
    })
    for (const { owner } of runs) assert.deepEqual(owner.capture(), [])
    const [first, second] = runs
    assert.ok(first !== undefined && second !== undefined)
    return { stand, supervisor, first: first.run, second: second.run, owners: runs.map(({ owner }) => owner) }
  }

  // A launcher that ends leaves what its parent held running in no launch's job, with nothing running behind it.
  function launcherEnds(stand: ReturnType<typeof world>, launcher: number, left: number): void {
    stand.change((current) => {
      for (const each of current.processes) if (each.pid === launcher) each.running = false
      current.orphans = [...(current.orphans ?? []), left, 6100]
    })
  }

  const named = (problems: readonly string[]): string[] => problems.map((problem) => /^Process (\d+) /.exec(problem)?.[1] ?? problem)

  test('a run that ends while another goes on names what it left, and the other run names it no more', async () => {
    const { stand, supervisor, first, second } = twoRuns()
    launcherEnds(stand, 5000, 5001)
    const firstEnd = await runEndProblems(supervisor, first)
    assert.deepEqual(firstEnd, ['Process 5001 (5001.exe) is still running at the end of the run. Retest ends it when Retest exits.'])
    launcherEnds(stand, 6000, 6001)
    assert.deepEqual(named(await runEndProblems(supervisor, second)), ['6001'], 'the second run names its own process, not the first run\'s, nor one no run started')
    assert.deepEqual(await runEndProblems(supervisor, first), [], 'a process is named once in the host')
  })

  test('two runs that end together each name what they left', async () => {
    const { stand, supervisor, first, second } = twoRuns()
    launcherEnds(stand, 5000, 5001)
    launcherEnds(stand, 6000, 6001)
    const [firstEnd, secondEnd] = await Promise.all([runEndProblems(supervisor, first), runEndProblems(supervisor, second)])
    assert.deepEqual([named(firstEnd), named(secondEnd)], [['5001'], ['6001']])
  })

  test('the stand-in answers questions asked at once, each of them, as run ends and an end ask them', async () => {
    const { stand, supervisor } = twoRuns()
    const before = stand.read().calls.length
    const readings = await Promise.all(Array.from({ length: 8 }, () => supervisor.membersAsync(supervisor.runnerJob)))
    assert.ok(readings.every((reading) => reading.some((each) => each.pid === 5001)))
    assert.equal(stand.read().calls.length - before, 8, 'no answer was lost to another')
  })

  test("a process a launch's reading named is not named again at its run's end", async () => {
    const { stand, supervisor, first } = twoRuns()
    // Run A holds a second launch, 7000, which ends once A's launcher has left 5001 behind it.
    stand.change((current) => { current.processes.push(entry(7000, runner)) })
    const launch = supervisor.adopt(7000)
    const system = jobSystem(supervisor, launch)
    first.set(launch.job, system.onRecord)
    const owner = new OwnedProcessGroup(7000, runner, system)
    assert.deepEqual(owner.capture(), [])
    launcherEnds(stand, 5000, 5001)
    stand.change((current) => { for (const each of current.processes) if (each.pid === 7000) each.running = false })
    assert.equal(await owner.remainsAsync(), false)
    assert.deepEqual(named(owner.readProblems), ['5001', '6100'], 'the launch read empty names every stray it is the first to see')
    assert.deepEqual(await runEndProblems(supervisor, first), [], "the run's end names neither again")
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
