import type { Deadline } from '../protocol/deadline.ts'
import { performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'

/** A bounded metadata query. A failed or unanswered query never signals its child. */
export type MetadataProcessOptions = {
  readonly command: string
  readonly args: readonly string[]
  readonly environment: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  /** A caller's remaining budget includes worker startup and queueing, not just the child's reading. */
  readonly deadline?: Deadline | undefined
  /**
   * The most bytes the query may print, stdout and stderr together: `metadataOutputLimit` unless set, and at most
   * `processTableOutputLimit`, which a reading of the whole process table asks for. A query that prints more fails.
   */
  readonly outputLimit?: number
}

/** Shared with the worker; output is valid only after its complete state is observed. */
export type MetadataProcessRequest = {
  readonly command: string
  readonly args: readonly string[]
  readonly environment: Readonly<Record<string, string>>
  readonly timeoutMs: number
  /** Absolute monotonic time, including the worker's time origin, when the caller must stop waiting. */
  readonly deadline?: number
  readonly control: SharedArrayBuffer
  readonly output: SharedArrayBuffer
}

export const metadataOutputLimit: number = 4 * 1024 * 1024
/**
 * The variable each metadata process finds the time its query is given up at in, as milliseconds since the epoch, for a
 * program that must change nothing once its answer can no longer be heard, as the stand-in supervisor the tests run.
 */
export const metadataDeadlineVariable = 'RETEST_METADATA_DEADLINE_MS'
/**
 * The bound a whole process table is read under. A `ps -ww` table passed 4 MiB on a busy Mac (4.53 MB with about 3,600
 * processes), and a table refused for its size leaves every ownership decision without a reading, so nothing could be
 * started or ended. At that 1.3 KB a line, a table of kern.maxproc's 9,000 processes is under 12 MiB. A larger table is
 * still refused, as an unreadable one; it is never cut. The buffer is committed only as far as it is written.
 */
export const processTableOutputLimit: number = 64 * 1024 * 1024
export const metadataPending: number = 0
export const metadataRunning: number = 1
export const metadataComplete: number = 2
export const metadataAbandoned: number = 3
/** The worker was ended for another query before it answered this one, which is asked again of a fresh worker. */
export const metadataWorkerEnded: number = 4
export const metadataSuccess: number = 0
export const metadataFailure: number = 1

const queryLimitMs = 5000
const workerAllowanceMs = 1000
// How many fresh workers one query is asked of after workers it was posted to ended by themselves before answering
// anything, as one whose module cannot load does, which would otherwise be replaced as fast as each one ends.
const workerRetries = 2
// One spare of each production capacity. Only a completed query can return its buffer: an abandoned worker may
// still be writing, and a concurrent query must hold a different buffer until its completion signal is consumed.
const spareOutputs = new Map<number, SharedArrayBuffer>()
// Queries posted and not yet settled. A worker ended for one query fails the others it holds at once, rather than
// leaving each to wait out its whole bound for an answer that cannot come.
const inFlight = new Set<Query>()
let bridge: Worker | undefined
// Workers that answered a query, and workers ended here for a query other than the one asking again; an ending of
// either says nothing against the next worker.
const answered = new WeakSet<Worker>()
const endedForAnother = new WeakSet<Worker>()
let workerModule: URL = new URL(import.meta.url.endsWith('.ts') ? './metadata-process-worker.ts' : './metadata-process-worker.js', import.meta.url)

/**
 * A synchronous bridge for fresh ownership readings, including exit hooks. The worker uses an asynchronous child
 * and bounds its output and time itself, so Node's synchronous-child timeout never kills an unrecorded process.
 * A query the worker failed to answer fails alone: that worker is ended and the next query starts a fresh one, so one
 * stall under load never leaves a long-lived host without readings, and so without the right to signal anything. A
 * query the ended worker still held is asked again of the fresh one, within its own caller's deadline.
 */
export function readMetadataProcess(options: MetadataProcessOptions): string {
  let query = submit(options)
  try {
    for (;;) {
      checkCaller(query, options.deadline)
      const state = Atomics.load(query.control, 0)
      if (state === metadataComplete) return answer(query)
      if (state === metadataWorkerEnded) {
        settle(query)
        query = askAgain(query, options)
        continue
      }
      const remaining = query.deadline - performance.now()
      if (remaining <= 0) {
        if (abandoned(query)) throw new Error('The metadata worker did not answer the query.')
        continue
      }
      Atomics.wait(query.control, 0, state, remaining)
    }
  } finally {
    settle(query)
  }
}

/**
 * The same bounded reading through the same worker, waited for without holding the thread, for a caller that can wait,
 * such as one recording a page's new process while the test goes on. An exit hook, which cannot wait, reads with
 * `readMetadataProcess`.
 *
 * @example const text = await readMetadataProcessAsync({ command: '/bin/ps', args: ['-axo', 'pid='], environment: { PATH: '/usr/bin:/bin' } })
 */
export async function readMetadataProcessAsync(options: MetadataProcessOptions): Promise<string> {
  let query = submit(options)
  const wake = (): void => { Atomics.notify(query.control, 0) }
  // Neither the unreferenced worker nor an Atomics wait keeps Node alive. Keep this bounded query awaited even when
  // it is the host's last work, including when a failed worker can no longer notify it.
  const pending = setInterval(() => {}, 1000)
  options.deadline?.signal?.addEventListener('abort', wake, { once: true })
  try {
    for (;;) {
      checkCaller(query, options.deadline)
      const state = Atomics.load(query.control, 0)
      if (state === metadataComplete) return answer(query)
      if (state === metadataWorkerEnded) {
        settle(query)
        query = askAgain(query, options)
        continue
      }
      const remaining = query.deadline - performance.now()
      if (remaining <= 0) {
        if (abandoned(query)) throw new Error('The metadata worker did not answer the query.')
        continue
      }
      const waiting = Atomics.waitAsync(query.control, 0, state, remaining)
      if (waiting.async) await waiting.value
    }
  } finally {
    settle(query)
    clearInterval(pending)
    options.deadline?.signal?.removeEventListener('abort', wake)
  }
}

function checkCaller(query: Query, deadline: Deadline | undefined): void {
  if (deadline?.signal?.aborted !== true && deadline?.reached !== true) return
  abandoned(query)
  throw new Error('The metadata query was not confirmed before its caller deadline ended or was cancelled.')
}

type Query = { readonly worker: Worker; readonly control: Int32Array; readonly output: SharedArrayBuffer; readonly deadline: number; readonly retries: number }

// A query whose worker ended is asked again of a fresh worker, within its own caller's deadline. Only a worker that
// ended by itself before it answered anything counts towards the query's few retries; a worker ended for another
// query, or one that had answered, is replaced as before.
function askAgain(query: Query, options: MetadataProcessOptions): Query {
  const broken = !answered.has(query.worker) && !endedForAnother.has(query.worker)
  if (!broken) return submit(options, query.retries)
  if (query.retries >= workerRetries) throw new Error('The metadata worker ended before it answered the query.')
  return submit(options, query.retries + 1)
}

function submit(options: MetadataProcessOptions, retries = 0): Query {
  if (options.deadline?.signal?.aborted === true || options.deadline?.reached === true) throw new Error('The metadata query was not started because its caller deadline ended or was cancelled.')
  const timeoutMs = options.timeoutMs ?? queryLimitMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > queryLimitMs) throw new RangeError('A metadata query needs a timeout between 1 and 5000 milliseconds.')
  const outputLimit = options.outputLimit ?? metadataOutputLimit
  if (!Number.isSafeInteger(outputLimit) || outputLimit < metadataOutputLimit || outputLimit > processTableOutputLimit) throw new RangeError(`A metadata query's output limit lies between ${metadataOutputLimit} and ${processTableOutputLimit} bytes.`)
  const worker = metadataWorker()
  const controlBuffer = new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT)
  const output = spareOutputs.get(outputLimit) ?? new SharedArrayBuffer(outputLimit)
  spareOutputs.delete(outputLimit)
  const control = new Int32Array(controlBuffer)
  const request: MetadataProcessRequest = {
    command: options.command, args: options.args, environment: { ...options.environment, TZ: 'UTC0' }, timeoutMs,
    control: controlBuffer, output,
    ...(options.deadline === undefined ? {} : { deadline: performance.timeOrigin + performance.now() + options.deadline.waitToEndMs }),
  }
  try {
    worker.postMessage(request)
  } catch {
    Atomics.store(control, 0, metadataAbandoned)
    discardWorker(worker)
    throw new Error('The metadata worker could not receive the query.')
  }
  const query = { worker, control, output, deadline: Math.min(performance.now() + timeoutMs + workerAllowanceMs, request.deadline === undefined ? Infinity : request.deadline - performance.timeOrigin), retries }
  inFlight.add(query)
  return query
}

