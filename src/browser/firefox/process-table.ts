import type { Deadline } from '../../protocol/deadline.ts'
import type { OwnedProcessIdentity } from '../../shared/process-ownership.ts'
import { processTableOutputLimit, readMetadataProcess, readMetadataProcessAsync } from '../../shared/metadata-process.ts'

const processTableQuery = {
  command: '/bin/ps',
  args: ['-ww', '-axo', 'pid=,ppid=,pgid=,stat=,lstart=,args='],
  environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC0' },
}

// Keep full command lines for ownership. Several hosts can have enough long arguments to exceed the shared
// metadata reader's output bound in one query, so list pids first and read their identities in bounded groups.
const identityBatchSize = 512
// The list of pids is a whole-table reading too and takes that bound: macOS `comm` prints a process's argv[0] whole,
// which may be as long as its arguments, so on a Mac this list alone can pass the shorter bound.
const initialIdentitiesQuery = { ...processTableQuery, args: ['-axo', 'pid=,ppid=,pgid=,stat=,lstart=,comm='], outputLimit: processTableOutputLimit }
let pendingTable: Promise<OwnedProcessIdentity[]> | undefined

/** Liveness and birth facts do not need command arguments; this reading cannot grant authority to signal a pid. */
export async function readProcessLivenessAsync(deadline?: Deadline): Promise<OwnedProcessIdentity[]> {
  const pending = setInterval(() => {}, 1000)
  try {
    return parseProcessTable(await readMetadataProcessAsync({ ...initialIdentitiesQuery, deadline }))
  } finally {
    clearInterval(pending)
  }
}

/**
 * Every process on the machine as `ps` lists it: id, parent, process group, state, start time and command line.
 * If a bounded batch loses a pid meanwhile, its initial kernel command and liveness remain, so that row cannot prove
 * absence. Signals still require a fresh per-pid identity rather than relying on this snapshot.
 * Throws when the table cannot be read; an unreadable table never counts as an empty one.
 *
 * @example readProcessTable().filter((entry) => entry.groupId === firefox.pid)
 */
export function readProcessTable(deadline?: Deadline): OwnedProcessIdentity[] {
  try { return parseProcessTable(readMetadataProcess({ ...processTableQuery, deadline })) } catch (error) { requireSizeRefusal(error) }
  const initial = parseProcessTable(readMetadataProcess({ ...initialIdentitiesQuery, deadline }))
  return combineIdentities(initial, identityQueries(initial).map((query) => readIdentityBatch(query, deadline)))
}

/**
 * `readProcessTable` taken without holding the thread: a full `ps` takes tens of milliseconds, so anything that looks
 * while a Firefox is alive reads this way, and the BiDi connection and the browser go on meanwhile.
 *
 * @example (await readProcessTableAsync()).some((entry) => entry.pid === firefox.pid)
 */
export function readProcessTableAsync(deadline?: Deadline): Promise<OwnedProcessIdentity[]> {
  if (deadline !== undefined) return readTableAsync(deadline)
  pendingTable ??= readTableAsync().finally(() => { pendingTable = undefined })
  return pendingTable
}

async function readTableAsync(deadline?: Deadline): Promise<OwnedProcessIdentity[]> {
  // The shared worker is unreferenced, and an Atomics wait alone does not keep Node alive. Ownership must finish
  // even when launch is the only awaited work; retain a handle only for this bounded reading.
  const pending = setInterval(() => {}, 1000)
  try {
    try { return parseProcessTable(await readMetadataProcessAsync({ ...processTableQuery, deadline })) } catch (error) { requireSizeRefusal(error) }
    const initial = parseProcessTable(await readMetadataProcessAsync({ ...initialIdentitiesQuery, deadline }))
    const batches = identityQueries(initial)
    const readings: OwnedProcessIdentity[][] = []
    for (let offset = 0; offset < batches.length; offset += 4) {
      readings.push(...await Promise.all(batches.slice(offset, offset + 4).map((query) => readIdentityBatchAsync(query, deadline))))
    }
    return combineIdentities(initial, readings)
  } finally {
    clearInterval(pending)
  }
}

