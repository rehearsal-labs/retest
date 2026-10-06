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
  #revision = 0

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
    return this.#captureFrom(processes)
  }

  /**
   * `capture` from a reading taken without holding the thread, for recording a new process while other work goes on.
   * The reading is a moment old when it is applied, which only adds records with their start times; every signal still
   * reads its pid fresh. A reading that fails records nothing and is not kept as a read problem, since it decides
   * nothing and the next `capture` reads again. With a cleanup deadline, failures are retained. A newer applied
   * snapshot wins over an outstanding background reading. Before the first `capture`, or on a system without
   * `readAsync`, it is `capture` itself.
   */
  async captureAsync(deadline?: Deadline): Promise<string[]> {
    if (this.#retired) return []
    const readAsync = this.#system.readAsync
    if (!this.#initialized || readAsync === undefined) return this.capture(deadline)
    const revision = this.#revision
    let processes: readonly OwnedProcessIdentity[]
    try {
      checkDeadline(deadline)
      processes = await readAsync.call(this.#system, deadline)
      checkDeadline(deadline)
    } catch (error) {
      return deadline === undefined ? [] : [this.#failedRead(error)]
    }
    return this.#retired || revision !== this.#revision ? [] : this.#captureFrom(processes)
  }

  #captureFrom(processes: readonly OwnedProcessIdentity[]): string[] {
    this.#revision += 1
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
    const owned = new Set(processes.filter((entry) => running(entry) && sameProcess(this.#records.get(entry.pid), entry)).map((entry) => entry.pid))
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
        this.#revision += 1
        return undefined
      }
      if (!sameProcess(record, current)) return undefined
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
    const problems = this.#captureFrom(processes)
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

  /** Ordinary cleanup uses asynchronous readings; each signal still immediately follows its own fresh identity. */
  async signalReportAsync(signal: NodeJS.Signals, deadline?: Deadline): Promise<ProcessSignalReport> {
    if (this.#retired) return { problems: [], identityRefusals: [] }
    let processes: readonly OwnedProcessIdentity[]
    try {
      checkDeadline(deadline)
      processes = await this.#readFreshTableAsync(deadline)
      checkDeadline(deadline)
    } catch (error) {
      this.#initialized = true
      return { problems: [this.#failedRead(error)], identityRefusals: [] }
    }
    if (this.#retired) return { problems: [], identityRefusals: [] }
    const problems = this.#captureFrom(processes)
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
      this.#revision += 1
      return
    }
    if (!sameProcess(record, current)) {
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

  #readNow(pid: number, deadline?: Deadline): OwnedProcessIdentity | undefined {
    if (this.#system.readProcess !== undefined) return this.#system.readProcess(pid, deadline)
    return this.#system.read(deadline).find((entry) => entry.pid === pid)
  }

  #readTableAsync(deadline?: Deadline): Promise<readonly OwnedProcessIdentity[]> {
    return this.#system.readAsync === undefined ? Promise.resolve(this.#system.read(deadline)) : this.#system.readAsync(deadline)
  }

  async #readFreshTableAsync(deadline?: Deadline): Promise<readonly OwnedProcessIdentity[]> {
    for (;;) {
      checkDeadline(deadline)
      const revision = this.#revision
      const processes = await this.#readTableAsync(deadline)
      checkDeadline(deadline)
      if (revision === this.#revision) return processes
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
    return this.#remainsFrom(processes)
  }

  /** A failed or deadline-limited reading retains the resource, just as the synchronous exit-hook reading does. */
  async remainsAsync(deadline?: Deadline): Promise<boolean> {
    if (this.#retired) return false
    let processes: readonly OwnedProcessIdentity[]
    try {
      checkDeadline(deadline)
      processes = await this.#readFreshTableAsync(deadline)
      checkDeadline(deadline)
    } catch (error) { this.#failedRead(error); return true }
    return this.#retired ? false : this.#remainsFrom(processes)
  }

  #remainsFrom(processes: readonly OwnedProcessIdentity[]): boolean {
    this.#revision += 1
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
