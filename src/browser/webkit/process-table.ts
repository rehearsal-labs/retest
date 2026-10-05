import type { Deadline } from '../../protocol/deadline.ts'
import type { MetadataProcessOptions } from '../../shared/metadata-process.ts'
import type { OwnedProcessIdentity, ProcessOwnershipSystem } from '../../shared/process-ownership.ts'
import { processTableOutputLimit, readMetadataProcess, readMetadataProcessAsync } from '../../shared/metadata-process.ts'

const columns = 'pid=,ppid=,pgid=,stat=,lstart=,args='
const query: MetadataProcessOptions = { command: '/bin/ps', args: ['-ww', '-axo', columns], environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC0' }, outputLimit: processTableOutputLimit }
const one = (pid: number, deadline?: Deadline): MetadataProcessOptions => {
  if (!Number.isSafeInteger(pid) || pid < 2) throw new RangeError('A WebKit process reading needs a valid pid.')
  return { command: query.command, environment: query.environment, args: ['-ww', '-o', columns, '-p', `${pid},${process.pid}`], deadline }
}

function identities(text: string): OwnedProcessIdentity[] {
  const records = text.split('\n').filter((line) => line.trim() !== '').map((line) => {
    const fields = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(line)
    const [, pid, parentPid, groupId, state, startedAt, command] = fields ?? []
    if (pid === undefined || parentPid === undefined || groupId === undefined || state === undefined || startedAt === undefined || command === undefined) throw new Error('The host returned an unreadable WebKit process identity.')
    return { pid: Number(pid), parentPid: Number(parentPid), groupId: Number(groupId), state, startedAt, command }
  })
  if (records.length === 0) throw new Error('The host returned no WebKit process identities.')
  return records
}

const host: ProcessOwnershipSystem = {
  read: (deadline) => identities(readMetadataProcess({ ...query, deadline })),
  readAsync: async (deadline) => identities(await readMetadataProcessAsync({ ...query, deadline })),
  readProcess: (pid, deadline) => identities(readMetadataProcess(one(pid, deadline))).find((entry) => entry.pid === pid),
  readProcessAsync: async (pid, deadline) => identities(await readMetadataProcessAsync(one(pid, deadline))).find((entry) => entry.pid === pid),
  signal: (pid, signal) => { process.kill(pid, signal) },
}

/** Shares one awaited snapshot across a synchronous liveness pass over recorded launchd helpers. */
export class WebKitProcessTable implements ProcessOwnershipSystem {
  readonly #system: ProcessOwnershipSystem
  #held: { processes: readonly OwnedProcessIdentity[] } | { failure: unknown } | undefined

  constructor(system: ProcessOwnershipSystem = host) { this.#system = system }

  async during<T>(work: () => T, deadline?: Deadline): Promise<T> {
    let held: { processes: readonly OwnedProcessIdentity[] } | { failure: unknown }
    try { held = { processes: await this.readAsync(deadline) } } catch (failure) { held = { failure } }
    this.#held = held
    try { return work() } finally { this.#held = undefined }
  }

  duringNow<T>(work: () => T, deadline?: Deadline): T {
    const previous = this.#held
    try {
      try { this.#held = { processes: this.#system.read(deadline) } } catch (failure) { this.#held = { failure } }
      return work()
    } finally { this.#held = previous }
  }

  read(deadline?: Deadline): readonly OwnedProcessIdentity[] {
    if (this.#held === undefined) return this.#system.read(deadline)
    if ('failure' in this.#held) throw this.#held.failure
    return this.#held.processes
  }

  async readAsync(deadline?: Deadline): Promise<readonly OwnedProcessIdentity[]> {
    return this.#system.readAsync === undefined ? this.#system.read(deadline) : this.#system.readAsync(deadline)
  }

  readProcess(pid: number, deadline?: Deadline): OwnedProcessIdentity | undefined {
    return this.#system.readProcess === undefined ? this.#system.read(deadline).find((entry) => entry.pid === pid) : this.#system.readProcess(pid, deadline)
  }

  async readProcessAsync(pid: number, deadline?: Deadline): Promise<OwnedProcessIdentity | undefined> {
    return this.#system.readProcessAsync === undefined ? this.readProcess(pid, deadline) : this.#system.readProcessAsync(pid, deadline)
  }

  signal(pid: number, signal: NodeJS.Signals | 0): void { this.#system.signal(pid, signal) }
}
