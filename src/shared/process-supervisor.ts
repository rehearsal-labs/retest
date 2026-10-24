import type { MetadataProcessOptions } from './metadata-process.ts'
import type { OwnedJob, OwnedProcessIdentity, ProcessOwnershipSystem } from './process-ownership.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { Schema } from '../protocol/schema.ts'
import { randomBytes } from 'node:crypto'
import { win32 } from 'node:path'
import { errorMessage } from '../protocol/failures.ts'
import { parse, s } from '../protocol/schema.ts'
import { readMetadataProcess, readMetadataProcessAsync } from './metadata-process.ts'

// How Retest holds what it starts on Windows. `retest-supervisor` (the Rust crate in `supervisor/`) is the only code
// that touches Win32: each question is one run of it, through the same bounded metadata reader `ps` goes through on
// Unix, so a reading can hold the thread when an exit hook needs it to, or wait without holding it. The runner is put
// in a job once, before the first launch, so everything it starts from then on is born in that job; each launch is then
// put in a job of its own, which is the witness of what the launch left: its own process list. Every job ends what it
// holds once its last handle closes, and that handle lives in the runner itself, so when the runner ends, however it
// ends, Windows ends everything it started. No supervisor process stays alive to make that true.

/** How to run the supervisor: its executable, the arguments before each command, and its whole environment. */
export type SupervisorProgram = {
  readonly command: string
  readonly args: readonly string[]
  readonly environment: Readonly<Record<string, string>>
}

/**
 * One process as the supervisor read it, every field from one handle on it. `startedAt` is the 100 ns ticks since 1601
 * Windows keeps, as digits; `commandLine` what it was started with.
 */
export type SupervisedProcess = {
  readonly pid: number
  readonly parentPid: number | undefined
  readonly startedAt: string
  readonly image: string | undefined
  readonly commandLine: string | undefined
}

/** The runner's own job: its name, and the value of the runner's handle that keeps it. */
export type HeldRunner = { readonly job: string; readonly handle: number }

/**
 * A launch held in a job of its own: the job, the runner's handle to it, the launched process, whether it had already
 * ended, so only what it started is in the job, the processes it had already started before it was held, which the
 * supervisor held then, those it found already in a job of their own inside the runner's, which the process that
 * started them holds, any it could not hold, and whether the search for them finished.
 */
export type HeldLaunch = {
  readonly job: string
  readonly handle: number
  readonly root: SupervisedProcess
  readonly ended: boolean
  readonly late: readonly SupervisedProcess[]
  readonly byParent: readonly SupervisedProcess[]
  readonly unheld: readonly number[]
  readonly complete: boolean
}

/** The console Ctrl+C went to, by the job's process it was reached through, and every process on that console. */
export type Interrupted = { readonly console: number; readonly reached: readonly number[] }

/** What `terminate` found under the pid: the recorded process, ended; nothing; or another process. */
export type TerminateOutcome = 'terminated' | 'absent' | 'different'

// How many times a job an adoption was not answered for is asked to end, and how long apart.
const endAttempts = 3
const endPauseMs = 100
const pause = new Int32Array(new SharedArrayBuffer(4))

/** One process in a reply, as the supervisor prints it. */
type Identity = { pid: number; parentPid: number | null; startedAt: string; image: string | null; commandLine: string | null }

/** The one line the supervisor prints for each command, a refusal included. */
export type SupervisorReply =
  | { schemaVersion: 1; type: 'held'; job: string; runner: number; handle: number }
  | { schemaVersion: 1; type: 'adopted'; job: string; handle: number; root: Identity; ended: boolean; late: Identity[]; byParent: Identity[]; unheld: number[]; complete: boolean }
  | { schemaVersion: 1; type: 'members'; job: string; processes: Identity[] }
  | { schemaVersion: 1; type: 'process'; process: Identity | null; inJob: boolean | null }
  | { schemaVersion: 1; type: 'ended'; job: string }
  | { schemaVersion: 1; type: 'terminated'; pid: number; outcome: TerminateOutcome }
  | { schemaVersion: 1; type: 'released'; job: string }
  | { schemaVersion: 1; type: 'strays'; job: string; processes: Identity[] }
  | { schemaVersion: 1; type: 'interrupted'; job: string; console: number; reached: number[] }
  | { schemaVersion: 1; type: 'refused'; problem: string; detail: string | null }

