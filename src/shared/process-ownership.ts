import type { MetadataProcessOptions } from './metadata-process.ts'
import type { Deadline } from '../protocol/deadline.ts'
import { errorMessage } from '../protocol/failures.ts'
import { errorCode } from './error-code.ts'
import { processTableOutputLimit, readMetadataProcess, readMetadataProcessAsync } from './metadata-process.ts'

/** A process identity read from the host, retained only in memory. */
export type OwnedProcessIdentity = {
  pid: number
  parentPid: number
  groupId: number
  startedAt: string
  command: string
  /** Host process state when available; a zombie has exited and needs no destructive signal. */
  state?: string
}

export type ProcessOwnershipSystem = {
  read(deadline?: Deadline): readonly OwnedProcessIdentity[]
  /**
   * One process as the host shows it now, or undefined when it is not there. Read immediately before a signal, so the
   * window in which its pid could be reused is one short reading rather than a whole process table. A system without
   * it is read whole instead.
   */
  readProcess?(pid: number, deadline?: Deadline): OwnedProcessIdentity | undefined
  /** The whole table read without holding the thread, for recording that can wait. A system without it reads at once. */
  readAsync?(deadline?: Deadline): Promise<readonly OwnedProcessIdentity[]>
  /** The same immediate pre-signal reading without holding the event loop. */
  readProcessAsync?(pid: number, deadline?: Deadline): Promise<OwnedProcessIdentity | undefined>
  signal(pid: number, signal: NodeJS.Signals | 0): void
}

/** Signal failures stay failures; identity refusals can be reconciled only by a later proof of absence. */
export type ProcessSignalReport = {
  readonly problems: readonly string[]
  readonly identityRefusals: readonly string[]
}

/**
 * A whole-table reading taken without holding the thread, which every caller that asks while it runs waits for. It
 * carries the deadline of the caller that started it and its place in the order readings began.
 */
type TableReading = {
  readonly processes: Promise<readonly OwnedProcessIdentity[]>
  readonly deadline: Deadline | undefined
  readonly sequence: number
}

const host: ProcessOwnershipSystem = {
  read: readProcessTable,
  readProcess: readOneProcess,
  readAsync: readProcessTableAsync,
  readProcessAsync: readOneProcessAsync,
  signal: (pid, signal) => { process.kill(pid, signal) },
}

/**
 * Records a launched process and the descendants observed beneath a still-verified owned process. Group membership
 * alone never establishes ownership. Signals are sent to recorded, freshly verified pids, never to a numeric group.
 */
export class OwnedProcessGroup {
  readonly #pid: number
  readonly #parentPid: number
  readonly #system: ProcessOwnershipSystem
  readonly #records = new Map<number, OwnedProcessIdentity>()
  readonly #unowned = new Map<number, OwnedProcessIdentity>()
  readonly #readProblems = new Set<string>()
  #initialized = false
  #retired = false
  #initialProcessAbsent = false
  // Keep one launch birth after pruning its pid, to distinguish a later group reusing that numeric id.
  #launchIdentity: OwnedProcessIdentity | undefined
  // Each reading, and each change made from a single process's own reading, takes the next number as it begins.
  // `#newest` is the number of the newest one applied: a reading that began before it is stale.
  #sequence = 0
  #newest = 0
  // Cleanup runs several waits on one group at once: its end, its output and the stop itself. Each starting a `ps` of
  // its own, with each applied snapshot discarding the others' as stale, multiplied the readings on a loaded host until
  // none was confirmed within the cleanup bound. They share the reading in flight instead.
  #tableReading: TableReading | undefined

  constructor(pid: number, parentPid: number = process.pid, system: ProcessOwnershipSystem = host) {
    if (!Number.isSafeInteger(pid) || pid < 2 || !Number.isSafeInteger(parentPid) || parentPid < 1) throw new TypeError('A launched process needs a valid pid and parent pid.')
    this.#pid = pid
    this.#parentPid = parentPid
    this.#system = system
  }

  /** The first successful host reading found no launched pid. A failed reading never sets this fact. */
  get initialProcessAbsent(): boolean {
    return this.#initialProcessAbsent
  }

