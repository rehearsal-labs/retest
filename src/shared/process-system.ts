import type { ChildProcess } from 'node:child_process'
import type { HeldLaunch, ProcessRecords, SupervisedProcess, SupervisorProgram } from './process-supervisor.ts'
import type { ProcessOwnershipSystem } from './process-ownership.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { locateSupervisor } from '../cli/install/supervisor-locate.ts'
import { errorMessage } from '../protocol/failures.ts'
import { listWords } from './list-words.ts'
import { OwnedProcessGroup } from './process-ownership.ts'
import { jobSystem, leftoversUnreadProblem, stillRunningProblem, Supervisor, tiedTo } from './process-supervisor.ts'

// The one place that chooses how a process Retest starts is held. On macOS and Linux each launch leads a process group
// of its own and is read from `ps` or /proc, exactly as before this module existed. On Windows the runner is put in a
// job before its first launch, and each launch in a job of its own, through retest-supervisor (`process-supervisor.ts`).

/** Whether launches are held in job objects, as on Windows, rather than in process groups of their own. */
export const launchesHeldByJob: boolean = process.platform === 'win32'

/**
 * Whether a console program Retest starts, such as an app's start command or a build tool, starts detached. On Unix
 * that makes it the leader of a process group of its own. On Windows a detached program has no console, so each console
 * program it runs in turn would open a console window of its own; the job holds it either way, so it starts attached.
 */
export const consolesDetached: boolean = !launchesHeldByJob

/**
 * How an app server is first asked to stop, before the grace its stop gives it runs out: SIGTERM to its process group on
 * macOS and Linux; on Windows Ctrl+C, sent to the console of its own the server was started on, which is how a person
 * stops a console program there. When the grace runs out the server is ended, on Windows by ending its job.
 */
export const serverStopSignal: NodeJS.Signals = launchesHeldByJob ? 'SIGINT' : 'SIGTERM'

/**
 * Makes the next launch one Retest can hold. On Windows the first call puts the runner in its job, so everything it
 * starts from then on is born there; it throws, with a sentence that says what to do, when that cannot be done. On
 * macOS and Linux it does nothing.
 */
export function prepareOwnedLaunch(): void {
  jobs?.prepare()
}

/**
 * The ownership of a child an owned launch has just started. On Windows the child, and anything it already started,
 * is put in a job of its own first.
 *
 * @example const ownership = holdLaunch(child); const problems = ownership.capture()
 */
export function holdLaunch(child: ChildProcess): OwnedProcessGroup {
  return jobs === undefined ? new OwnedProcessGroup(child.pid ?? 0) : jobs.hold(child)
}

/**
 * A fresh owner of a launch already held, for reading it again from the start, as a server is once its shell became the
 * command it ran.
 */
export function launchOwnership(pid: number): OwnedProcessGroup {
  return jobs === undefined ? new OwnedProcessGroup(pid) : jobs.ownership(pid)
}

/**
 * One process as Windows shows it now, or undefined when none runs under the pid, for a record a launch keeps of the
 * process that made it: its start is what tells it from a later process given the same pid. Holds the runner first,
 * as a launch would. Only where launches are held by job.
 *
 * @example readHeldProcess(process.pid)?.startedAt // '134370091272841129'
 */
export function readHeldProcess(pid: number): SupervisedProcess | undefined {
  if (jobs === undefined) throw new Error('Processes are read through retest-supervisor only on Windows.')
  jobs.prepare()
  const supervisor = jobs.supervisor
  if (supervisor === undefined) throw new Error('The runner was not held, so no process could be read.')
  return supervisor.process(pid).process
}

/**
 * Launches held in jobs, through one supervisor for this runner. The runner is held once; a hold that failed is tried
 * again at the next launch, under a new name, since a failed hold leaves nothing behind. A child that cannot be held is
 * ended through Node's own handle on it, which no other process can stand behind, and its ownership then fails every
 * reading with why, so its launch fails and says so.
 */
export class JobLaunches {
  readonly #locate: () => SupervisorProgram
  readonly #runner: number
  readonly #launches = new Map<number, { readonly launch: HeldLaunch; readonly system: ProcessOwnershipSystem }>()
  #supervisor: Supervisor | undefined
  #held = false

  constructor(locate: () => SupervisorProgram, runner: number = process.pid) {
    this.#locate = locate
    this.#runner = runner
  }