function settle(query: Query): void {
  inFlight.delete(query)
  releaseOutput(query)
}

// Fails a query its worker can no longer answer, unless the answer came first, and wakes whoever waits on it.
function endedWorker(query: Query): void {
  for (;;) {
    const latest = Atomics.load(query.control, 0)
    if (latest === metadataComplete || latest === metadataAbandoned || latest === metadataWorkerEnded) return
    if (Atomics.compareExchange(query.control, 0, latest, metadataWorkerEnded) !== latest) continue
    Atomics.notify(query.control, 0)
    return
  }
}

// A reply completing at the deadline may be consumed; an abandoned queued request must never start later. True once the
// query is abandoned and its worker ended, false when the reply came first.
function abandoned(query: Query): boolean {
  for (;;) {
    const latest = Atomics.load(query.control, 0)
    if (latest === metadataComplete) return false
    if (Atomics.compareExchange(query.control, 0, latest, metadataAbandoned) !== latest) continue
    endedForAnother.add(query.worker)
    discardWorker(query.worker)
    return true
  }
}

function releaseOutput(query: Query): void {
  const capacity = query.output.byteLength
  if (Atomics.load(query.control, 0) !== metadataComplete) return
  if (capacity !== metadataOutputLimit && capacity !== processTableOutputLimit) return
  if (!spareOutputs.has(capacity)) spareOutputs.set(capacity, query.output)
}

