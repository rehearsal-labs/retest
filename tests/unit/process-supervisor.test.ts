import type { HeldLaunch, LaunchRecord } from '../../src/shared/process-supervisor.ts'
import type { StandInProcess, StandInWorld } from './process-supervisor-world.ts'
import assert from 'node:assert/strict'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'
import { jobSystem, namesFolder, readReply, Supervisor, unreadableImage } from '../../src/shared/process-supervisor.ts'
import { JobLaunches, launchesHeldByJob, runEndProblems } from '../../src/shared/process-system.ts'
import { tempFolder } from '../support/temp-folder.ts'
import { standInProcess as entry, standInStart as started, standInSupervisor } from './process-supervisor-world.ts'
import { giveBackWorld } from './process-supervisor-world-lock.ts'

// Every case runs the stand-in through the real metadata worker, as the runner runs retest-supervisor on Windows, so the
// command lines, the bounded readings and the reply checks are the ones Windows gets; only the answers are the stand-in's.

const runner = 4242
const word = '0123456789abcdef'
const spawning = fileURLToPath(new URL('./process-supervisor-spawning.ts', import.meta.url))

function world(overrides: Partial<StandInWorld> = {}): ReturnType<typeof standInSupervisor> {
  return standInSupervisor(runner, overrides)
}

// The pid of a process that has ended, as a stand-in ended while it held the world's lock leaves in it.
function endedPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid
}

function holderOf(lock: string): number {
  return Number(readFileSync(join(lock, 'holder'), 'utf8'))
}

