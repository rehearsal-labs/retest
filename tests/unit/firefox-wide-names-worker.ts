import type { MetadataProcessRequest } from '../../src/shared/metadata-process.ts'
import { parentPort } from 'node:worker_threads'
import { metadataComplete, metadataFailure, metadataSuccess } from '../../src/shared/metadata-process.ts'

// A Mac whose processes carry long argv[0]s. macOS `comm` prints argv[0] whole, so the list of pids alone is longer
// than the shorter bound. Each query is answered as the metadata worker answers it: refused when its text is longer
// than the buffer the query shares.

/** The argv[0] of every fixture process: 1 MiB, so five of them pass 4 MiB. */
export const wideArgv0: string = `/fixture/${'w'.repeat(1024 * 1024)}`

const pids = [50_000_011, 50_000_012, 50_000_013, 50_000_014, 50_000_015, process.pid]
const parts = new Date(0).toUTCString().split(' ')
const startedAt = `${parts[0]?.replace(',', '')} ${parts[2]} ${parts[1]} ${parts[4]} ${parts[3]}`

parentPort?.on('message', (request: MetadataProcessRequest) => {
  const control = new Int32Array(request.control)
  const output = new Uint8Array(request.output)
  const asked = request.args.includes('-p') ? (request.args.at(-1) ?? '').split(',').map(Number) : pids
  const command = request.args.some((argument) => argument.endsWith('comm=')) ? wideArgv0 : `${wideArgv0} 60`
  const text = pids.filter((pid) => asked.includes(pid)).map((pid) => `${pid} 1 ${pid} S ${startedAt} ${command}`).join('\n')
  const encoded = new TextEncoder().encode(text)
  const fits = encoded.length <= output.byteLength
  const answer = fits ? encoded : new TextEncoder().encode('The metadata process exceeded its output limit.')
  output.set(answer)
  Atomics.store(control, 1, fits ? metadataSuccess : metadataFailure)
  Atomics.store(control, 2, answer.length)
  Atomics.store(control, 0, metadataComplete)
  Atomics.notify(control, 0)
})