function identityQueries(initial: readonly OwnedProcessIdentity[]): (typeof processTableQuery)[] {
  const pids = initial.map((entry) => entry.pid)
  const batches: (typeof processTableQuery)[] = []
  for (let offset = 0; offset < pids.length; offset += identityBatchSize) {
    // Listing this reader keeps a successful answer when every pid of a batch has since exited.
    const requested = [...new Set([...pids.slice(offset, offset + identityBatchSize), process.pid])]
    batches.push({ ...processTableQuery, args: ['-ww', '-o', 'pid=,ppid=,pgid=,stat=,lstart=,args=', '-p', requested.join(',')] })
  }
  return batches
}

function combineIdentities(initial: readonly OwnedProcessIdentity[], readings: readonly (readonly OwnedProcessIdentity[])[]): OwnedProcessIdentity[] {
  const records = new Map(initial.map((entry) => [entry.pid, entry]))
  // Keep the first reading's liveness and ancestry even when a pid exits during a later batch. Dropping that row
  // could falsely prove a group empty while a child it just created is not in the first list yet.
  for (const entry of readings.flat()) {
    const earlier = records.get(entry.pid)
    if (earlier !== undefined && earlier.startedAt === entry.startedAt) records.set(entry.pid, { ...earlier, command: entry.command })
  }
  return [...records.values()]
}

function smallerQueries(query: typeof processTableQuery, error: unknown): (typeof processTableQuery)[] {
  requireSizeRefusal(error)
  const pids = (query.args[query.args.length - 1] ?? '').split(',').filter((pid) => pid !== String(process.pid))
  if (pids.length < 2) throw error
  const middle = Math.ceil(pids.length / 2)
  return [pids.slice(0, middle), pids.slice(middle)].map((part) => ({ ...query, args: [...query.args.slice(0, -1), [...part, process.pid].join(',')] }))
}

function requireSizeRefusal(error: unknown): void {
  if (!(error instanceof Error) || error.message !== 'The metadata process exceeded its output limit.') throw error
}

function readIdentityBatch(query: typeof processTableQuery, deadline?: Deadline): OwnedProcessIdentity[] {
  try {
    return parseProcessTable(readMetadataProcess({ ...query, deadline }))
  } catch (error) {
    return smallerQueries(query, error).flatMap((part) => readIdentityBatch(part, deadline))
  }
}

async function readIdentityBatchAsync(query: typeof processTableQuery, deadline?: Deadline): Promise<OwnedProcessIdentity[]> {
  try {
    return parseProcessTable(await readMetadataProcessAsync({ ...query, deadline }))
  } catch (error) {
    // Only an explicit size refusal splits a reading. No unreadable or failed table is treated as missing processes.
    const readings: OwnedProcessIdentity[][] = []
    for (const part of smallerQueries(query, error)) readings.push(await readIdentityBatchAsync(part, deadline))
    return readings.flat()
  }
}

function parseProcessTable(text: string): OwnedProcessIdentity[] {
  const records: OwnedProcessIdentity[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const fields = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(line)
    const [, pid, parentPid, groupId, state, startedAt, command] = fields ?? []
    if (pid === undefined || parentPid === undefined || groupId === undefined || state === undefined || startedAt === undefined || command === undefined) {
      throw new Error('The host returned an unreadable process identity.')
    }
    records.push({ pid: Number(pid), parentPid: Number(parentPid), groupId: Number(groupId), startedAt, command, state })
  }
  if (records.length === 0) throw new Error('The host returned no process identities.')
  return records
}

/** Whether a process is still running: present and not a zombie that only waits to be reaped. */
export function isRunning(entry: OwnedProcessIdentity): boolean {
  return entry.state?.startsWith('Z') !== true
}

/** A fresh reading of one pid and this reader, used immediately before signalling a recorded process. */
export function readProcessIdentity(pid: number, deadline?: Deadline): OwnedProcessIdentity | undefined {
  const text = readMetadataProcess({ ...processTableQuery, args: ['-ww', '-o', 'pid=,ppid=,pgid=,stat=,lstart=,args=', '-p', `${pid},${process.pid}`], deadline })
  return parseProcessTable(text).find((entry) => entry.pid === pid)
}

/** The fresh pre-signal identity read, awaited within the caller's cleanup budget. */
export async function readProcessIdentityAsync(pid: number, deadline?: Deadline): Promise<OwnedProcessIdentity | undefined> {
  const text = await readMetadataProcessAsync({ ...processTableQuery, args: ['-ww', '-o', 'pid=,ppid=,pgid=,stat=,lstart=,args=', '-p', `${pid},${process.pid}`], deadline })
  return parseProcessTable(text).find((entry) => entry.pid === pid)
}