describe('the supervisor client', () => {
  test('names every job after the runner and its own word, and reads each answer the supervisor gives', async () => {
    const stand = world({ processes: [entry(runner, 1), entry(5000, runner, 'C:\\Apps\\5000.exe', '"C:\\Apps\\5000.exe" --serve'), entry(5001, 5000)] })
    const supervisor = new Supervisor(stand.program, runner, word)
    assert.equal(supervisor.runnerJob, `Local\\retest-${runner}-${word}`)
    assert.equal(supervisor.launchJob(5000), `Local\\retest-${runner}-${word}-5000-1`)
    assert.deepEqual(supervisor.hold(), { job: supervisor.runnerJob, handle: 100 })
    const launch = supervisor.adopt(5000)
    assert.equal(launch.job, `Local\\retest-${runner}-${word}-5000-1`)
    assert.equal(supervisor.launchJob(5000), `Local\\retest-${runner}-${word}-5000-2`, 'a later launch given the same pid gets a name of its own')
    assert.deepEqual(supervisor.launchJobs, [launch.job])
    assert.equal(launch.handle, 104)
    assert.deepEqual(launch.root, { pid: 5000, parentPid: runner, startedAt: started(5000), image: 'C:\\Apps\\5000.exe', commandLine: '"C:\\Apps\\5000.exe" --serve' })
    assert.deepEqual(launch.late.map((entry) => entry.pid), [5001], 'a helper started before the hold is held with its launch')
    assert.deepEqual([launch.byParent, launch.unheld, launch.complete], [[], [], true])
    assert.deepEqual(supervisor.members(launch.job).map((entry) => entry.pid), [5000, 5001])
    assert.deepEqual((await supervisor.membersAsync(launch.job)).map((entry) => entry.pid), [5000, 5001])
    assert.deepEqual(supervisor.process(5001, launch.job), { process: { pid: 5001, parentPid: 5000, startedAt: started(5001), image: 'C:\\Apps\\5001.exe', commandLine: undefined }, inJob: true })
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
      ['a start that is not ticks', { print: { members: '{"schemaVersion":1,"type":"members","job":"x","processes":[{"pid":5,"parentPid":4,"startedAt":"Mon Oct 12","image":null,"commandLine":null}]}\n' } }, /not a count of ticks/],
      ['a process without its command line, as a supervisor older than this client answers', { print: { members: '{"schemaVersion":1,"type":"members","job":"x","processes":[{"pid":5,"parentPid":4,"startedAt":"1","image":null}]}\n' } }, /cannot read/],
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
  function held(processes: StandInProcess[], overrides: Partial<StandInWorld> = {}, system: Parameters<typeof jobSystem>[2] = {}): { stand: ReturnType<typeof world>; supervisor: Supervisor; launch: HeldLaunch; ownership: OwnedProcessGroup } {
    const stand = world({ processes: [entry(runner, 1), ...processes], ...overrides })
    const supervisor = new Supervisor(stand.program, runner, word)
    supervisor.hold()
    const launch = supervisor.adopt(5000)
    return { stand, supervisor, launch, ownership: new OwnedProcessGroup(5000, runner, jobSystem(supervisor, launch, system)) }
  }

  // The marker a launch is given, as Firefox's launch is given its folder's name, and a command line that carries it.
  const marker = 'retest-firefox-4242-AbCdEf'
  const marked = (pid: number): string => `"C:\\Firefox\\firefox.exe" --profile "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\${marker.toUpperCase()}\\profile" -${pid}`
  const runningIn = (stand: ReturnType<typeof world>, pid: number): boolean => stand.read().processes.some((each) => each.pid === pid && each.running)
  const ended = (stand: ReturnType<typeof world>): string[] => stand.read().calls.filter((call) => call[0] === 'terminate').map((call) => call[call.indexOf('--pid') + 1] ?? '')
  const race = fileURLToPath(new URL('./process-supervisor-race.ts', import.meta.url))

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
    assert.deepEqual(ownership.readProblems, ['Process 6100 (orphan.exe) is still running after the process that started it ended. Retest ends it when Retest exits.'], 'nothing of the launch stands behind it, so no launch is blamed')
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

  // The browser 5001 ends after the launch's last reading, leaving 5005, which carries nothing of the launch, and 5006,
  // which carries its folder, as a Firefox content process started after that reading outlives its browser a moment.
  const browserGone = (stand: ReturnType<typeof world>): void => {
    stand.change((current) => {
      for (const each of current.processes) if (each.pid === 5001) each.running = false
      current.processes.push(entry(5005, 5001), entry(5006, 5001, 'C:\\Firefox\\firefox.exe', marked(5006)))
    })
  }

  test("what the browser its parent held started is the launch's while the browser runs, and in the one reading a moment after it is gone", async () => {
    const { stand, ownership } = held([entry(5000, runner), entry(5001, 5000)], { byParent: [5001], orphans: [5005] }, { markers: [marker] })
    assert.deepEqual(ownership.capture(), [])
    browserGone(stand)
    assert.deepEqual(ownership.signal('SIGKILL'), [])
    assert.deepEqual(ended(stand).sort(), ['5005', '5006'], 'the browser ran in the reading a moment before, so both are ended through it')
    assert.deepEqual([runningIn(stand, 5005), runningIn(stand, 5006)], [false, false])
    assert.equal(await ownership.remainsAsync(), false)
    assert.deepEqual(ownership.readProblems, [])
  })

  test("what the browser its parent held started, once the browser has ended and its last reading is no longer a moment ago, is the launch's only by its marker", async () => {
    const { stand, ownership } = held([entry(5000, runner), entry(5001, 5000)], { byParent: [5001], orphans: [5005] }, { markers: [marker], lateParentMs: 0 })
    assert.deepEqual(ownership.capture(), [])
    browserGone(stand)
    assert.deepEqual(ownership.signal('SIGKILL'), [])
    assert.deepEqual(ended(stand), ['5006'], 'only the marked process is ended through a parent that has ended')
    assert.deepEqual([runningIn(stand, 5005), runningIn(stand, 5006)], [true, false])
    assert.equal(await ownership.remainsAsync(), false, '5005 is not the launch\'s')
    assert.deepEqual(ownership.readProblems, ['Process 5005 (5005.exe) is still running after the process that started it ended. Retest ends it when Retest exits.'], 'and, left running with nothing behind it, it is named without blaming the launch')
  })

  test("a process its record names, not a browser its parent held, stands behind nothing once it has ended, however soon the reading", async () => {
    const { stand, ownership } = held([entry(5000, runner), entry(5001, 5000), entry(5002, 5001)], { byParent: [5001], orphans: [5009] })
    assert.deepEqual(ownership.capture(), [])
    // 5002, a content process on record, ends, leaving 5009, which carries nothing of the launch.
    stand.change((current) => {
      for (const each of current.processes) if (each.pid === 5002) each.running = false
      current.processes.push(entry(5009, 5002))
    })
    assert.deepEqual(ownership.signal('SIGKILL'), [])
    assert.deepEqual(ended(stand), ['5001'])
    assert.equal(runningIn(stand, 5009), true, 'only a browser the launch held by its parent stands behind anything late')
  })

  test("a launch's end leaves alone what started under a pid its parent held once that process ended, however the starts fall", async () => {
    const { stand, ownership } = held([entry(5000, runner), entry(5001, 5000)], { byParent: [5001] }, { markers: [marker] })
    assert.deepEqual(ownership.capture(), [])
    // 5001 has ended, leaving 5005 it started; 5001's pid then went to 7001's parent, which started after 5005.
    stand.change((current) => {
      for (const each of current.processes) if (each.pid === 5001) each.running = false
      current.processes.push(entry(5005, 5001), { ...entry(5001, runner), startedAt: '13437009000006000' }, entry(7001, 5001))
    })
    assert.deepEqual(ownership.signal('SIGKILL'), [])
    assert.deepEqual(ended(stand), [], 'nothing names 5005 or 7001 the launch\'s')
    assert.deepEqual([runningIn(stand, 5005), runningIn(stand, 7001), runningIn(stand, 5001)], [true, true, true])
    assert.equal(await ownership.remainsAsync(), false)
  })

  test("a process whose parent's pid now belongs to a process that carries the launch's marker is not the launch's for it", async () => {
    const { stand, ownership } = held([entry(5000, runner), entry(5001, 5000)], { byParent: [5001] }, { markers: [marker] })
    assert.deepEqual(ownership.capture(), [])
    // 5001 ended and its pid went to 5001 again under a later start, a process that carries the marker, so is the
    // launch's; 5007 started before it, under the first 5001, and carries nothing.
    stand.change((current) => {
      for (const each of current.processes) if (each.pid === 5001) each.running = false
      current.processes.push(entry(5007, 5001), { ...entry(5001, 5000, 'C:\\Firefox\\firefox.exe', marked(5001)), startedAt: '13437009000009000' })
    })
    assert.deepEqual(ownership.signal('SIGKILL'), [])
    assert.deepEqual(ended(stand), ['5001'], 'the marked process is ended, by its own command line')
    assert.equal(runningIn(stand, 5007), true, 'a marker is read from the process itself, never from what holds its parent\'s pid')
  })

  test('a marker names a folder only as a whole part of a path, in any case', () => {
    for (const line of [`x --profile C:\\T\\${marker}\\profile`, `x --profile "C:\\T\\${marker}"`, `x --dir=C:/T/${marker.toLowerCase()} --y`, `x C:\\T\\${marker}`]) assert.equal(namesFolder(line, marker), true, line)
    for (const line of [`x C:\\T\\${marker}-copy`, `x C:\\T\\${marker}Gh\\p`, `x C:\\T\\pre${marker}\\p`, `x ${marker}\\p`, `x --name=${marker}`]) assert.equal(namesFolder(line, marker), false, line)
  })

  // A Firefox launch 5000 holds its browser 5001 by its parent; another launch 6000, a test file's process, has a helper
  // 6001 in its job whose command line names a folder by this launch's marker.
  for (const [name, line] of [
    ['a longer folder name that begins with the marker', `"C:\\Tools\\backup.exe" C:\\Temp\\${marker}-copy\\profile`],
    ["the launch's folder itself", `"C:\\Program Files\\nodejs\\node.exe" watch.js C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\${marker}\\downloads`],
  ] as const) {
    test(`M1: another launch's member whose command line names ${name} is not the launch's while its browser runs, nor at its end`, () => {
      const stand = world({ processes: [entry(runner, 1), entry(5000, runner), entry(5001, 5000, 'C:\\Firefox\\firefox.exe', marked(5001)), entry(6000, runner)], byParent: [5001] })
      const supervisor = new Supervisor(stand.program, runner, word)
      supervisor.hold()
      const firefox = new OwnedProcessGroup(5000, runner, jobSystem(supervisor, supervisor.adopt(5000), { markers: [marker] }))
      const other = supervisor.adopt(6000)
      assert.deepEqual(firefox.capture(), [])
      stand.change((current) => {
        current.processes.push(entry(6001, 6000, 'C:\\Tools\\helper.exe', line))
        current.jobs[other.job]?.members.push(6001)
      })
      assert.ok(firefox.remains())
      assert.equal(firefox.verifiedIdentity(6001), undefined)
      assert.deepEqual(firefox.signal('SIGKILL'), [])
      assert.deepEqual(ended(stand), ['5001'])
      assert.equal(runningIn(stand, 6001), true)
    })
  }

  test("M2: a process of the host whose command line names a folder whose name only begins with the launch's marker is not the launch's", async () => {
    const { stand, ownership } = held([entry(5000, runner), entry(5001, 5000, 'C:\\Firefox\\firefox.exe', marked(5001))], { byParent: [5001] }, { markers: [marker] })
    assert.deepEqual(ownership.capture(), [])
    // The browser and its launcher exit; the host's own tool 7001 runs on, naming a folder `<marker>Gh`.
    stand.change((current) => {
      for (const each of current.processes) if (each.pid === 5000 || each.pid === 5001) each.running = false
      current.processes.push(entry(7001, runner, 'C:\\Tools\\tool.exe', `tool.exe --out C:\\Temp\\${marker}Gh`))
    })
    assert.equal(await ownership.remainsAsync(), false, "a closed Firefox reads as gone while the host's own tool runs")
  })

  test("P1: a launch's end leaves another launch's browser alone, held by its parent under a pid this launch had on record", () => {
    const stand = world({ processes: [entry(runner, 1), entry(5000, runner), entry(5001, 5000), entry(5002, 5001)], byParent: [5001] })
    const supervisor = new Supervisor(stand.program, runner, word)
    supervisor.hold()
    const first = new OwnedProcessGroup(5000, runner, jobSystem(supervisor, supervisor.adopt(5000), { markers: [marker] }))
    assert.deepEqual(first.capture(), [])
    // Content process 5002 ends. A second Firefox's launcher is given pid 5002, starts its browser 7001 in a job of its
    // own before it is held, the browser starts 7002, and the launcher then exits.
    stand.change((current) => {
      Object.assign(current.processes.find((each) => each.pid === 5002) ?? {}, { parentPid: runner, startedAt: '13437009000009000', image: 'C:\\Firefox\\firefox.exe' })
      current.processes.push({ ...entry(7001, 5002, 'C:\\Firefox\\firefox.exe', '"C:\\Firefox\\firefox.exe" --profile C:\\Temp\\retest-firefox-4242-ZzZzZz\\profile'), startedAt: '13437009000009001' })
      current.byParent = [5001, 7001]
    })
    const second = new OwnedProcessGroup(5002, runner, jobSystem(supervisor, supervisor.adopt(5002), { markers: ['retest-firefox-4242-ZzZzZz'] }))
    stand.change((current) => { current.processes.push({ ...entry(7002, 7001), startedAt: '13437009000009002' }) })
    assert.deepEqual(second.capture(), [])
    stand.change((current) => { for (const each of current.processes) if (each.pid === 5002) each.running = false })
    assert.deepEqual(first.signal('SIGKILL'), [])
    assert.deepEqual(ended(stand), ['5001'])
    assert.deepEqual([runningIn(stand, 7001), runningIn(stand, 7002)], [true, true], "the second launch's browser and what it started run on")
  })

  test("P2: a launch's end leaves alone the host's own process, outside every launch, started under a pid this launch had on record", () => {
    const { stand, ownership } = held([entry(5000, runner), entry(5001, 5000), entry(5002, 5001)], { byParent: [5001] }, { markers: [marker] })
    assert.deepEqual(ownership.capture(), [])
    // 5002 ends; the host starts a shell given pid 5002, which starts a tool 7001 and exits.
    stand.change((current) => {
      Object.assign(current.processes.find((each) => each.pid === 5002) ?? {}, { parentPid: runner, startedAt: '13437009000009000', image: 'C:\\Windows\\System32\\cmd.exe', running: false })
      current.processes.push({ ...entry(7001, 5002, 'C:\\Tools\\host-tool.exe'), startedAt: '13437009000009001' })
    })
    assert.deepEqual(ownership.signal('SIGKILL'), [])
    assert.deepEqual(ended(stand), ['5001'])
    assert.equal(runningIn(stand, 7001), true)
  })

  test("P2b: a launch's reading does not count the host's process, started under a pid it had on record, as its own", async () => {
    const { stand, ownership } = held([entry(5000, runner), entry(5001, 5000), entry(5002, 5001)], { byParent: [5001] }, { markers: [marker] })
    assert.deepEqual(ownership.capture(), [])
    stand.change((current) => {
      for (const each of current.processes) if (each.pid === 5000 || each.pid === 5001) each.running = false
      Object.assign(current.processes.find((each) => each.pid === 5002) ?? {}, { parentPid: runner, startedAt: '13437009000009000', image: 'C:\\Windows\\System32\\cmd.exe', running: false })
      current.processes.push({ ...entry(7001, 5002, 'C:\\Tools\\host-tool.exe'), startedAt: '13437009000009001' })
    })
    assert.equal(await ownership.remainsAsync(), false, 'a closed Firefox reads as gone while a process of the host runs')
  })

  test("P3: a member that ends between its job's reading and the runner's stands behind nothing another launch's process starts under its pid", () => {
    const stand = world({ processes: [entry(runner, 1), entry(5000, runner), entry(5001, 5000), entry(6000, runner)], byParent: [5001] })
    const supervisor = new Supervisor({ ...stand.program, args: [race, ...stand.program.args] }, runner, word)
    supervisor.hold()
    const launch = supervisor.adopt(5000)
    const other = supervisor.adopt(6000)
    const ownership = new OwnedProcessGroup(5000, runner, jobSystem(supervisor, launch, { markers: [marker] }))
    assert.deepEqual(ownership.capture(), [])
    stand.change((current) => { Object.assign(current, { race: { verb: 'members', arg: 'job', value: launch.job, change: 'member-reused', launchJob: launch.job, otherJob: other.job } }) })
    ownership.remains()
    assert.deepEqual(ownership.signal('SIGKILL'), [])
    assert.deepEqual(ended(stand), ['5001'])
    assert.ok(stand.read().processes.some((each) => each.pid === 7001), 'the race ran')
    assert.equal(runningIn(stand, 7001), true, "another launch's process runs on")
  })

  test("P4: a launch's end does not end, in its next round, what another launch started under the pid of a process it just ended", () => {
    const stand = world({ processes: [entry(runner, 1), entry(5000, runner), entry(5001, 5000), entry(6000, runner)], byParent: [5001] })
    const supervisor = new Supervisor({ ...stand.program, args: [race, ...stand.program.args] }, runner, word)
    supervisor.hold()
    const launch = supervisor.adopt(5000)
    const other = supervisor.adopt(6000)
    const ownership = new OwnedProcessGroup(5000, runner, jobSystem(supervisor, launch, { markers: [marker] }))
    assert.deepEqual(ownership.capture(), [])
    // 5005, which the browser 5001 started, is on record; once the end ends it, its pid goes to another launch's process.
    stand.change((current) => { current.processes.push(entry(5005, 5001)) })
    assert.deepEqual(ownership.capture(), [])
    stand.change((current) => { Object.assign(current, { race: { verb: 'terminate', arg: 'pid', value: '5005', change: 'ended-reused', otherJob: other.job } }) })
    assert.deepEqual(ownership.signal('SIGKILL'), [])
    assert.deepEqual(ended(stand).sort(), ['5001', '5005'])
    assert.ok(stand.read().processes.some((each) => each.pid === 7001), 'the race ran')
    assert.equal(runningIn(stand, 7001), true, "another launch's process runs on")
  })

  test("a launch's readings and its end ask of its own job and the runner's, and of another launch's job once for each reading whose claim rests on a marker or a late browser", async () => {
    const stand = world({ processes: [entry(runner, 1), entry(5000, runner), entry(5001, 5000), entry(6000, runner)], byParent: [5001] })
    stand.change((current) => { Object.assign(current, { spawnLimit: 2, spawnMarker: marker }) })
    const supervisor = new Supervisor({ ...stand.program, args: [spawning, ...stand.program.args] }, runner, word)
    supervisor.hold()
    const launch = supervisor.adopt(5000)
    const other = supervisor.adopt(6000)
    const ownership = new OwnedProcessGroup(5000, runner, jobSystem(supervisor, launch, { markers: [marker] }))
    assert.deepEqual(ownership.capture(), [])
    const before = stand.read().calls.length
    assert.equal(await ownership.remainsAsync(), true)
    assert.deepEqual(ownership.signal('SIGKILL'), [])
    const calls = stand.read().calls.slice(before)
    const asked = calls.filter((call) => call.includes('--job')).map((call) => call[call.indexOf('--job') + 1])
    assert.deepEqual([...new Set(asked)].sort(), [launch.job, other.job, supervisor.runnerJob].sort())
    const firstEnd = calls.findIndex((call) => call[0] === 'terminate')
    assert.equal(calls.slice(0, firstEnd).some((call) => call.includes(other.job)), false, 'while every claim rests on the launch\'s own records, no other job is read')
    // The end's second round claims 8001 through the browser read late and by its marker, the third 8002 by its marker:
    // each reads the other launch's job once, as members, and ends nothing of it.
    assert.deepEqual(calls.filter((call) => call.includes(other.job)).map((call) => call[0]), ['members', 'members'])
    assert.equal(runningIn(stand, 6000), true)
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
  // `spawnLimit` children. Each child carries the launch's marker, as a browser's processes carry its profile folder,
  // since its parent has ended by the next reading. Three rounds end the browser and two children of it; a third child
  // is a fourth process.
  for (const [spawnLimit, left] of [[2, []], [3, [8003]]] as const) {
    test(`a launch's end reads the runner's job up to three times, so ${spawnLimit} marked processes started as their parents end ${left.length === 0 ? 'all end' : 'leave the last, which the launch still holds'}`, async () => {
      const stand = world({ processes: [entry(runner, 1), entry(5000, runner), entry(5001, 5000)], byParent: [5001] })
      stand.change((current) => { Object.assign(current, { spawnLimit, spawnMarker: marker }) })
      const program = { ...stand.program, args: [spawning, ...stand.program.args] }
      const supervisor = new Supervisor(program, runner, word)
      supervisor.hold()
      const ownership = new OwnedProcessGroup(5000, runner, jobSystem(supervisor, supervisor.adopt(5000), { markers: [marker] }))
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

  // The wrapper starts 8001 under the browser 5001 as the end ends it; 8001 carries nothing of the launch.
  for (const [lateParentMs, left] of [[undefined, []], [0, [8001]]] as const) {
    test(`a process the browser starts as the launch's end ends it, carrying nothing of the launch, ${left.length === 0 ? "is ended through the browser the end's reading a moment before found" : 'is left once that reading is no longer a moment ago, and named as running with nothing behind it'}`, async () => {
      const stand = world({ processes: [entry(runner, 1), entry(5000, runner), entry(5001, 5000)], byParent: [5001] })
      stand.change((current) => { Object.assign(current, { spawnLimit: 1 }) })
      const supervisor = new Supervisor({ ...stand.program, args: [spawning, ...stand.program.args] }, runner, word)
      supervisor.hold()
      const ownership = new OwnedProcessGroup(5000, runner, jobSystem(supervisor, supervisor.adopt(5000), { markers: [marker], ...(lateParentMs === undefined ? {} : { lateParentMs }) }))
      assert.deepEqual(ownership.capture(), [])
      assert.deepEqual(ownership.signal('SIGKILL'), [])
      assert.deepEqual(stand.read().processes.filter((each) => each.running && each.pid !== runner).map((each) => each.pid), left)
      assert.equal(await ownership.remainsAsync(), false, left.length === 0 ? 'nothing is left' : 'its parent had ended, so it is not the launch\'s')
      assert.deepEqual(ownership.readProblems, left.map((pid) => `Process ${pid} (${pid}.exe) is still running after the process that started it ended. Retest ends it when Retest exits.`))
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
    assert.deepEqual(owners.map((owner) => owner.readProblems), [['Process 6100 (6100.exe) is still running after the process that started it ended. Retest ends it when Retest exits.'], [], []])
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
  function twoRuns(): { stand: ReturnType<typeof world>; supervisor: Supervisor; first: Map<string, LaunchRecord>; second: Map<string, LaunchRecord>; owners: OwnedProcessGroup[] } {
    const stand = world({ processes: [entry(runner, 1), entry(5000, runner), entry(5001, 5000), entry(6000, runner), entry(6001, 6000), entry(6100, 6050)], byParent: [5001, 6001] })
    const supervisor = new Supervisor(stand.program, runner, word)
    supervisor.hold()
    const runs = [5000, 6000].map((pid) => {
      const launch = supervisor.adopt(pid)
      const system = jobSystem(supervisor, launch)
      return { run: new Map<string, LaunchRecord>([[launch.job, system]]), owner: new OwnedProcessGroup(pid, runner, system) }
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
    first.set(launch.job, system)
    const owner = new OwnedProcessGroup(7000, runner, system)
    assert.deepEqual(owner.capture(), [])
    launcherEnds(stand, 5000, 5001)
    stand.change((current) => { for (const each of current.processes) if (each.pid === 7000) each.running = false })
    assert.equal(await owner.remainsAsync(), false)
    assert.deepEqual(named(owner.readProblems), ['5001', '6100'], 'the launch read empty names every stray it is the first to see')
    assert.deepEqual(await runEndProblems(supervisor, first), [], "the run's end names neither again")
  })

  test("a run's end ties a stray to its run by the run's marker, not by a record of a process that has ended", async () => {
    // Run A's test file process 5000 was read once when held, and ended long ago. Run B's launch 6000 is going.
    const stand = world({ processes: [entry(runner, 1), entry(5000, runner), entry(6000, runner)] })
    const supervisor = new Supervisor(stand.program, runner, word)
    supervisor.hold()
    const launchA = supervisor.adopt(5000)
    const systemA = jobSystem(supervisor, launchA, { markers: ['retest-profile-4242-AaAaAa'] })
    assert.deepEqual(new OwnedProcessGroup(5000, runner, systemA).capture(), [])
    supervisor.adopt(6000)
    // P5: 5000's pid goes to a process run B's 6000 starts, which starts 7001 and exits: 7001 is a stray, run B's.
    // 7002 is a stray that carries run A's marker: a browser process of A's whose parent ended.
    stand.change((current) => {
      Object.assign(current.processes.find((each) => each.pid === 5000) ?? {}, { parentPid: 6000, startedAt: '13437009000009000', image: 'C:\\Apps\\b-shell.exe', running: false })
      current.processes.push({ ...entry(7001, 5000, 'C:\\Apps\\b-helper.exe'), startedAt: '13437009000009001' }, entry(7002, 6999, 'C:\\Chrome\\chrome.exe', '"chrome.exe" --type=renderer --user-data-dir=C:\\Temp\\retest-profile-4242-AaAaAa'))
      current.orphans = [7001, 7002]
    })
    assert.deepEqual(named(await runEndProblems(supervisor, new Map([[launchA.job, systemA]]))), ['7002'], "run A names its own marked process, and not run B's")
  })

  // A Firefox launch 5000 holds its browser 5001 by its parent; a Chromium launch 6000 runs beside it. The browser starts
  // content process 5009, which carries no profile, after the launches' last readings; then the launcher, the browser
  // and Chromium exit, and 5009 goes on a moment. Firefox's window for its browser's late reading is long here, so the
  // order of the readings, not the machine's speed, decides the case.
  for (const order of ['Firefox', 'Chromium'] as const) {
    test(`C1: a content process that outlives its browser is Firefox's to end and no other launch's to answer for, when ${order} reads first`, async () => {
      const firefoxMarker = 'retest-firefox-4242-AbCdEf'
      const chromeMarker = 'retest-profile-4242-GhIjKl'
      const stand = world({ processes: [entry(runner, 1), entry(5000, runner), entry(5001, 5000, 'C:\\Firefox\\firefox.exe', `firefox.exe --profile C:\\Temp\\${firefoxMarker}\\profile`), entry(6000, runner, 'C:\\Chrome\\chrome.exe', `chrome.exe --user-data-dir=C:\\Temp\\${chromeMarker}`)], byParent: [5001] })
      const supervisor = new Supervisor(stand.program, runner, word)
      supervisor.hold()
      const firefoxLaunch = supervisor.adopt(5000)
      const chromeLaunch = supervisor.adopt(6000)
      const firefoxSystem = jobSystem(supervisor, firefoxLaunch, { markers: [firefoxMarker], lateParentMs: 120_000 })
      const chromeSystem = jobSystem(supervisor, chromeLaunch, { markers: [chromeMarker] })
      const firefox = new OwnedProcessGroup(5000, runner, firefoxSystem)
      const chrome = new OwnedProcessGroup(6000, runner, chromeSystem)
      assert.deepEqual(firefox.capture(), [])
      assert.deepEqual(chrome.capture(), [])
      stand.change((current) => {
        current.processes.push(entry(5009, 5001, 'C:\\Firefox\\firefox.exe', 'firefox.exe -contentproc --channel=1 -isForBrowser 11 tab'))
        current.orphans = [5009]
        for (const each of current.processes) if (each.pid === 5000 || each.pid === 5001 || each.pid === 6000) each.running = false
      })
      const readings = order === 'Firefox' ? [firefox, chrome] : [chrome, firefox]
      for (const owner of readings) await owner.remainsAsync()
      assert.deepEqual(chrome.readProblems, [], "Chromium's launch answers for nothing of Firefox's")
      assert.equal(await firefox.remainsAsync(), true, "the content process is Firefox's, through the browser its reading before found")
      assert.deepEqual(firefox.signal('SIGKILL'), [])
      assert.equal(stand.read().processes.some((each) => each.pid === 5009 && each.running), false, "and Firefox's end ends it")
      assert.equal(await firefox.remainsAsync(), false)
      assert.deepEqual(firefox.readProblems, [])
      assert.deepEqual(await runEndProblems(supervisor, new Map([[firefoxLaunch.job, firefoxSystem], [chromeLaunch.job, chromeSystem]])), [])
    })
  }

  test('F1: a process named while a run end reads the runner job is not forgotten by that reading, and is not named again', async () => {
    const stand = world({ processes: [entry(runner, 1), entry(5000, runner), entry(7000, runner), entry(7100, runner), entry(7200, runner), entry(6100, 6050)], orphans: [6100] })
    const supervisor = new Supervisor(stand.program, runner, word)
    supervisor.hold()
    const launchA = supervisor.adopt(5000)
    const runA = new Map([[launchA.job, jobSystem(supervisor, launchA)]])
    const owners = [7000, 7100, 7200].map((pid) => new OwnedProcessGroup(pid, runner, jobSystem(supervisor, supervisor.adopt(pid))))
    for (const owner of owners) assert.deepEqual(owner.capture(), [])
    // 7000 ends and names 6100, so the run end has something to forget and reads the runner's job.
    stand.change((current) => { for (const each of current.processes) if (each.pid === 7000) each.running = false })
    assert.equal(await owners[0]?.remainsAsync(), false)
    // Run A's end reads the runner's job now; the reading reaches it 1.5 s later.
    stand.change((current) => { current.slowMembers = { job: supervisor.runnerJob, ms: 1500 } })
    const ending = runEndProblems(supervisor, runA)
    await delay(500)
    // Meanwhile 8100 is left running with nothing behind it, and launch 7100 ends and names it.
    stand.change((current) => {
      current.processes.push(entry(8100, 8050, 'C:\\Apps\\left.exe'))
      current.orphans?.push(8100)
      for (const each of current.processes) if (each.pid === 7100) each.running = false
    })
    assert.equal(await owners[1]?.remainsAsync(), false)
    assert.deepEqual(named(owners[1]?.readProblems ?? []), ['8100'])
    assert.equal(stand.read().slowMembers, undefined, 'the slow reading was taken before 8100 was named')
    assert.deepEqual(await ending, [])
    stand.change((current) => { for (const each of current.processes) if (each.pid === 7200) each.running = false })
    assert.equal(await owners[2]?.remainsAsync(), false)
    assert.deepEqual(owners[2]?.readProblems, [], '8100, still running, is named once in the host')
  })

  test("a run end whose forgetting cannot read the runner's job still names what the run's launches left", async () => {
    const stand = world({ processes: [entry(runner, 1), entry(5000, runner), entry(7000, runner), entry(6100, 6050)], orphans: [6100] })
    const supervisor = new Supervisor(stand.program, runner, word)
    supervisor.hold()
    const launchA = supervisor.adopt(5000)
    const systemA = jobSystem(supervisor, launchA)
    const other = new OwnedProcessGroup(7000, runner, jobSystem(supervisor, supervisor.adopt(7000)))
    assert.deepEqual(other.capture(), [])
    // 7000 ends and names 6100. Run A's launch 5000 ends and leaves its helper 5001 in its job.
    stand.change((current) => { for (const each of current.processes) if (each.pid === 7000) each.running = false })
    assert.equal(await other.remainsAsync(), false)
    stand.change((current) => {
      current.processes.push(entry(5001, 5000, 'C:\\Apps\\helper.exe'))
      current.jobs[launchA.job]?.members.push(5001)
      for (const each of current.processes) if (each.pid === 5000) each.running = false
      current.unlisted = supervisor.runnerJob
    })
    assert.deepEqual(await runEndProblems(supervisor, new Map([[launchA.job, systemA]])), ['Process 5001 (helper.exe) is still running at the end of the run. Retest ends it when Retest exits.'])
  })

  test("the stand-in's world lock left by a stand-in that was ended is taken over at once, and one a live holder keeps is never taken, the question giving up at its client's deadline", async () => {
    const stand = world({ processes: [entry(runner, 1), entry(5000, runner)] })
    const supervisor = new Supervisor(stand.program, runner, word)
    supervisor.hold()
    const lock = `${stand.program.args[1] ?? ''}.lock`
    const holding = (holder: number, ageMs: number): void => {
      mkdirSync(lock)
      writeFileSync(join(lock, 'holder'), `${holder}`)
      const then = new Date(Date.now() - ageMs)
      utimesSync(lock, then, then)
    }
    // A lock from a stand-in ended while it held it, a moment ago.
    holding(endedPid(), 0)
    const askedAt = performance.now()
    assert.equal((await supervisor.processAsync(5000)).process?.pid, 5000)
    assert.ok(performance.now() - askedAt < 3000, 'taken over at once')
    // A holder that is still running and has kept the lock ten seconds, as a stalled one would: the question waits until
    // its client gives up, takes nothing over, and changes nothing.
    const before = stand.read().calls.length
    holding(process.pid, 10_000)
    const asking = supervisor.terminateAsync(supervisor.runnerJob, 5000, started(5000)).then(() => 'answered', (error: unknown) => String(error))
    assert.match(await asking, /metadata process/, 'the question gets no answer')
    // On macOS and Linux the stand-in stops at its client's deadline by its own clock, so it may still try for the lock
    // a moment after the client gave up; there the lock is given back only once the stand-in notes it gave up. On Windows
    // the metadata worker ends a run it gives up on before it tells the client, so the stand-in is gone already. The
    // lock goes as a holder gives it back, renamed away whole: on Linux and macOS a waiter's rename of its own lock
    // replaces a lock folder emptied in place.
    if (!launchesHeldByJob) for (const waited = performance.now(); stand.abandoned() === 0; await delay(20)) assert.ok(performance.now() - waited < 10_000, 'the stand-in gave up')
    assert.equal(holderOf(lock), process.pid, 'the live holder still holds the lock')
    giveBackWorld(stand.program.args[1] ?? '')
    assert.equal(existsSync(lock), false)
    await delay(500)
    assert.equal(stand.read().calls.length, before, 'and the world was not changed')
    assert.equal(stand.read().processes.some((each) => each.pid === 5000 && each.running), true)
  })

  test("the stand-in's world lock left by a stand-in that was ended is taken over by one waiter, and its holders never overlap", async () => {
    const file = join(tempFolder('world-lock-'), 'world.json')
    writeFileSync(file, '{}')
    const lock = `${file}.lock`
    mkdirSync(lock)
    writeFileSync(join(lock, 'holder'), `${endedPid()}`)
    const log = `${file}.log`
    const module = new URL('./process-supervisor-world-lock.ts', import.meta.url).href
    // Each holder notes its entry and its exit, holding the lock 50 ms between them.
    const source = `import { appendFileSync } from 'node:fs'; import { withWorld } from ${JSON.stringify(module)}; withWorld(${JSON.stringify(file)}, () => { appendFileSync(${JSON.stringify(log)}, 'in ' + process.pid + '\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); appendFileSync(${JSON.stringify(log)}, 'out ' + process.pid + '\\n') })`
    const waiters = Array.from({ length: 6 }, () => promisify(execFile)(process.execPath, ['--conditions=retest-source', '--input-type=module', '-e', source]))
    await Promise.all(waiters)
    const lines = readFileSync(log, 'utf8').trim().split('\n')
    assert.equal(lines.length, 12)
    for (let index = 0; index < lines.length; index += 2) {
      const [entered, left] = [lines[index] ?? '', lines[index + 1] ?? '']
      assert.ok(entered.startsWith('in ') && left === `out ${entered.slice('in '.length)}`, `one holder at a time: ${lines.join(', ')}`)
    }
    assert.equal(existsSync(lock), false, 'the last holder gave the lock back')
  })

  test("P6: outside any run, a run's end names what launches' jobs hold and asks for no stray", async () => {
    const stand = world({ processes: [entry(runner, 1), entry(5000, runner), entry(6100, 6050)], orphans: [6100] })
    const supervisor = new Supervisor(stand.program, runner, word)
    supervisor.hold()
    supervisor.adopt(5000)
    assert.deepEqual(await runEndProblems(supervisor, undefined), [])
    assert.equal(stand.read().calls.some((call) => call[0] === 'strays'), false)
  })

  test("the host forgets a named process once it has ended, and keeps one still running", async () => {
    const { stand, supervisor, first } = twoRuns()
    launcherEnds(stand, 5000, 5001)
    assert.deepEqual(named(await runEndProblems(supervisor, first)), ['5001'])
    assert.equal(supervisor.namedCount, 1)
    assert.deepEqual(await runEndProblems(supervisor, first), [], 'still running, it is not named again')
    assert.equal(supervisor.namedCount, 1)
    stand.change((current) => { for (const each of current.processes) if (each.pid === 5001) each.running = false })
    assert.deepEqual(await runEndProblems(supervisor, first), [])
    assert.equal(supervisor.namedCount, 0, 'once it ended it is forgotten')
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
    const stand = world({ runner: process.pid, processes: [entry(process.pid, 1), entry(pid, process.pid)], jobs: { [job]: { members: [pid], handle: 8 } }, print: { adopt: `${JSON.stringify({ schemaVersion: 1, type: 'adopted', job, handle: 8, root: { pid, parentPid: process.pid, startedAt: started(pid), image: null, commandLine: null }, ended: false, late: [], byParent: [], unheld: [7001, 7002], complete: true })}\n` } })
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
      const helper = { pid: 7003, parentPid: pid, startedAt: started(7003), image: null, commandLine: null }
      const stand = world({ runner: process.pid, processes: [entry(process.pid, 1), entry(pid, process.pid)], jobs: { [job]: { members: [pid], handle: 8 } }, print: { adopt: `${JSON.stringify({ schemaVersion: 1, type: 'adopted', job, handle: 8, root: { pid, parentPid: process.pid, startedAt: started(pid), image: null, commandLine: null }, ended: false, late: [], byParent: byParent ? [helper] : [], unheld: [], complete })}\n` } })
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
