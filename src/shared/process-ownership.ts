import { errorMessage } from '../protocol/failures.ts'
import { errorCode } from './error-code.ts'
import { readMetadataProcess } from './metadata-process.ts'

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
  read(): readonly OwnedProcessIdentity[]
  signal(pid: number, signal: NodeJS.Signals | 0): void
}

/** Signal failures stay failures; identity refusals can be reconciled only by a later proof of absence. */
export type ProcessSignalReport = {
  readonly problems: readonly string[]
  readonly identityRefusals: readonly string[]
}

const host: ProcessOwnershipSystem = {
  read: readProcesses,
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
  capture(): string[] {
    if (this.#retired) return []
    const initial = !this.#initialized
    this.#initialized = true
    let processes: readonly OwnedProcessIdentity[]
    try {
      processes = this.#system.read()
    } catch (error) {
      return [this.#failedRead(error)]
    }
    const root = processes.find((entry) => entry.pid === this.#pid)
    if (initial) {
      if (root === undefined) {
        this.#initialProcessAbsent = true
        return [`Launched process ${this.#pid} could not be recorded before it exited.`]
      }
      if (root.parentPid !== this.#parentPid) return [`Process ${this.#pid} is not the launched child, so it was not claimed.`]
      this.#records.set(root.pid, root)
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
    const reusedGroup = root !== undefined && this.#records.has(this.#pid) && !sameBirth(this.#records.get(this.#pid), root)
    const unknown = reusedGroup ? [] : processes.filter((entry) => running(entry) && entry.groupId === this.#pid && !sameBirth(this.#records.get(entry.pid), entry))
    for (const entry of unknown) this.#unowned.set(entry.pid, entry)
    if (unknown.length > 0) return [`Process group ${this.#pid} contains processes whose launch ownership could not be verified; they were left alone.`]
    return []
  }

  /** A fresh identity is returned only for a process already recorded through verified launch ancestry. */
  verifiedIdentity(pid: number = this.#pid): OwnedProcessIdentity | undefined {
    if (this.#retired) return undefined
    const record = this.#records.get(pid)
    if (record === undefined) return undefined
    try {
      const current = this.#system.read().find((entry) => entry.pid === pid)
      return current !== undefined && running(current) && sameProcess(record, current) ? current : undefined
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

  /** Rechecks each exact command and start reading immediately before signaling the recorded pid. */
  signalReport(signal: NodeJS.Signals): ProcessSignalReport {
    if (this.#retired) return { problems: [], identityRefusals: [] }
    const problems = this.capture()
    const identityRefusals: string[] = []
    for (const record of [...this.#records.values()].reverse()) {
      let current: OwnedProcessIdentity | undefined
      try {
        current = this.#system.read().find((entry) => entry.pid === record.pid)
      } catch (error) {
        this.#failedRead(error)
        problems.push(`Could not verify recorded process ${record.pid}, so it was not signaled: ${errorMessage(error)}`)
        break
      }
      if (current === undefined || !running(current)) continue
      if (!sameProcess(record, current)) {
        const changes = [
          ...(record.startedAt === current.startedAt ? [] : ['start reading changed']),
          ...(record.command === current.command ? [] : ['command reading changed']),
        ]
        const parent = this.#records.get(record.parentPid)
        const ancestry = parent === undefined ? 'parent command was not recorded' : record.command === parent.command ? 'original command matched its recorded parent' : 'original command differed from its recorded parent'
        const role = record.pid === this.#pid ? 'launch root' : 'recorded descendant'
        const recordedState = /^[A-Z]/.test(record.state ?? '') ? record.state?.[0] : 'unavailable'
        const currentState = /^[A-Z]/.test(current.state ?? '') ? current.state?.[0] : 'unavailable'
        identityRefusals.push(`Recorded process ${record.pid} has a different identity (${role}; ${changes.join(', ')}; host state ${recordedState} to ${currentState}; ${ancestry}), so it was left alone.`)
        continue
      }
      try {
        this.#system.signal(record.pid, signal)
      } catch (error) {
        if (errorCode(error) !== 'ESRCH') problems.push(`Could not signal recorded process ${record.pid}: ${errorMessage(error)}`)
      }
    }
    return { problems, identityRefusals }
  }

  /** Keeps every failure and identity refusal visible to callers that do not reconcile a later full absence. */
  signal(signal: NodeJS.Signals): string[] {
    const report = this.signalReport(signal)
    return [...report.problems, ...report.identityRefusals]
  }

  /** The synchronous exit-hook path has exactly the same identity checks as ordinary cleanup. */
  signalNow(signal: NodeJS.Signals): string[] {
    return this.signal(signal)
  }

  /** A failed liveness reading holds the resource. Once observed gone, this owner never names these pids again. */
  remains(): boolean {
    if (this.#retired) return false
    let processes: readonly OwnedProcessIdentity[]
    try { processes = this.#system.read() } catch (error) { this.#failedRead(error); return true }
    // A failed first reading never grants signal authority, and an empty ledger is no proof that the launched
    // child ended. Until its pid and group are absent, that unresolved launch continues to hold its resource.
    if (this.#records.size === 0 && processes.some((entry) => running(entry) && (entry.pid === this.#pid || entry.groupId === this.#pid))) return true
    const root = processes.find((entry) => entry.pid === this.#pid)
    const reusedGroup = root !== undefined && this.#records.has(this.#pid) && !sameBirth(this.#records.get(this.#pid), root)
    if (!reusedGroup) for (const current of processes) {
      if (running(current) && current.groupId === this.#pid && !sameBirth(this.#records.get(current.pid), current)) this.#unowned.set(current.pid, current)
    }
    for (const current of processes) if (running(current) && (sameBirth(this.#records.get(current.pid), current) || sameBirth(this.#unowned.get(current.pid), current))) return true
    this.#retired = true
    return false
  }
}

function sameProcess(record: OwnedProcessIdentity | undefined, current: OwnedProcessIdentity): boolean {
  return sameBirth(record, current) && record?.command === current.command
}

function sameBirth(record: OwnedProcessIdentity | undefined, current: OwnedProcessIdentity): boolean {
  return record !== undefined && record.pid === current.pid && record.startedAt === current.startedAt
}

function running(record: OwnedProcessIdentity): boolean {
  return record.state?.startsWith('Z') !== true
}

function readProcesses(): readonly OwnedProcessIdentity[] {
  const text = readMetadataProcess({
    command: '/bin/ps', args: ['-ww', '-axo', 'pid=,ppid=,pgid=,stat=,lstart=,args='],
    environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
  })
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
