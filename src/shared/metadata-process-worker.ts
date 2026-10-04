import type { ChildProcess } from 'node:child_process'
import type { MetadataProcessRequest } from './metadata-process.ts'
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { parentPort } from 'node:worker_threads'
import { metadataAbandoned, metadataComplete, metadataFailure, metadataOutputLimit, metadataPending, metadataRunning, metadataSuccess } from './metadata-process.ts'

// A failed child remains a refusal to launch more metadata processes until its actual exit is observed.
let unresolved: ChildProcess | undefined

parentPort?.on('message', (request: MetadataProcessRequest) => {
  const control = new Int32Array(request.control)
  if (Atomics.compareExchange(control, 0, metadataPending, metadataRunning) !== metadataPending) return
  const output = new Uint8Array(request.output)
  if (unresolved !== undefined) {
    finish(control, output, metadataFailure, 'An earlier metadata process has not been confirmed ended.')
    return
  }
  if (Atomics.load(control, 0) !== metadataRunning) return
  const deadline = performance.now() + request.timeoutMs
  let child: ChildProcess
  try {
    child = spawn(request.command, request.args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: request.environment })
  } catch {
    finish(control, output, metadataFailure, 'The metadata process could not start.')
    return
  }
  unresolved = child
  let settled = false
  let bytes = 0
  let stdoutBytes = 0
  const timer = setTimeout(() => fail('The metadata process did not answer before its deadline.'), Math.max(1, deadline - performance.now()))
  const release = (): void => { if (unresolved === child) unresolved = undefined }
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
    if (chunk.length > metadataOutputLimit - bytes) {
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
