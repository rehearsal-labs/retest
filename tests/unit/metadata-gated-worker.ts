import type { MetadataProcessRequest } from '../../src/shared/metadata-process.ts'
import { parentPort } from 'node:worker_threads'
import { metadataComplete, metadataPending, metadataRunning, metadataSuccess } from '../../src/shared/metadata-process.ts'

const waiting: MetadataProcessRequest[] = []
let released = false

function answer(request: MetadataProcessRequest): void {
  const control = new Int32Array(request.control)
  if (Atomics.compareExchange(control, 0, metadataPending, metadataRunning) !== metadataPending) return
  // Echoes the query's last argument, the text where `/bin/echo` or the Node script that stands in for it on Windows takes it.
  const text = new TextEncoder().encode(`${request.args.at(-1) ?? ''}\n`)
  new Uint8Array(request.output).set(text)
  Atomics.store(control, 1, metadataSuccess)
  Atomics.store(control, 2, text.length)
  Atomics.store(control, 0, metadataComplete)
  Atomics.notify(control, 0)
}

parentPort?.on('message', (message: MetadataProcessRequest | { release: true }) => {
  if ('release' in message) {
    released = true
    for (const request of waiting.splice(0)) answer(request)
  } else if (released) answer(message)
  else waiting.push(message)
})