const identity: Schema<Identity> = s.object({ pid: s.number({ integer: true, min: 1 }), parentPid: s.nullable(s.number({ integer: true, min: 0 })), startedAt: s.string(), image: s.nullable(s.string()), commandLine: s.nullable(s.string()) })
const reply: Schema<SupervisorReply> = s.discriminatedUnion('type', [
  s.object({ schemaVersion: s.literal(1), type: s.literal('held'), job: s.string(), runner: s.number({ integer: true, min: 1 }), handle: s.number({ integer: true, min: 4 }) }),
  s.object({ schemaVersion: s.literal(1), type: s.literal('adopted'), job: s.string(), handle: s.number({ integer: true, min: 4 }), root: identity, ended: s.boolean(), late: s.array(identity), byParent: s.array(identity), unheld: s.array(s.number({ integer: true, min: 1 })), complete: s.boolean() }),
  s.object({ schemaVersion: s.literal(1), type: s.literal('members'), job: s.string(), processes: s.array(identity) }),
  s.object({ schemaVersion: s.literal(1), type: s.literal('process'), process: s.nullable(identity), inJob: s.nullable(s.boolean()) }),
  s.object({ schemaVersion: s.literal(1), type: s.literal('ended'), job: s.string() }),
  s.object({ schemaVersion: s.literal(1), type: s.literal('terminated'), pid: s.number({ integer: true, min: 1 }), outcome: s.enum(['terminated', 'absent', 'different']) }),
  s.object({ schemaVersion: s.literal(1), type: s.literal('released'), job: s.string() }),
  s.object({ schemaVersion: s.literal(1), type: s.literal('strays'), job: s.string(), processes: s.array(identity) }),
  s.object({ schemaVersion: s.literal(1), type: s.literal('interrupted'), job: s.string(), console: s.number({ integer: true, min: 1 }), reached: s.array(s.number({ integer: true, min: 1 })) }),
  s.object({ schemaVersion: s.literal(1), type: s.literal('refused'), problem: s.string(), detail: s.nullable(s.string()) }),
])
type Reply = SupervisorReply

/**
 * The supervisor's answers for one runner, the process that asks. Every job it makes is named after the runner and a
 * random word chosen here, so the names are new and nobody else's; a name already taken is refused by the supervisor.
 * A launch's job also carries the launch's pid and a count, so a later launch given the same pid gets a name of its
 * own. Each method runs the supervisor once; a refusal throws with the supervisor's own sentence, and the Windows call
 * behind it, when one failed, as the error's cause.
 *
 * @example const supervisor = new Supervisor(program); supervisor.hold(); const launch = supervisor.adopt(child.pid)
 */
export class Supervisor {
  readonly program: SupervisorProgram
  readonly runner: number
  readonly #prefix: string
  // The launches whose jobs' handles the runner keeps, by job, read beside the runner's own job by `strays`, each with
  // what it held by its parent when it was held and its markers.
  readonly #launches = new Map<string, { readonly root: SupervisedProcess; readonly byParent: readonly SupervisedProcess[]; readonly markers: readonly string[] }>()
  // Processes already named as left running, by pid and start, so each is named once, for the launch it was first
  // seen after.
  readonly #named = new Set<string>()
  #count = 0

  constructor(program: SupervisorProgram, runner: number = process.pid, word: string = randomBytes(8).toString('hex')) {
    if (!/^[0-9a-f]{8,32}$/.test(word)) throw new RangeError('A job word is 8 to 32 lowercase hexadecimal digits.')
    this.program = program
    this.runner = runner
    this.#prefix = `Local\\retest-${runner}-${word}`
  }

  /** The name of the runner's own job. */
  get runnerJob(): string {
    return this.#prefix
  }

  /** The name the next launch with this pid is held under. */
  launchJob(pid: number): string {
    return `${this.#prefix}-${pid}-${this.#count + 1}`
  }