  /** Failed metadata readings remain visible even when a later reading proves the launch ended. */
  get readProblems(): readonly string[] {
    return [...this.#readProblems]
  }

  /** Whether the launch has been read once, whatever the reading found or however it failed. */
  get captured(): boolean {
    return this.#initialized
  }

  #failedRead(error: unknown): string {
    const problem = `Could not read ownership of process ${this.#pid}: ${errorMessage(error)}`
    this.#readProblems.add(problem)
    return problem
  }

  /** Records descendants only while their chain reaches an already verified process this owner launched. */
  capture(deadline?: Deadline): string[] {
    if (this.#retired) return []
    let processes: readonly OwnedProcessIdentity[]
    try {
      checkDeadline(deadline)
      processes = this.#system.read(deadline)
      checkDeadline(deadline)
    } catch (error) {
      this.#initialized = true
      return [this.#failedRead(error)]
    }
    return this.#captureFrom(processes, this.#next())
  }

  /**
   * `capture` from a reading taken without holding the thread, for recording a new process while other work goes on.
   * The reading is a moment old when it is applied, which only adds records with their start times; every signal still
   * reads its pid fresh. A reading that fails records nothing and is not kept as a read problem, since it decides
   * nothing and the next `capture` reads again. With a cleanup deadline, failures are retained. A newer applied
   * snapshot wins over an outstanding background reading. It reads the host as it is when asked: a reading begun
   * before, which cannot hold a process born since, is never taken, though later callers may share this one. Before
   * the first `capture`, or on a system without `readAsync`, it is `capture` itself.
   */
  async captureAsync(deadline?: Deadline): Promise<string[]> {
    if (this.#retired) return []
    if (!this.#initialized || this.#system.readAsync === undefined) return this.capture(deadline)
    const asked = this.#sequence
    let read: { readonly processes: readonly OwnedProcessIdentity[]; readonly reading: TableReading }
    try {
      checkDeadline(deadline)
      read = await this.#sharedTable(deadline, asked)
      checkDeadline(deadline)
    } catch (error) {
      return deadline === undefined ? [] : [this.#failedRead(error)]
    }
    if (this.#retired || !this.#fresh(read.reading)) return []
    return this.#captureFrom(read.processes, read.reading.sequence)
  }

  #captureFrom(processes: readonly OwnedProcessIdentity[], sequence: number): string[] {
    this.#newest = Math.max(this.#newest, sequence)
    const initial = !this.#initialized
    this.#initialized = true
    const root = processes.find((entry) => entry.pid === this.#pid)
    if (initial) {
      if (root === undefined) {
        this.#initialProcessAbsent = true
        return [`Launched process ${this.#pid} could not be recorded before it exited.`]
      }
      if (root.parentPid !== this.#parentPid) return [`Process ${this.#pid} is not the launched child, so it was not claimed.`]
      this.#records.set(root.pid, root)
      this.#launchIdentity = root
    }
    for (const entry of processes) {
      const record = this.#records.get(entry.pid)
      // A process recorded while its command could not be read keeps the first readable one, so a later change is seen.
      if (record !== undefined && running(entry) && sameProcess(record, entry) && unreadableCommand(record.command) && !unreadableCommand(entry.command)) this.#records.set(entry.pid, { ...record, command: entry.command })
    }
    const owned = new Set(processes.filter((entry) => running(entry) && this.#sameRecorded(this.#records.get(entry.pid), entry)).map((entry) => entry.pid))
    let changed = true
    while (changed) {
      changed = false
      for (const entry of processes) {
        if (!running(entry) || owned.has(entry.pid) || this.#records.has(entry.pid) || !owned.has(entry.parentPid)) continue
        this.#records.set(entry.pid, entry)
        owned.add(entry.pid)
        changed = true
      }
    }
    const reusedGroup = root !== undefined && this.#launchIdentity !== undefined && !sameBirth(this.#launchIdentity, root)
    const unknown = reusedGroup ? [] : processes.filter((entry) => running(entry) && entry.groupId === this.#pid && !sameBirth(this.#records.get(entry.pid), entry))
    for (const entry of unknown) this.#unowned.set(entry.pid, entry)
    this.#forgetGone(processes)
    if (unknown.length > 0) return [unverifiedMembersProblem(this.#pid)]
    return []
  }

  // Absence or a zombie in a successful snapshot needs no per-pid query. Identity changes stay recorded and refused.
  #forgetGone(processes: readonly OwnedProcessIdentity[]): void {
    const live = new Set(processes.filter(running).map((entry) => entry.pid))
    for (const records of [this.#records, this.#unowned]) {
      for (const pid of records.keys()) if (!live.has(pid)) records.delete(pid)
    }
  }

  /**
   * A fresh identity is returned only for a process already recorded through verified launch ancestry. Where `ps` can no
   * longer read its command line, as while it exits, the recorded one stands in.
   */
  verifiedIdentity(pid: number = this.#pid): OwnedProcessIdentity | undefined {
    if (this.#retired) return undefined
    const record = this.#records.get(pid)
    if (record === undefined) return undefined
    try {
      const current = this.#readNow(pid)
      if (current === undefined || !running(current)) {
        this.#records.delete(pid)
        this.#unowned.delete(pid)
        this.#newest = this.#next()
        return undefined
      }
      if (!this.#sameRecorded(record, current)) return undefined
      return unreadableCommand(current.command) ? { ...current, command: record.command } : current
    } catch (error) {
      this.#failedRead(error)
      return undefined
    }
  }

  /** Hands off an already recorded descendant without claiming a pid merely named by a remote reply. */
  groupFor(pid: number): OwnedProcessGroup | undefined {
    if (this.capture().length > 0) return undefined
    const record = this.verifiedIdentity(pid)
    if (record === undefined) return undefined
    const group = new OwnedProcessGroup(pid, record.parentPid, this.#system)
    group.#records.set(pid, record)
    group.#launchIdentity = record
    const descendants = new Set([pid])
    let changed = true
    while (changed) {
      changed = false
      for (const entry of this.#records.values()) {
        if (descendants.has(entry.pid) || !descendants.has(entry.parentPid)) continue
        descendants.add(entry.pid)
        group.#records.set(entry.pid, entry)
        changed = true
      }
    }
    for (const entry of this.#unowned.values()) if (entry.groupId === record.groupId) group.#unowned.set(entry.pid, entry)
    group.#initialized = true
    if (group.capture().length > 0) return undefined
    return group
  }

  /**
   * Rechecks each start reading, and each command reading `ps` can still take, immediately before signaling the recorded
   * pid. The check reads that one pid alone, so the pid could be reused only between that short reading and the signal.
   * macOS has no pidfd or other handle that pins a process for a signal, so that last window cannot be closed there; a
   * reuse inside it would also need the same start second and an unreadable or identical command.
   */
  signalReport(signal: NodeJS.Signals, deadline?: Deadline): ProcessSignalReport {
    if (this.#retired) return { problems: [], identityRefusals: [] }
    let processes: readonly OwnedProcessIdentity[]
    try {
      checkDeadline(deadline)
      processes = this.#system.read(deadline)
      checkDeadline(deadline)
    } catch (error) {
      this.#initialized = true
      return { problems: [this.#failedRead(error)], identityRefusals: [] }
    }
    const problems = this.#captureFrom(processes, this.#next())
    const identityRefusals: string[] = []
    for (const record of [...this.#records.values()].reverse()) {
      let current: OwnedProcessIdentity | undefined
      try {
        checkDeadline(deadline)
        current = this.#readNow(record.pid, deadline)
        checkDeadline(deadline)
      } catch (error) {
        this.#failedRead(error)
        problems.push(`Could not verify recorded process ${record.pid}, so it was not signaled: ${errorMessage(error)}`)
        break
      }
      this.#signalCurrent(record, current, signal, problems, identityRefusals, deadline)
    }
    return { problems, identityRefusals }
  }

  /**
   * Ordinary cleanup uses asynchronous readings; each signal still immediately follows its own fresh identity. The
   * table it records descendants from is begun after it was asked, so a helper born just before is recorded and ended.
   */
  async signalReportAsync(signal: NodeJS.Signals, deadline?: Deadline): Promise<ProcessSignalReport> {
    if (this.#retired) return { problems: [], identityRefusals: [] }
    const asked = this.#sequence
    let read: { readonly processes: readonly OwnedProcessIdentity[]; readonly reading: TableReading } | undefined
    try {
      checkDeadline(deadline)
      read = await this.#readFreshTableAsync(deadline, asked)
      checkDeadline(deadline)
    } catch (error) {
      this.#initialized = true
      return { problems: [this.#failedRead(error)], identityRefusals: [] }
    }
    if (this.#retired || read === undefined) return { problems: [], identityRefusals: [] }
    const problems = this.#captureFrom(read.processes, read.reading.sequence)
    const identityRefusals: string[] = []
    for (const record of [...this.#records.values()].reverse()) {
      let current: OwnedProcessIdentity | undefined
      try {
        checkDeadline(deadline)
        current = this.#system.readProcessAsync === undefined
          ? this.#readNow(record.pid, deadline)
          : await this.#system.readProcessAsync(record.pid, deadline)
        checkDeadline(deadline)
      } catch (error) {
        this.#failedRead(error)
        problems.push(`Could not verify recorded process ${record.pid}, so it was not signaled: ${errorMessage(error)}`)
        break
      }
      this.#signalCurrent(record, current, signal, problems, identityRefusals, deadline)
    }
    return { problems, identityRefusals }
  }

  #signalCurrent(record: OwnedProcessIdentity, current: OwnedProcessIdentity | undefined, signal: NodeJS.Signals, problems: string[], identityRefusals: string[], deadline?: Deadline): void {
    // Another awaited cleanup may already have confirmed this record gone. It must not be restored by a late reply.
    if (this.#retired || !sameProcess(this.#records.get(record.pid), record)) return
    if (current === undefined || !running(current)) {
      this.#records.delete(record.pid)
      this.#unowned.delete(record.pid)
      this.#newest = this.#next()
      return
    }
    if (!this.#sameRecorded(record, current)) {
      const changes = [
        ...(record.startedAt === current.startedAt ? [] : ['start reading changed']),
        ...(record.command === current.command || unreadableCommand(record.command) || unreadableCommand(current.command) ? [] : ['command reading changed']),
      ]
      const parent = this.#records.get(record.parentPid)
      const ancestry = parent === undefined ? 'parent command was not recorded' : record.command === parent.command ? 'original command matched its recorded parent' : 'original command differed from its recorded parent'
      const role = record.pid === this.#pid ? 'launch root' : 'recorded descendant'
      const recordedState = /^[A-Z]/.test(record.state ?? '') ? record.state?.[0] : 'unavailable'
      const currentState = /^[A-Z]/.test(current.state ?? '') ? current.state?.[0] : 'unavailable'
      identityRefusals.push(`Recorded process ${record.pid} has a different identity (${role}; ${changes.join(', ')}; host state ${recordedState} to ${currentState}; ${ancestry}), so it was left alone.`)
      return
    }
    try {
      checkDeadline(deadline)
      this.#system.signal(record.pid, signal)
    } catch (error) {
      if (errorCode(error) !== 'ESRCH') problems.push(`Could not signal recorded process ${record.pid}: ${errorMessage(error)}`)
    }
  }

  /**
   * `sameProcessIdentity`, and also a recorded descendant whose command line changed only as a helper rewrites its own
   * while it starts, read with its start and its parent unchanged and that parent still recorded. A pid another process
   * took has another start, or another parent, and stays refused.
   */
  #sameRecorded(record: OwnedProcessIdentity | undefined, current: OwnedProcessIdentity): boolean {
    if (record === undefined) return false
    if (sameProcessIdentity(record, current)) return true
    if (record.pid === this.#pid || !sameBirth(record, current) || record.parentPid !== current.parentPid) return false
    const parent = this.#records.get(record.parentPid)
    return parent !== undefined && startedHelperCommand(record.command, current.command, parent.command)
  }

  #readNow(pid: number, deadline?: Deadline): OwnedProcessIdentity | undefined {
    if (this.#system.readProcess !== undefined) return this.#system.readProcess(pid, deadline)
    return this.#system.read(deadline).find((entry) => entry.pid === pid)
  }

  async #readTableAsync(deadline?: Deadline): Promise<readonly OwnedProcessIdentity[]> {
    return this.#system.readAsync === undefined ? this.#system.read(deadline) : this.#system.readAsync(deadline)
  }

  #next(): number {
    this.#sequence += 1
    return this.#sequence
  }

  // The reading running now while nothing newer was applied since it began, which a caller waits for rather than start
  // another `ps`; otherwise a new one under this caller's deadline. A caller that gives `asked`, the number current when
  // it asked, takes only a reading begun after it.
  #tableReadingFor(deadline: Deadline | undefined, asked: number | undefined): TableReading {
    const running = this.#tableReading
    if (running !== undefined && this.#fresh(running) && (asked === undefined || running.sequence > asked)) return running
    const reading: TableReading = { processes: this.#readTableAsync(deadline), deadline, sequence: this.#next() }
    this.#tableReading = reading
    const finished = (): void => { if (this.#tableReading === reading) this.#tableReading = undefined }
    reading.processes.then(finished, finished)
    return reading
  }

  // One completed table reading. A caller waits for a reading another caller started only within its own deadline. When
  // that reading fails, as one the other caller's shorter deadline ended does, it moves to a fresh one within its own.
  async #sharedTable(deadline: Deadline | undefined, asked?: number): Promise<{ readonly processes: readonly OwnedProcessIdentity[]; readonly reading: TableReading }> {
    for (;;) {
      checkDeadline(deadline)
      const reading = this.#tableReadingFor(deadline, asked)
      if (reading.deadline === deadline) return { processes: await reading.processes, reading }
      try {
        return { processes: await withinDeadline(reading.processes, deadline), reading }
      } catch {
        checkDeadline(deadline)
      }
    }
  }

  // A snapshot may be applied while nothing newer was. Its own callers apply it after one another, which ages nothing.
  #fresh(reading: TableReading): boolean {
    return reading.sequence >= this.#newest
  }

  // Undefined once the group has been shown gone, which no later reading can change.
  async #readFreshTableAsync(deadline?: Deadline, asked?: number): Promise<{ readonly processes: readonly OwnedProcessIdentity[]; readonly reading: TableReading } | undefined> {
    for (;;) {
      if (this.#retired) return undefined
      const read = await this.#sharedTable(deadline, asked)
      checkDeadline(deadline)
      if (this.#retired) return undefined
      if (this.#fresh(read.reading)) return read
    }
  }

  /** Keeps every failure and identity refusal visible to callers that do not reconcile a later full absence. */
  signal(signal: NodeJS.Signals, deadline?: Deadline): string[] {
    const report = this.signalReport(signal, deadline)
    return [...report.problems, ...report.identityRefusals]
  }

  /** The synchronous exit-hook path has exactly the same identity checks as ordinary cleanup. */
  signalNow(signal: NodeJS.Signals, deadline?: Deadline): string[] {
    return this.signal(signal, deadline)
  }

  /** A failed liveness reading holds the resource. Once observed gone, this owner never names these pids again. */
  remains(deadline?: Deadline): boolean {
    if (this.#retired) return false
    let processes: readonly OwnedProcessIdentity[]
    try {
      checkDeadline(deadline)
      processes = this.#system.read(deadline)
      checkDeadline(deadline)
    } catch (error) { this.#failedRead(error); return true }
    return this.#remainsFrom(processes, this.#next())
  }

  /**
   * A failed or deadline-limited reading retains the resource, just as the synchronous exit-hook reading does. It may
   * take a reading begun before it was asked: a group with no process left when the table was read has none left to
   * start another. Callers asking at once share one reading, and once one of them sees the group gone the others stop
   * reading.
   */
  async remainsAsync(deadline?: Deadline): Promise<boolean> {
    if (this.#retired) return false
    let read: { readonly processes: readonly OwnedProcessIdentity[]; readonly reading: TableReading } | undefined
    try {
      checkDeadline(deadline)
      read = await this.#readFreshTableAsync(deadline)
      checkDeadline(deadline)
    } catch (error) { this.#failedRead(error); return true }
    if (this.#retired || read === undefined) return false
    return this.#remainsFrom(read.processes, read.reading.sequence)
  }

  #remainsFrom(processes: readonly OwnedProcessIdentity[], sequence: number): boolean {
    this.#newest = Math.max(this.#newest, sequence)
    // A failed first reading never grants signal authority, and an empty ledger is no proof that the launched
    // child ended. Until its pid and group are absent, that unresolved launch continues to hold its resource.
    if (this.#launchIdentity === undefined && processes.some((entry) => running(entry) && (entry.pid === this.#pid || entry.groupId === this.#pid))) return true
    const root = processes.find((entry) => entry.pid === this.#pid)
    const reusedGroup = root !== undefined && this.#launchIdentity !== undefined && !sameBirth(this.#launchIdentity, root)
    if (!reusedGroup) for (const current of processes) {
      if (running(current) && current.groupId === this.#pid && !sameBirth(this.#records.get(current.pid), current)) this.#unowned.set(current.pid, current)
    }
    this.#forgetGone(processes)
    for (const current of processes) if (running(current) && (sameBirth(this.#records.get(current.pid), current) || sameBirth(this.#unowned.get(current.pid), current))) return true
    this.#retired = true
    this.#records.clear()
    this.#unowned.clear()
    return false
  }
}

/**
 * What `capture` says of a group holding processes it could not trace to the launch. Such processes are never signaled,
 * so a caller that later proves the whole group gone, by `remains()` answering false, may settle this problem.
 *
 * @example unverifiedMembersProblem(4242) // 'Process group 4242 contains processes whose launch ownership could not be verified; they were left alone.'
 */
export function unverifiedMembersProblem(groupId: number): string {
  return `Process group ${groupId} contains processes whose launch ownership could not be verified; they were left alone.`
}

function sameProcess(record: OwnedProcessIdentity | undefined, current: OwnedProcessIdentity): boolean {
  return record !== undefined && sameProcessIdentity(record, current)
}

/**
 * Whether a fresh reading is the recorded process. Its pid and start cannot change while it lives, and a reused pid
 * has another start. A command line can: `ps` stops reading it while the process exits, so an unreadable reading is
 * no difference. Two readable command lines that differ are still refused, since a start reading has whole seconds
 * and the command line is what tells apart a pid reused within the same second.
 *
 * @example sameProcessIdentity(recorded, { ...recorded, command: '(Google Chrome fo)', state: '?E' }) // true
 */
export function sameProcessIdentity(record: OwnedProcessIdentity, current: OwnedProcessIdentity): boolean {
  if (record.pid !== current.pid || record.startedAt !== current.startedAt) return false
  return record.command === current.command || unreadableCommand(record.command) || unreadableCommand(current.command)
}

// macOS `ps` prints the kernel's name for a process, at most 16 characters, in parentheses when it cannot read the
// arguments, as while the process exits; procps on Linux prints it, at most 15 characters, in brackets when they are empty.
// A process whose real command line has that same shape, such as Linux's `(sd-pam)`, reads as unreadable too; only its
// pid and start then tell it apart, so a reuse of a recorded pid within the same start second by such a process would pass.
function unreadableCommand(command: string): boolean {
  return /^\(.{1,16}\)$/.test(command) || /^\[.{1,15}\]$/.test(command)
}

const selfLink = '/proc/self/exe'

/**
 * Whether a helper running its parent's own executable, first read as `recorded` and now as `current`, only rewrote its
 * command line as it started, which Chrome's helpers on Linux do: a forked helper shows its parent's command line until
 * it runs /proc/self/exe, then writes the executable that link names in its place, and headless Chrome appends the
 * switches it sets for itself. Any other change stays refused: another executable, or words that are not switches.
 *
 * @example startedHelperCommand('/proc/self/exe --type=utility', '/opt/google/chrome/chrome --type=utility', '/opt/google/chrome/chrome --headless') // true
 */
function startedHelperCommand(recorded: string, current: string, parentCommand: string): boolean {
  const executable = executableOf(parentCommand)
  if (executable === undefined) return false
  if (recorded === parentCommand) return [selfLink, executable].includes(firstWord(current))
  const named = firstWord(recorded) === selfLink ? `${executable}${recorded.slice(selfLink.length)}` : recorded
  if (firstWord(named) !== executable) return false
  if (current === named) return true
  return current.startsWith(`${named} `) && current.slice(named.length + 1).split(' ').every((word) => word.startsWith('--'))
}

// `ps` joins the arguments with spaces, so a command line's first word is its executable only where that path holds no
// space; a switch or nothing after it says so. macOS Chrome's paths hold spaces, and get no executable here.
function executableOf(command: string): string | undefined {
  const [first = '', next] = command.split(' ', 2)
  return first.startsWith('/') && first !== selfLink && (next === undefined || next.startsWith('--')) ? first : undefined
}

function firstWord(command: string): string {
  return command.split(' ', 1)[0] ?? ''
}

function sameBirth(record: OwnedProcessIdentity | undefined, current: OwnedProcessIdentity): boolean {
  return record !== undefined && record.pid === current.pid && record.startedAt === current.startedAt
}

function running(record: OwnedProcessIdentity): boolean {
  return record.state?.startsWith('Z') !== true
}

const processColumns = 'pid=,ppid=,pgid=,stat=,lstart=,args='

// The whole table, every column in one `ps` run, under the bound a whole table is read with; one pid is read under the
// usual bound.
const tableQuery: MetadataProcessOptions = { command: '/bin/ps', args: ['-ww', '-axo', processColumns], environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC0' }, outputLimit: processTableOutputLimit }

/** A fresh whole host table. A failed, empty or malformed reading never establishes absence. */
export function readProcessTable(deadline?: Deadline): readonly OwnedProcessIdentity[] {
  return parseProcessTable(readMetadataProcess({ ...tableQuery, deadline }))
}

/** The same whole table without holding the thread; keep the pending reading alive until it completes. */
export async function readProcessTableAsync(deadline?: Deadline): Promise<readonly OwnedProcessIdentity[]> {
  const holding = setInterval(() => undefined, 1000)
  try {
    return parseProcessTable(await readMetadataProcessAsync({ ...tableQuery, deadline }))
  } finally {
    clearInterval(holding)
  }
}

// `ps -p` exits 1 with no output when no listed pid exists, which a failed reading cannot be told apart from. Listing
// this process too keeps a successful reading for an absent pid, and this process is never one Retest records.
function oneProcessQuery(pid: number, deadline?: Deadline): MetadataProcessOptions {
  if (!Number.isSafeInteger(pid) || pid < 2) throw new RangeError('A process reading needs a valid pid.')
  return { command: '/bin/ps', args: ['-ww', '-o', processColumns, '-p', `${pid},${process.pid}`], environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC0' }, deadline }
}

function readOneProcess(pid: number, deadline?: Deadline): OwnedProcessIdentity | undefined {
  return parseProcessTable(readMetadataProcess(oneProcessQuery(pid, deadline))).find((entry) => entry.pid === pid)
}

async function readOneProcessAsync(pid: number, deadline?: Deadline): Promise<OwnedProcessIdentity | undefined> {
  return parseProcessTable(await readMetadataProcessAsync(oneProcessQuery(pid, deadline))).find((entry) => entry.pid === pid)
}

function checkDeadline(deadline: Deadline | undefined): void {
  if (deadline?.signal?.aborted === true || deadline?.reached === true) throw new Error('The ownership reading was not confirmed before its deadline ended or was cancelled.')
}

// Waits for a reading another caller started until this caller's deadline ends or is cancelled, and leaves the reading
// running for whoever else waits on it. Its timer holds no process open; the reading itself does while it runs.
function withinDeadline<T>(work: Promise<T>, deadline: Deadline | undefined): Promise<T> {
  if (deadline === undefined) return work
  const { signal } = deadline
  if (signal?.aborted === true) return Promise.reject(new Error('The ownership reading was not confirmed before its deadline ended or was cancelled.'))
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined
    const settle = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', ended)
    }
    function ended(): void {
      settle()
      reject(new Error('The ownership reading was not confirmed before its deadline ended or was cancelled.'))
    }
    timer = setTimeout(ended, deadline.waitToEndMs)
    timer.unref()
    signal?.addEventListener('abort', ended, { once: true })
    work.then((value) => { settle(); resolve(value) }, (error: unknown) => { settle(); reject(error) })
  })
}

function parseProcessTable(text: string): readonly OwnedProcessIdentity[] {
  const records: OwnedProcessIdentity[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const fields = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(line)
    if (fields === null) throw new Error('The host returned an unreadable process identity.')
    const [, pid, parentPid, groupId, state, startedAt, command] = fields
    if (pid === undefined || parentPid === undefined || groupId === undefined || state === undefined || startedAt === undefined || command === undefined) throw new Error('The host returned an incomplete process identity.')
    records.push({ pid: Number(pid), parentPid: Number(parentPid), groupId: Number(groupId), startedAt, command, state })
  }
  if (records.length === 0) throw new Error('The host returned no process identities.')
  return records
}
