import { performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'

/** A bounded metadata query. A failed or unanswered query never signals its child. */
export type MetadataProcessOptions = {
  readonly command: string
  readonly args: readonly string[]
  readonly environment: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

/** Shared with the worker; output is valid only after its complete state is observed. */
export type MetadataProcessRequest = {
  readonly command: string
  readonly args: readonly string[]
  readonly environment: Readonly<Record<string, string>>
  readonly timeoutMs: number
  readonly control: SharedArrayBuffer
  readonly output: SharedArrayBuffer
}

export const metadataOutputLimit: number = 4 * 1024 * 1024
export const metadataPending: number = 0
export const metadataRunning: number = 1
export const metadataComplete: number = 2
export const metadataAbandoned: number = 3
export const metadataSuccess: number = 0
export const metadataFailure: number = 1

const queryLimitMs = 5000
const workerAllowanceMs = 1000
let bridge: Worker | undefined
let bridgeFailure: string | undefined

/**
 * A synchronous bridge for fresh ownership readings, including exit hooks. The worker uses an asynchronous child
 * and bounds its output and time itself, so Node's synchronous-child timeout never kills an unrecorded process.
 */
export function readMetadataProcess(options: MetadataProcessOptions): string {
  const timeoutMs = options.timeoutMs ?? queryLimitMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > queryLimitMs) throw new RangeError('A metadata query needs a timeout between 1 and 5000 milliseconds.')
  if (bridgeFailure !== undefined) throw new Error(bridgeFailure)
  const worker = metadataWorker()
  const controlBuffer = new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT)
  const outputBuffer = new SharedArrayBuffer(metadataOutputLimit)
  const control = new Int32Array(controlBuffer)
  const request: MetadataProcessRequest = {
    command: options.command, args: options.args, environment: options.environment, timeoutMs,
    control: controlBuffer, output: outputBuffer,
  }
  const deadline = performance.now() + timeoutMs + workerAllowanceMs
  try {
    worker.postMessage(request)
  } catch {
    Atomics.store(control, 0, metadataAbandoned)
    discardWorker(worker, 'The metadata worker could not receive the query.')
    throw new Error(bridgeFailure)
  }
  waiting: for (;;) {
    const state = Atomics.load(control, 0)
    if (state === metadataComplete) break
    const remaining = deadline - performance.now()
    if (remaining <= 0) {
      // A reply completing at the deadline may be consumed; an abandoned queued request must never start later.
      for (;;) {
        const latest = Atomics.load(control, 0)
        if (latest === metadataComplete) break waiting
        if (Atomics.compareExchange(control, 0, latest, metadataAbandoned) !== latest) continue
        discardWorker(worker, 'The metadata worker did not answer the query.')
        throw new Error(bridgeFailure)
      }
    }
    Atomics.wait(control, 0, state, remaining)
  }
  const length = Atomics.load(control, 2)
  if (length < 0 || length > metadataOutputLimit) {
    discardWorker(worker, 'The metadata worker returned an invalid output length.')
    throw new Error(bridgeFailure)
  }
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(outputBuffer, 0, length)) } catch {
    throw new Error('The metadata process returned unreadable text.')
  }
  if (Atomics.load(control, 1) !== metadataSuccess) throw new Error(text || 'The metadata process reading failed.')
  return text
}

function metadataWorker(): Worker {
  if (bridge !== undefined) return bridge
  try {
    const file = import.meta.url.endsWith('.ts') ? './metadata-process-worker.ts' : './metadata-process-worker.js'
    const worker = new Worker(new URL(file, import.meta.url))
    worker.on('error', () => { discardWorker(worker, 'The metadata worker failed.') })
    worker.on('exit', () => {
      if (bridge === worker) {
        bridge = undefined
        bridgeFailure = 'The metadata worker ended before it could be used again.'
      }
    })
    worker.unref()
    bridge = worker
    return worker
  } catch {
    bridgeFailure = 'The metadata worker could not start.'
    throw new Error(bridgeFailure)
  }
}

function discardWorker(worker: Worker, message: string): void {
  if (bridge !== worker) return
  bridge = undefined
  bridgeFailure = message
  // Ending a failed worker thread closes its pipes; its detached child is never sent a process signal.
  void worker.terminate().catch(() => {})
}