  /** The jobs of launches the runner holds a handle to, oldest first. */
  get launchJobs(): readonly string[] {
    return [...this.#launches.keys()]
  }

  /**
   * The launches the runner holds a handle to, each by its job, the process it was made for, what that held by its
   * parent when it was held, and the markers it was held with.
   */
  get launches(): readonly { readonly job: string; readonly root: SupervisedProcess; readonly byParent: readonly SupervisedProcess[]; readonly markers: readonly string[] }[] {
    return [...this.#launches].map(([job, held]) => ({ job, ...held }))
  }

  /** The processes named so far, by pid and start, as they stand now: what a later `forgetEnded` may forget. */
  get named(): ReadonlySet<string> {
    return new Set(this.#named)
  }

  /**
   * Forgets those of `named`, taken before `runnerJob` was read, that this reading of the runner's job no longer holds:
   * each has ended, and a process given its pid later is another one. A process named after `named` was taken is kept,
   * whatever the reading says, since the reading may be older than its naming.
   */
  forgetEnded(named: ReadonlySet<string>, runnerJob: readonly SupervisedProcess[]): void {
    const running = new Set(runnerJob.flatMap((entry) => [`${entry.pid}:${entry.startedAt}`, `${entry.pid}:?`]))
    for (const key of named) if (!running.has(key)) this.#named.delete(key)
  }

  /** How many processes are named now, which `forgetEnded` keeps to those still running. */
  get namedCount(): number {
    return this.#named.size
  }

  /**
   * Of these processes, those not named before, each counted as named from now on. One no handle could read, whose
   * start is 0, is named by its pid alone, and a later reading of the same pid is that process, named already.
   */
  firstNamed(processes: readonly SupervisedProcess[]): readonly SupervisedProcess[] {
    return processes.filter((entry) => {
      const unread = `${entry.pid}:?`
      const key = entry.startedAt === '0' ? unread : `${entry.pid}:${entry.startedAt}`
      if (this.#named.has(key)) return false
      if (this.#named.has(unread)) {
        this.#named.delete(unread)
        this.#named.add(key)
        return false
      }
      this.#named.add(key)
      return true
    })
  }

  /** Puts the runner in its own job, which ends everything in it once the runner ends. */
  hold(deadline?: Deadline): HeldRunner {
    const answer = this.#ask(['hold', '--runner', `${this.runner}`, '--job', this.#prefix], deadline)
    if (answer.type !== 'held') throw unexpected(answer, 'held')
    return { job: answer.job, handle: answer.handle }
  }

  /**
   * Puts a child the runner just started in a job of its own, with whatever it already started. When no answer says it
   * was held, whatever the job came to hold is ended: a reply lost after the job was made leaves only an empty job,
   * whose handle goes with the runner.
   */
  adopt(pid: number, deadline?: Deadline, markers: readonly string[] = []): HeldLaunch {
    const job = this.launchJob(pid)
    this.#count += 1
    let reply: string
    try {
      reply = readMetadataProcess(this.#query(['adopt', '--runner', `${this.runner}`, '--within', this.#prefix, '--job', job, '--pid', `${pid}`], deadline))
    } catch (error) {
      // No answer came. The metadata worker ends a run it gives up on before it says so, so a job that run made is
      // there by now; one it made just as it was ended may take a moment to be seen.
      this.#endWhenSeen(job, endAttempts)
      throw error
    }
    let answer: Reply
    try {
      answer = readReply(reply)
      if (answer.type !== 'adopted') throw unexpected(answer, 'adopted')
    } catch (error) {
      // The run answered and ended, so whatever job it made is there now, or there is none.
      this.#endWhenSeen(job, 1)
      throw error
    }
    const root = supervised(answer.root)
    const byParent = answer.byParent.map(supervised)
    this.#launches.set(answer.job, { root, byParent, markers })
    return { job: answer.job, handle: answer.handle, root, ended: answer.ended, late: answer.late.map(supervised), byParent, unheld: answer.unheld, complete: answer.complete }
  }

  // Ends whatever a job no adoption holds came to hold, asking again while no such job is seen, up to `attempts`. An
  // adoption refused before it made its job leaves none, and the last asking finds none.
  #endWhenSeen(job: string, attempts: number): void {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        this.end(job)
        return
      } catch {
        if (attempt < attempts) Atomics.wait(pause, 0, 0, endPauseMs)
      }
    }
  }

  /** The processes a job holds now. */
  members(job: string, deadline?: Deadline): readonly SupervisedProcess[] {
    return membersOf(this.#ask(['members', '--job', job], deadline))
  }

  async membersAsync(job: string, deadline?: Deadline): Promise<readonly SupervisedProcess[]> {
    return membersOf(await this.#askAsync(['members', '--job', job], deadline))
  }

  /** One process as it is now, or undefined when no process runs under the pid, and whether the job, if named, holds it. */
  process(pid: number, job?: string, deadline?: Deadline): { readonly process: SupervisedProcess | undefined; readonly inJob: boolean } {
    return heldProcess(this.#ask(['process', '--pid', `${pid}`, ...(job === undefined ? [] : ['--job', job])], deadline))
  }

  async processAsync(pid: number, job?: string, deadline?: Deadline): Promise<{ readonly process: SupervisedProcess | undefined; readonly inJob: boolean }> {
    return heldProcess(await this.#askAsync(['process', '--pid', `${pid}`, ...(job === undefined ? [] : ['--job', job])], deadline))
  }

  /** Ends every process a launch's job holds. The supervisor refuses a job that holds the runner. */
  end(job: string, deadline?: Deadline): void {
    const answer = this.#ask(['end', '--runner', `${this.runner}`, '--job', job], deadline)
    if (answer.type !== 'ended') throw unexpected(answer, 'ended')
  }

  async endAsync(job: string, deadline?: Deadline): Promise<void> {
    const answer = await this.#askAsync(['end', '--runner', `${this.runner}`, '--job', job], deadline)
    if (answer.type !== 'ended') throw unexpected(answer, 'ended')
  }

  /** Ends one process of a job only while it is the process that started at `startedAt`. */
  terminate(job: string, pid: number, startedAt: string, deadline?: Deadline): TerminateOutcome {
    return terminated(this.#ask(['terminate', '--runner', `${this.runner}`, '--job', job, '--pid', `${pid}`, '--started', startedAt], deadline))
  }

  async terminateAsync(job: string, pid: number, startedAt: string, deadline?: Deadline): Promise<TerminateOutcome> {
    return terminated(await this.#askAsync(['terminate', '--runner', `${this.runner}`, '--job', job, '--pid', `${pid}`, '--started', startedAt], deadline))
  }

  /**
   * The pids every launch but `job`'s holds now, in its job or, as it was held, by its parent, for a claim that rests on
   * a marker or on a browser read one reading late, which must never take another launch's process; undefined when a
   * job still held could not be read.
   */
  otherLaunchMembers(job: string, deadline?: Deadline): ReadonlySet<number> | undefined {
    const pids = new Set<number>()
    for (const [other, held] of [...this.#launches]) {
      if (other === job) continue
      for (const entry of held.byParent) pids.add(entry.pid)
      try {
        for (const entry of this.members(other, deadline)) pids.add(entry.pid)
      } catch {
        if (this.#launches.has(other)) return undefined
      }
    }
    return pids
  }

  // One job at a time, as the synchronous form reads them.
  async otherLaunchMembersAsync(job: string, deadline?: Deadline): Promise<ReadonlySet<number> | undefined> {
    const pids = new Set<number>()
    for (const [other, held] of [...this.#launches]) {
      if (other === job) continue
      for (const entry of held.byParent) pids.add(entry.pid)
      try {
        for (const entry of await this.membersAsync(other, deadline)) pids.add(entry.pid)
      } catch {
        if (this.#launches.has(other)) return undefined
      }
    }
    return pids
  }

  /** Closes the runner's handle to a job that holds nothing any more, which frees the job. */
  release(job: string, handle: number, deadline?: Deadline): void {
    const answer = this.#ask(['release', '--runner', `${this.runner}`, '--job', job, '--handle', `${handle}`], deadline)
    if (answer.type !== 'released') throw unexpected(answer, 'released')
    this.#launches.delete(job)
  }

  async releaseAsync(job: string, handle: number, deadline?: Deadline): Promise<void> {
    const answer = await this.#askAsync(['release', '--runner', `${this.runner}`, '--job', job, '--handle', `${handle}`], deadline)
    if (answer.type !== 'released') throw unexpected(answer, 'released')
    this.#launches.delete(job)
  }

  /**
   * At the end of a run, each process still running in a job of a launch whose own process has ended, as a helper a test
   * file left running is, with the launch's pid, leaving out console hosts; and each such launch's job that could not be
   * read. A job given back meanwhile holds nothing, and one whose answer was lost may be gone too, its processes ended
   * with its last handle; leaving the unread ones out of `straysAsync` names whatever they still hold there instead.
   * `only`, when given, names the launches' jobs to read, such as one run's own among several a host holds at once.
   */
  async leftoversAsync(deadline?: Deadline, only?: ReadonlySet<string>): Promise<{ readonly found: readonly { readonly root: number; readonly process: SupervisedProcess }[]; readonly unread: readonly string[] }> {
    const found: { readonly root: number; readonly process: SupervisedProcess }[] = []
    const unread: string[] = []
    for (const [job, { root }] of [...this.#launches]) {
      if (only !== undefined && !only.has(job)) continue
      if ((await this.processAsync(root.pid, undefined, deadline)).process?.startedAt === root.startedAt) continue
      let members: readonly SupervisedProcess[]
      try {
        members = await this.membersAsync(job, deadline)
      } catch {
        if (this.#launches.has(job)) unread.push(job)
        continue
      }
      for (const process of members) if (!consoleHost(process)) found.push({ root: root.pid, process })
    }
    return { found, unread }
  }

  /**
   * What the runner's job holds that no launch's job does and that nothing still running stands behind: a process left
   * by one that had ended before its launch was held, which no launch's job took, and which runs until the runner ends.
   * Console hosts are left out. `leaveOut` names launches' jobs to read as no launch's, so what they hold is named.
   */
  strays(deadline?: Deadline): readonly SupervisedProcess[] {
    return straysOf(this.#ask(this.#straysArguments([]), deadline))
  }

  async straysAsync(deadline?: Deadline, leaveOut: readonly string[] = []): Promise<readonly SupervisedProcess[]> {
    return straysOf(await this.#askAsync(this.#straysArguments(leaveOut), deadline))
  }

  #straysArguments(leaveOut: readonly string[]): string[] {
    const launches = [...this.#launches.keys()].filter((job) => !leaveOut.includes(job)).join(',')
    // A command line on Windows holds 32767 characters; thousands of launches held at once would not fit.
    if (launches.length > 30_000) throw new Error(`Retest holds ${this.#launches.size} launches at once, too many to name to retest-supervisor in one question.`)
    return ['strays', '--runner', `${this.runner}`, '--job', this.#prefix, ...(launches === '' ? [] : ['--launches', launches])]
  }

  /**
   * Sends Ctrl+C to the console of a launch's processes, or of `pid` among them, unless Retest itself is on that console;
   * Ctrl+Break with `key: 'break'`, which a console program cannot be set to ignore.
   */
  interrupt(job: string, options: { readonly pid?: number; readonly key?: 'c' | 'break'; readonly deadline?: Deadline } = {}): Interrupted {
    const answer = this.#ask(['interrupt', '--runner', `${this.runner}`, '--job', job, ...(options.pid === undefined ? [] : ['--pid', `${options.pid}`]), ...(options.key === undefined ? [] : ['--key', options.key])], options.deadline)
    if (answer.type !== 'interrupted') throw unexpected(answer, 'interrupted')
    return { console: answer.console, reached: answer.reached }
  }

  #query(args: readonly string[], deadline: Deadline | undefined): MetadataProcessOptions {
    return { command: this.program.command, args: [...this.program.args, ...args], environment: this.program.environment, deadline }
  }

  #ask(args: readonly string[], deadline: Deadline | undefined): Reply {
    return readReply(readMetadataProcess(this.#query(args, deadline)))
  }

  async #askAsync(args: readonly string[], deadline: Deadline | undefined): Promise<Reply> {
    // Neither the metadata worker nor its wait keeps Node alive; a host with nothing else to do must still hear the answer.
    const holding = setInterval(() => undefined, 1000)
    try {
      return readReply(await readMetadataProcessAsync(this.#query(args, deadline)))
    } finally {
      clearInterval(holding)
    }
  }
}

/**
 * The supervisor's one line of output as a checked reply. Anything else, a second line included, is no answer.
 *
 * @example readReply('{"schemaVersion":1,"type":"ended","job":"Local\\\\retest-1-ab-2"}\n').type // 'ended'
 */
export function readReply(text: string): Reply {
  const line = text.endsWith('\n') ? text.slice(0, -1) : text
  if (line.includes('\n') || line.trim() === '') throw new Error('retest-supervisor did not answer with one line.')
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error('retest-supervisor answered with something that is not JSON.')
  }
  const parsed = parse(reply, value)
  if (!parsed.ok) throw new Error(`retest-supervisor answered in a form this Retest cannot read: ${parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}.`)
  return parsed.value
}

// A refusal throws the supervisor's own sentence, with the Windows call behind it as the cause; any other answer to the
// wrong question is no answer.
function unexpected(answer: Reply, wanted: Reply['type']): Error {
  if (answer.type !== 'refused') return new Error(`retest-supervisor answered ${answer.type} where ${wanted} was asked for.`)
  return answer.detail === null ? new Error(answer.problem) : new Error(answer.problem, { cause: new Error(answer.detail) })
}

function straysOf(answer: Reply): readonly SupervisedProcess[] {
  if (answer.type !== 'strays') throw unexpected(answer, 'strays')
  return answer.processes.map(supervised).filter((entry) => !consoleHost(entry))
}

/**
 * Whether a process is the console host Windows starts beside a console program given a console of its own, as each test
 * file's process, app server and media process is. It belongs to the programs on that console, runs nothing anyone gave
 * it and ends a moment after the last of them, so it is never named as left running: a program still on its console is
 * named itself.
 *
 * @example consoleHost({ pid: 7300, parentPid: 7200, startedAt: '1', image: 'C:\\Windows\\System32\\conhost.exe' }) // true
 */
export function consoleHost(process: SupervisedProcess): boolean {
  return process.image?.toLowerCase().endsWith('\\system32\\conhost.exe') === true
}

function terminated(answer: Reply): TerminateOutcome {
  if (answer.type !== 'terminated') throw unexpected(answer, 'terminated')
  return answer.outcome
}

function membersOf(answer: Reply): readonly SupervisedProcess[] {
  if (answer.type !== 'members') throw unexpected(answer, 'members')
  return answer.processes.map(supervised)
}

function supervised(entry: Identity): SupervisedProcess {
  if (!/^\d{1,20}$/.test(entry.startedAt)) throw new Error('retest-supervisor gave a process start that is not a count of ticks.')
  return { pid: entry.pid, parentPid: entry.parentPid ?? undefined, startedAt: entry.startedAt, image: entry.image ?? undefined, commandLine: entry.commandLine ?? undefined }
}

function heldProcess(answer: Reply): { readonly process: SupervisedProcess | undefined; readonly inJob: boolean } {
  if (answer.type !== 'process') throw unexpected(answer, 'process')
  return { process: answer.process === null ? undefined : supervised(answer.process), inJob: answer.inJob === true }
}

// How many times a launch's end reads the runner's job for what the processes its parent holds started meanwhile.
const parentedEndRounds = 3
// How soon after the reading before it a reading of the runner's job may count what a browser gone since started. A close
// reads as it asks the browser to close, waits up to a second for each answer and exit, then reads every 100 ms, each
// reading two runs of retest-supervisor, which take a second each on a busy runner; an end's rounds come a run apart.
// The bound keeps short the time in which the browser's pid could have gone to a process that started another and ended.
const lateParentMs = 10_000

/** Processes by pid and start, as a launch keeps what it has read as its own. */
export type ProcessRecords = ReadonlyMap<number, string>

// The processes of one reading of the runner's job that a launch holds without their being in its job, by one of these
// facts and no other. A process on record by its pid and start is the launch's: a pid and a start name one process. So
// is a process whose parent runs in this same reading with the start the launch has for it, as one of its job's members
// or one it holds, and started no earlier than that parent: Windows names a running process's parent truly. And so is a
// process whose command line names one of the launch's markers as a folder of its own, the folder only this launch uses,
// which its browser carries whatever started it. A parent that has ended is no evidence: Windows keeps the pid it had,
// and a later process given that pid passes it on to what it starts. So nothing is counted through one, with one bounded
// exception: `late` names the launch's browsers, held by their parent, that ran in a reading taken a moment before this
// one; one that is gone now, its pid held by nothing else in the runner's job, still stands behind what it started, for
// this one reading, as a browser's content processes outlive it a moment. A process `elsewhere` names, another
// launch's, is never this one's and stands behind nothing of it. A claim that rests on a marker or a late browser is
// `weak`, for the caller to read the other launches' jobs. The records the reading leaves are what it found.
function readParented(options: { readonly records: ProcessRecords; readonly members?: readonly SupervisedProcess[]; readonly reading: readonly SupervisedProcess[]; readonly markers?: readonly string[]; readonly late?: ReadonlySet<number>; readonly elsewhere?: ReadonlySet<number> }): { readonly claimed: readonly SupervisedProcess[]; readonly records: ProcessRecords; readonly weak: boolean } {
  const { records, reading } = options
  const markers = options.markers ?? []
  const elsewhere = options.elsewhere ?? new Set<number>()
  const inReading = new Map(reading.map((entry) => [entry.pid, entry.startedAt]))
  // A member counts as a running parent only as this reading shows it: one that ended after its job was read, its pid
  // given to another process, runs here under another start.
  const running = new Map((options.members ?? []).filter((entry) => inReading.get(entry.pid) === entry.startedAt).map((entry) => [entry.pid, entry.startedAt]))
  const memberPids = new Set((options.members ?? []).map((entry) => entry.pid))
  // The late browsers gone from this reading, their pids taken by nothing else.
  const late = options.late ?? new Set<number>()
  const gone = new Map([...records].filter(([pid]) => late.has(pid) && !inReading.has(pid)))
  const claimed: SupervisedProcess[] = []
  let weak = false
  const claim = (entry: SupervisedProcess): void => {
    running.set(entry.pid, entry.startedAt)
    claimed.push(entry)
  }
  const open = (entry: SupervisedProcess): boolean => !memberPids.has(entry.pid) && !running.has(entry.pid) && !elsewhere.has(entry.pid)
  for (const entry of reading) {
    if (!open(entry)) continue
    if (records.get(entry.pid) === entry.startedAt) claim(entry)
    else if (markers.some((marker) => namesFolder(entry.commandLine, marker))) {
      claim(entry)
      weak = true
    }
  }
  let changed = true
  while (changed) {
    changed = false
    for (const entry of reading) {
      if (!open(entry) || entry.parentPid === undefined) continue
      const parent = running.get(entry.parentPid)
      const lately = parent === undefined ? gone.get(entry.parentPid) : undefined
      const start = parent ?? lately
      if (start === undefined || BigInt(start) > BigInt(entry.startedAt)) continue
      claim(entry)
      weak ||= lately !== undefined
      changed = true
    }
  }
  return { claimed, records: new Map(claimed.map((entry) => [entry.pid, entry.startedAt])), weak }
}

/**
 * Whether a command line names `marker` as a folder of its own: between two separators, or after one at the end of a
 * path, never as part of a longer name. Windows compares names whatever their case.
 *
 * @example namesFolder('firefox.exe --profile "C:\\Temp\\retest-firefox-1-a\\profile"', 'retest-firefox-1-a') // true
 */
export function namesFolder(commandLine: string | undefined, marker: string): boolean {
  if (commandLine === undefined || marker === '') return false
  const line = commandLine.toLowerCase()
  const wanted = marker.toLowerCase()
  for (let at = line.indexOf(wanted); at >= 0; at = line.indexOf(wanted, at + 1)) {
    const before = line[at - 1]
    const after = line[at + wanted.length]
    if ((before === '\\' || before === '/') && (after === undefined || after === '\\' || after === '/' || after === '"' || after === "'" || after.trim() === '')) return true
  }
  return false
}

/** What a launch of a run has on record, and the markers that name its processes, for the run's end to tie strays by. */
export type LaunchRecord = { readonly onRecord: () => ProcessRecords; readonly markers: readonly string[] }

/**
 * Of the processes no launch's job holds and nothing running stands behind, those a run can tie to itself by the facts
 * a launch's own reading goes by: each one on a launch's record by its pid and start, each one whose parent runs in this
 * reading on such a record, and each one whose command line names a launch's marker. A record of any age is only ever
 * its own process, so nothing is tied through a process that has ended.
 *
 * @example tiedTo([{ onRecord: () => new Map([[5001, '13437009000005001']]), markers: [] }], strays) // 5001, and what 5001 runs
 */
export function tiedTo(launches: readonly LaunchRecord[], strays: readonly SupervisedProcess[]): SupervisedProcess[] {
  const tied = new Set<string>()
  for (const launch of launches) {
    for (const entry of readParented({ records: launch.onRecord(), reading: strays, markers: launch.markers }).claimed) tied.add(`${entry.pid}:${entry.startedAt}`)
  }
  return strays.filter((entry) => tied.has(`${entry.pid}:${entry.startedAt}`))
}

function recordsOf(processes: readonly SupervisedProcess[]): ProcessRecords {
  return new Map(processes.map((entry) => [entry.pid, entry.startedAt]))
}

/**
 * A process left running, as cleanup names it; `when` says when it was seen, such as `after process 5000 ended`.
 *
 * @example stillRunningProblem({ pid: 6100, parentPid: 6050, startedAt: '1', image: 'C:\\Apps\\helper.exe' }, 'after process 5000 ended') // 'Process 6100 (helper.exe) is still running after process 5000 ended. Retest ends it when Retest exits.'
 */
export function stillRunningProblem(process: SupervisedProcess, when: string): string {
  return `Process ${process.pid} (${process.image === undefined ? 'a program Windows would not name' : win32.basename(process.image)}) is still running ${when}. Retest ends it when Retest exits.`
}

/** What cleanup says when it could not look for processes left running; `when` as for `stillRunningProblem`. */
export function leftoversUnreadProblem(error: unknown, when: string): string {
  return `Retest could not look for processes still running ${when}: ${errorMessage(error)}`
}

/**
 * The command a process stands under when Windows would not name its executable. It has the shape the ownership rule
 * reads as a command that cannot be read, so it is never compared as one.
 */
export const unreadableImage = '(unreadable)'

/**
 * A launch's ownership readings on Windows, its job, what it has on record by pid and start (its job's members as its
 * newest reading of the job found them, and those it holds by their parents as its newest reading of the runner's job
 * left them), and its markers.
 */
export type JobOwnershipSystem = ProcessOwnershipSystem & LaunchRecord & {
  readonly job: OwnedJob
}

/**
 * A launch's ownership readings on Windows: its job's own process list, where every member has the launch's pid as its
 * group, a pid read with whether the job holds it, and the job's end, which ends every member at once. A job that was
 * read empty holds nothing from then on, since only Retest puts processes in it and only when it is made, so its
 * handle is given back and every later reading answers empty without asking.
 *
 * A process held by its parent, already in a job of its own when the launch was held, as the browser Firefox's Windows
 * launcher starts is, belongs to the launch as well, with everything it starts while it runs: they are read from the
 * runner's job as members, by the starts on record, through parents running in the same reading, and by `markers`, the
 * names in a command line only this launch's processes carry, such as its profile folder.
 *
 * An empty job is not yet proof that the launch left nothing. A process whose own parent had ended before the launch
 * was held cannot be tied to it, and stays in the runner's job only; so once the job is read empty, the runner's job is
 * read too, and anything there that no launch's job holds and nothing running stands behind leaves the launch's
 * cleanup unconfirmed, naming it. Each such process is named once in the host, for the first launch it is seen after.
 *
 * @example const ownership = new OwnedProcessGroup(child.pid, process.pid, jobSystem(supervisor, supervisor.adopt(child.pid)))
 */
export function jobSystem(supervisor: Supervisor, launch: HeldLaunch, options: { readonly markers?: readonly string[]; readonly lateParentMs?: number } = {}): JobOwnershipSystem {
  const root = launch.root.pid
  const markers = options.markers ?? []
  const lateWindowMs = options.lateParentMs ?? lateParentMs
  const browsers = new Map(launch.byParent.map((entry) => [entry.pid, entry.startedAt]))
  let inJob = recordsOf([...(launch.ended ? [] : [launch.root]), ...launch.late])
  let parented = recordsOf(launch.byParent)
  // When the runner's job was last read for the launch, for `readParented`'s reading a moment after the one before.
  let lastRead = Number.NEGATIVE_INFINITY
  let emptied = false
  const unconfirmed: string[] = []
  const owned = (entry: SupervisedProcess, member: boolean): OwnedProcessIdentity => ({
    pid: entry.pid, parentPid: entry.parentPid ?? 0, groupId: member ? root : 0, startedAt: entry.startedAt, command: entry.image ?? unreadableImage,
  })
  const release = (deadline?: Deadline): void => {
    emptied = true
    try {
      supervisor.release(launch.job, launch.handle, deadline)
    } catch {
      // An empty job whose handle stays open holds nothing and goes with the runner; the reading itself stands.
    }
  }
  const releaseAsync = async (deadline?: Deadline): Promise<void> => {
    emptied = true
    try {
      await supervisor.releaseAsync(launch.job, launch.handle, deadline)
    } catch {
      // As for `release`.
    }
  }
  // Each stray first seen as the launch's job is read empty is named: by the launch, after its process ended, when the
  // launch's own facts tie it to the launch; otherwise by what it is, a process whose starter has ended, which blames no
  // launch. One whose parent's pid is that of a browser another launch the host holds had by its parent is left to that
  // launch, whose next reading ends it or names it, as a content process outlives its browser a moment.
  const named = (strays: readonly SupervisedProcess[]): string[] => {
    const elsewhere = new Set(supervisor.launches.flatMap((other) => other.job === launch.job ? [] : other.byParent.map((entry) => entry.pid)))
    const left = strays.filter((stray) => stray.parentPid === undefined || !elsewhere.has(stray.parentPid))
    const tied = new Set(readParented({ records: parented, reading: left, markers }).claimed.map((entry) => entry.pid))
    return supervisor.firstNamed(left).map((stray) => tied.has(stray.pid) ? stillRunningProblem(stray, `after process ${root} ended`) : stillRunningProblem(stray, 'after the process that started it ended'))
  }
  const seen = (members: readonly SupervisedProcess[], deadline?: Deadline): readonly OwnedProcessIdentity[] => {
    if (members.length > 0) return members.map((entry) => owned(entry, true))
    release(deadline)
    try {
      unconfirmed.push(...named(supervisor.strays(deadline)))
    } catch (error) {
      unconfirmed.push(leftoversUnreadProblem(error, `after process ${root} ended`))
    }
    return []
  }
  const seenAsync = async (members: readonly SupervisedProcess[], deadline?: Deadline): Promise<readonly OwnedProcessIdentity[]> => {
    if (members.length > 0) return members.map((entry) => owned(entry, true))
    await releaseAsync(deadline)
    try {
      unconfirmed.push(...named(await supervisor.straysAsync(deadline)))
    } catch (error) {
      unconfirmed.push(leftoversUnreadProblem(error, `after process ${root} ended`))
    }
    return []
  }
  // What a reading of the runner's job, taken at `readAt`, finds the launch holds by its parents (`readParented`). A claim
  // that rests on a marker or on a parent read one reading late could be another launch's, so then the other launches'
  // jobs are read once and what they hold is left alone; when one of them cannot be read, such claims are not made.
  const strongly = (members: readonly SupervisedProcess[], reading: readonly SupervisedProcess[]) => readParented({ records: parented, members, reading })
  // The launch's browsers that ran in the reading before, when that reading was a moment ago.
  const lately = (readAt: number): ReadonlySet<number> => new Set(readAt - lastRead > lateWindowMs ? [] : [...browsers].filter(([pid, startedAt]) => parented.get(pid) === startedAt).map(([pid]) => pid))
  const parentHeld = (members: readonly SupervisedProcess[], reading: readonly SupervisedProcess[], readAt: number, deadline?: Deadline): readonly SupervisedProcess[] => {
    const late = lately(readAt)
    let found = readParented({ records: parented, members, reading, markers, late })
    if (found.weak) {
      const elsewhere = supervisor.otherLaunchMembers(launch.job, deadline)
      found = elsewhere === undefined ? strongly(members, reading) : readParented({ records: parented, members, reading, markers, late, elsewhere })
    }
    parented = found.records
    lastRead = readAt
    return found.claimed
  }
  const parentHeldAsync = async (members: readonly SupervisedProcess[], reading: readonly SupervisedProcess[], readAt: number, deadline?: Deadline): Promise<readonly SupervisedProcess[]> => {
    const late = lately(readAt)
    let found = readParented({ records: parented, members, reading, markers, late })
    if (found.weak) {
      const elsewhere = await supervisor.otherLaunchMembersAsync(launch.job, deadline)
      found = elsewhere === undefined ? strongly(members, reading) : readParented({ records: parented, members, reading, markers, late, elsewhere })
    }
    parented = found.records
    lastRead = readAt
    return found.claimed
  }
  // A process held by its parent is in a job of its own beside the launch's, which the launch's job's end does not reach,
  // and so is what it started, as the content processes of a browser Firefox's launcher started are. Each is ended by the
  // start the runner's job gives it, while it is still that process there. A process can start another between the
  // reading and its own end, so the runner's job is read again, up to `parentedEndRounds` times, until none is left: a
  // round's reading comes a moment after the last, so what a process the last round ended started is still the launch's
  // (`readParented`'s `late`). Whatever is left is the next reading's to name.
  const endParented = (deadline?: Deadline): void => {
    for (let round = 0; round < parentedEndRounds && parented.size > 0; round += 1) {
      let reading: readonly SupervisedProcess[]
      const readAt = performance.now()
      try {
        reading = supervisor.members(supervisor.runnerJob, deadline)
      } catch {
        return
      }
      const ending = parentHeld([], reading, readAt, deadline)
      if (ending.length === 0) return
      for (const entry of ending) {
        try {
          supervisor.terminate(supervisor.runnerJob, entry.pid, entry.startedAt, deadline)
        } catch {
          // Not ended; the launch's next reading still counts it.
        }
      }
    }
  }
  // As `endParented`, without holding the thread: one run of the supervisor at a time, as the synchronous end makes them.
  const endParentedAsync = async (deadline?: Deadline): Promise<void> => {
    for (let round = 0; round < parentedEndRounds && parented.size > 0; round += 1) {
      let reading: readonly SupervisedProcess[]
      const readAt = performance.now()
      try {
        reading = await supervisor.membersAsync(supervisor.runnerJob, deadline)
      } catch {
        return
      }
      const ending = await parentHeldAsync([], reading, readAt, deadline)
      if (ending.length === 0) return
      for (const entry of ending) {
        try {
          await supervisor.terminateAsync(supervisor.runnerJob, entry.pid, entry.startedAt, deadline)
        } catch {
          // As for `endParented`.
        }
      }
    }
  }
  const job: OwnedJob = {
    root,
    launched: owned(launch.root, true),
    end: (deadline) => {
      if (emptied) return
      supervisor.end(launch.job, deadline)
      endParented(deadline)
    },
    endAsync: async (deadline) => {
      if (emptied) return
      await supervisor.endAsync(launch.job, deadline)
      await endParentedAsync(deadline)
    },
    interrupt: (deadline) => { if (!emptied) supervisor.interrupt(launch.job, deadline === undefined ? {} : { deadline }) },
    unconfirmed: () => unconfirmed,
  }
  return {
    job,
    onRecord: () => new Map([...inJob, ...parented]),
    markers,
    read: (deadline) => {
      if (emptied) return []
      const members = supervisor.members(launch.job, deadline)
      inJob = recordsOf(members)
      if (parented.size === 0) return seen(members, deadline)
      const readAt = performance.now()
      return seen([...members, ...parentHeld(members, supervisor.members(supervisor.runnerJob, deadline), readAt, deadline)], deadline)
    },
    readAsync: async (deadline) => {
      if (emptied) return []
      const members = await supervisor.membersAsync(launch.job, deadline)
      inJob = recordsOf(members)
      if (parented.size === 0) return seenAsync(members, deadline)
      const readAt = performance.now()
      return seenAsync([...members, ...(await parentHeldAsync(members, await supervisor.membersAsync(supervisor.runnerJob, deadline), readAt, deadline))], deadline)
    },
    readProcess: (pid, deadline) => {
      const reading = supervisor.process(pid, launch.job, deadline)
      return reading.process === undefined ? undefined : owned(reading.process, reading.inJob && !emptied)
    },
    readProcessAsync: async (pid, deadline) => {
      const reading = await supervisor.processAsync(pid, launch.job, deadline)
      return reading.process === undefined ? undefined : owned(reading.process, reading.inJob && !emptied)
    },
    signal: (pid, signal, expected) => {
      if (signal !== 'SIGKILL' && signal !== 'SIGTERM') throw new Error(`Windows has no ${signal === 0 ? 'signal 0' : signal}; Retest only ends a process there, through its job.`)
      if (expected === undefined) throw new Error(`Process ${pid} has no recorded start, so it was not ended.`)
      const outcome = supervisor.terminate(launch.job, pid, expected.startedAt)
      if (outcome === 'absent') throw Object.assign(new Error(`Process ${pid} is not running.`), { code: 'ESRCH' })
      if (outcome === 'different') throw new Error(`Process ${pid} is no longer the process Retest recorded, so it was not ended.`)
    },
  }
}