function answer(query: Query): string {
  answered.add(query.worker)
  const length = Atomics.load(query.control, 2)
  if (length < 0 || length > query.output.byteLength) {
    discardWorker(query.worker)
    throw new Error('The metadata worker returned an invalid output length.')
  }
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(query.output, 0, length)) } catch {
    throw new Error('The metadata process returned unreadable text.')
  }
  if (Atomics.load(query.control, 1) !== metadataSuccess) throw new Error(text || 'The metadata process reading failed.')
  return text
}

/**
 * Starts later metadata workers from another module, as a test does to stand in a worker that stalls; the worker in use
 * is ended first. Returns the function that puts the previous module back.
 *
 * @example const restore = useMetadataWorkerModule(new URL('./stalled-worker.ts', import.meta.url))
 */
export function useMetadataWorkerModule(file: URL): () => void {
  const previous = workerModule
  workerModule = file
  if (bridge !== undefined) retire(bridge)
  return () => {
    workerModule = previous
    if (bridge !== undefined) retire(bridge)
  }
}

function metadataWorker(): Worker {
  if (bridge !== undefined) return bridge
  let worker: Worker
  try {
    // The worker runs one fixed module and needs none of the host's options. Inheriting them ends it at start under an
    // option that only the host's own entry may take, such as `--input-type` for `node -e`.
    worker = new Worker(workerModule, { execArgv: [] })
  } catch {
    throw new Error('The metadata worker could not start.')
  }
  worker.on('error', () => { discardWorker(worker) })
  worker.on('exit', () => {
    if (bridge === worker) bridge = undefined
    for (const query of inFlight) if (query.worker === worker) endedWorker(query)
  })
  worker.unref()
  bridge = worker
  return worker
}

// A worker set aside for a module swapped in, which says nothing against the worker after it.
function retire(worker: Worker): void {
  endedForAnother.add(worker)
  discardWorker(worker)
}

// The query that met the failure reports it; the next one starts a fresh worker, and the others it held are asked again.
function discardWorker(worker: Worker): void {
  if (bridge === worker) bridge = undefined
  for (const query of inFlight) if (query.worker === worker) endedWorker(query)
  // Ending a failed worker thread closes its pipes; its detached child is never sent a process signal.
  void worker.terminate().catch(() => {})
}
