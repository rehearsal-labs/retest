import type { MetadataProcessRequest } from '../../src/shared/metadata-process.ts'
import { execFile } from 'node:child_process'
import { parentPort } from 'node:worker_threads'
import { metadataComplete, metadataFailure, metadataPending, metadataRunning, metadataSuccess } from '../../src/shared/metadata-process.ts'

// A metadata worker on a loaded host: it reads a whole process table, or a job's members, only 300 ms after it is asked,
// answers a query to `/bin/sleep`, or one that names `stuck`, never, as a stuck reading would not, and answers anything
// else at once by running it.
const tableDelayMs = 300

function finish(request: MetadataProcessRequest, status: number, text: string): void {
  const control = new Int32Array(request.control)
  if (Atomics.load(control, 0) !== metadataRunning) return
  const bytes = new TextEncoder().encode(text)
  new Uint8Array(request.output).set(bytes)
  Atomics.store(control, 1, status)
  Atomics.store(control, 2, bytes.length)
  if (Atomics.compareExchange(control, 0, metadataRunning, metadataComplete) === metadataRunning) Atomics.notify(control, 0)
}

function run(request: MetadataProcessRequest): void {
  const control = new Int32Array(request.control)
  if (Atomics.compareExchange(control, 0, metadataPending, metadataRunning) !== metadataPending) return
  if (request.command === '/bin/sleep' || request.args.includes('stuck')) return
  execFile(request.command, [...request.args], { env: { ...request.environment }, maxBuffer: request.output.byteLength }, (error, stdout) => {
    finish(request, error === null ? metadataSuccess : metadataFailure, error === null ? stdout : 'The metadata process ended without a successful reading.')
  })
}

parentPort?.on('message', (request: MetadataProcessRequest) => {
  setTimeout(() => run(request), request.args.includes('-axo') || request.args.includes('members') ? tableDelayMs : 0)
})