  /** The supervisor once the runner is held, for readings outside any launch. */
  get supervisor(): Supervisor | undefined {
    return this.#held ? this.#supervisor : undefined
  }

  prepare(): void {
    if (this.#held) return
    const supervisor = new Supervisor(this.#locate(), this.#runner)
    try {
      supervisor.hold()
    } catch (error) {
      throw new Error(`Retest could not hold the processes it starts in a Windows job, so it started none: ${errorMessage(error)}`, { cause: error })
    }
    this.#supervisor = supervisor
    this.#held = true
  }

  hold(child: ChildProcess): OwnedProcessGroup {
    const pid = child.pid ?? 0
    const supervisor = this.supervisor
    if (supervisor === undefined) return this.#refused(child, pid, 'the runner was not held before it started.')
    let launch: HeldLaunch
    try {
      launch = supervisor.adopt(pid)
    } catch (error) {
      return this.#refused(child, pid, errorMessage(error))
    }
    const problems = [
      ...(launch.unheld.length === 0 ? [] : [`Retest could not hold processes ${listWords(launch.unheld.map(String), 'and')}, which process ${pid} started before Retest held it. They end when Retest exits.`]),
      ...(launch.complete ? [] : [`Process ${pid} kept starting processes while Retest took hold of them. Any Retest missed end when Retest exits.`]),
    ]
    const readings = jobSystem(supervisor, launch)
    runLaunches.getStore()?.set(launch.job, readings.onRecord)
    const system = problems.length === 0 ? readings : firstReadingRefused(readings, problems.join(' '))
    const held = { launch, system }
    this.#launches.set(pid, held)
    child.once('exit', () => { if (this.#launches.get(pid) === held) this.#launches.delete(pid) })
    return new OwnedProcessGroup(pid, this.#runner, system)
  }

  #refused(child: ChildProcess, pid: number, reason: string): OwnedProcessGroup {
    child.kill('SIGKILL')
    return new OwnedProcessGroup(pid, this.#runner, refusing(`Process ${pid} could not be held in a job of its own, so it was ended: ${reason}`))
  }

  ownership(pid: number): OwnedProcessGroup {
    return new OwnedProcessGroup(pid, this.#runner, this.#launches.get(pid)?.system ?? refusing(`Process ${pid} is not a launch Retest holds.`))
  }

  /** How a running launch was held: its job, and what it had started before it was. */
  launchOf(pid: number): HeldLaunch | undefined {
    return this.#launches.get(pid)?.launch
  }

  /** Gives back the runner's handle to a launch's job once it holds nothing; one that still holds something is kept. */
  async releaseEmpty(launch: HeldLaunch): Promise<void> {
    const supervisor = this.supervisor
    if (supervisor === undefined) return
    try {
      if ((await supervisor.membersAsync(launch.job)).length === 0) await supervisor.releaseAsync(launch.job, launch.handle)
    } catch {
      // A job whose handle stays open goes with the runner, and the run's end reads what it still holds.
    }
  }
}

/** The launches of this runner held in jobs, where launches are, for diagnostics and the Windows process tests. */
export function heldLaunches(): JobLaunches | undefined {
  return jobs
}

/**
 * Holds a child Retest started for its own work, such as a test file's process, as a launch of its own where launches
 * are held by job, so everything it starts is held with it, and says what kept that from being done. On macOS and
 * Linux, where such a child runs in Retest's own process group, it does nothing.
 *
 * @example const problems = holdOwnChild(fork(entry)) // [] once the child is held
 */
export function holdOwnChild(child: ChildProcess): string[] {
  if (jobs === undefined || child.pid === undefined) return []
  const problems = jobs.hold(child).capture()
  const launch = jobs.launchOf(child.pid)
  // A job its process left empty is given back; one still holding what that process started is kept, and named at
  // the run's end.
  if (launch !== undefined) child.once('exit', () => { void jobs.releaseEmpty(launch) })
  return problems
}

/**
 * At a run's end, once its browsers, servers and test processes are gone, each process still running that the run
 * started: one in the job of one of its launches whose own process has ended, as a helper a test file left running is,
 * and one in the runner's job that no launch's job holds and nothing running stands behind, which the run can tie to
 * itself through what its launches have on record. A console host is the console's programs' own and is never named. A
 * launch's job that is gone, or could not be read, is no reason to fail: what it still holds is in the runner's job, and
 * read there instead. Each is a sentence that leaves the run's cleanup unconfirmed, given once for each process in the
 * host, whichever launch or run names it first. Empty on macOS and Linux, where process groups hold what Retest starts,
 * and before the runner was first held.
 *
 * @example for (const problem of await runnerStrayProblems()) events.reportFailure(failure('cleanup_failed', problem))
 */
export async function runnerStrayProblems(): Promise<string[]> {
  const supervisor = jobs?.supervisor
  return supervisor === undefined ? [] : runEndProblems(supervisor, runLaunches.getStore())
}

/**
 * What a run's end names, read through `supervisor`, for the run whose launches are `run`, each by its job with what it
 * has on record; outside any run, what every launch's job still holds, and no stray, since none can be tied to a run.
 * `runnerStrayProblems` asks it for the run it is called in. Run ends read one at a time, in the order they ask, so two
 * runs ending together never question the supervisor at once, and each names what the one before it did not.
 */
export function runEndProblems(supervisor: Supervisor, run: RunLaunches | undefined): Promise<string[]> {
  const ending = runEnds.then(() => readRunEnd(supervisor, run))
  runEnds = ending.catch(() => undefined)
  return ending
}

// The run end being read, which the next one waits for.
let runEnds: Promise<unknown> = Promise.resolve()

async function readRunEnd(supervisor: Supervisor, run: RunLaunches | undefined): Promise<string[]> {
  const when = 'at the end of the run'
  try {
    const leftovers = await supervisor.leftoversAsync(undefined, run === undefined ? undefined : new Set(run.keys()))
    const records = [...(run?.values() ?? [])].map((onRecord) => onRecord()).filter((record) => record.size > 0)
    const strays = records.length === 0 ? [] : tiedTo(records, await supervisor.straysAsync(undefined, leftovers.unread))
    return supervisor.firstNamed([...leftovers.found.map((leftover) => leftover.process), ...strays]).map((entry) => stillRunningProblem(entry, when))
  } catch (error) {
    return [leftoversUnreadProblem(error, when)]
  }
}

/** The launches one run held, each by its job, with what that launch has on record. */
export type RunLaunches = ReadonlyMap<string, () => ProcessRecords>

// The launches each run held, by the run's own context.
const runLaunches = new AsyncLocalStorage<Map<string, () => ProcessRecords>>()

/**
 * Runs `work` as one run: on Windows the launches it holds are its own, and its end reads only those. A process left in
 * a launch's job is that launch's run's. A stray, in no launch's job, is a run's only when the run can tie it to itself
 * through its launches' records: the processes they read by pid and start, and what one of those started, its parent
 * still running or ended since the launch last read it. A stray no run can tie is named by no run's end, and the
 * runner's job ends it when the host exits; each process is named once in the host, by a launch or a run, whichever
 * reads it first. So a host that holds several runs at once never names one run's processes at another's end, however
 * their ends fall. Elsewhere it only runs `work`.
 *
 * @example const result = await asOneRun(() => new RunSession(options).run())
 */
export async function asOneRun<T>(work: () => Promise<T>): Promise<T> {
  if (jobs === undefined) return work()
  return runLaunches.run(new Map(), work)
}

const jobs: JobLaunches | undefined = launchesHeldByJob ? new JobLaunches(() => locateSupervisor(process.env)) : undefined

// Readings that all fail with one reason, for a launch whose ownership was never established.
function refusing(problem: string): ProcessOwnershipSystem {
  const refuse = (): never => { throw new Error(problem) }
  return { read: refuse, readAsync: async () => refuse(), readProcess: refuse, readProcessAsync: async () => refuse(), signal: refuse }
}

// The launch's first reading fails with `problem`, which its owner then keeps, and every later one reads the job.
function firstReadingRefused(system: ProcessOwnershipSystem, problem: string): ProcessOwnershipSystem {
  let told = false
  const tell = (): void => {
    if (told) return
    told = true
    throw new Error(problem)
  }
  return {
    ...system,
    read: (deadline) => { tell(); return system.read(deadline) },
    readAsync: async (deadline) => { tell(); return system.readAsync === undefined ? system.read(deadline) : system.readAsync(deadline) },
  }
}
