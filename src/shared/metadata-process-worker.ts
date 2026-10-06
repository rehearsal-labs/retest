import type { ChildProcess } from 'node:child_process'
import type { MetadataProcessRequest } from './metadata-process.ts'
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { parentPort } from 'node:worker_threads'
import { metadataAbandoned, metadataComplete, metadataFailure, metadataPending, metadataRunning, metadataSuccess } from './metadata-process.ts'

// Children whose query failed, until each one's own exit is seen; none is ever signalled. A stuck one fails only its own
// query, and queries in flight at once are not counted, but while this many are outstanding later queries are refused, so
// stuck children cannot pile up.
const unresolved = new Set<ChildProcess>()
const unresolvedLimit = 4

parentPort?.on('message', (request: MetadataProcessRequest) => {
  const control = new Int32Array(request.control)
  if (Atomics.compareExchange(control, 0, metadataPending, metadataRunning) !== metadataPending) return
  const output = new Uint8Array(request.output)
  if (unresolved.size >= unresolvedLimit) {
    finish(control, output, metadataFailure, `${unresolved.size} earlier metadata processes that did not answer have not been confirmed ended.`)
    return
  }
  if (Atomics.load(control, 0) !== metadataRunning) return
  const deadline = Math.min(performance.now() + request.timeoutMs, request.deadline === undefined ? Infinity : request.deadline - performance.timeOrigin)
  if (performance.now() >= deadline) {
    finish(control, output, metadataFailure, 'The metadata query was not started because its caller deadline ended.')
    return
  }
  let child: ChildProcess
  try {
    child = spawn(request.command, request.args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...request.environment, TZ: 'UTC0' } })
  } catch {
    finish(control, output, metadataFailure, 'The metadata process could not start.')
    return
  }
  let closed = false
  let settled = false
  let bytes = 0
  let stdoutBytes = 0
  const timer = setTimeout(() => fail('The metadata process did not answer before its deadline.'), Math.max(1, deadline - performance.now()))
  const release = (): void => {
    closed = true
    unresolved.delete(child)
  }
  const stopReading = (): void => {
    child.stdout?.destroy()
    child.stderr?.destroy()
    child.unref()
  }
  const fail = (message: string): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    stopReading()
    if (!closed) unresolved.add(child)
    finish(control, output, metadataFailure, message)
  }
  const read = (chunk: Buffer, stdout: boolean): void => {
    if (settled) return
    if (Atomics.load(control, 0) === metadataAbandoned) {
      fail('The metadata process query was abandoned.')
      return
    }
    if (performance.now() >= deadline) {
      fail('The metadata process did not answer before its deadline.')
      return
    }
    // Each query brings its own bound, as the size of the buffer it shares.
    if (chunk.length > output.byteLength - bytes) {
      fail('The metadata process exceeded its output limit.')
      return
    }
    bytes += chunk.length
    if (stdout) {
      output.set(chunk, stdoutBytes)
      stdoutBytes += chunk.length
    }
  }
  child.stdout?.on('data', (chunk: Buffer) => { read(chunk, true) })
  child.stderr?.on('data', (chunk: Buffer) => { read(chunk, false) })
  child.stdout?.on('error', () => { fail('The metadata process output could not be read.') })
  child.stderr?.on('error', () => { fail('The metadata process output could not be read.') })
  child.on('error', () => {
    if (child.pid === undefined) release()
    fail('The metadata process could not run.')
  })
  child.once('close', (code, signal) => {
    release()
    if (settled) return
    if (performance.now() >= deadline) {
      fail('The metadata process did not answer before its deadline.')
      return
    }
    if (code !== 0 || signal !== null) {
      fail('The metadata process ended without a successful reading.')
      return
    }
    settled = true
    clearTimeout(timer)
    Atomics.store(control, 1, metadataSuccess)
    Atomics.store(control, 2, stdoutBytes)
    if (Atomics.compareExchange(control, 0, metadataRunning, metadataComplete) === metadataRunning) Atomics.notify(control, 0)
  })
})

function finish(control: Int32Array, output: Uint8Array, status: number, message: string): void {
  if (Atomics.load(control, 0) === metadataAbandoned) return
  const bytes = new TextEncoder().encode(message)
  output.set(bytes)
  Atomics.store(control, 1, status)
  Atomics.store(control, 2, bytes.length)
  if (Atomics.compareExchange(control, 0, metadataRunning, metadataComplete) === metadataRunning) Atomics.notify(control, 0)
}
