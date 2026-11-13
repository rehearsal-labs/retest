import type { MetadataProcessRequest } from '../../src/shared/metadata-process.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'
import { metadataOutputLimit, processTableOutputLimit, readMetadataProcessAsync, useMetadataWorkerModule } from '../../src/shared/metadata-process.ts'

const environment = { PATH: '/usr/bin:/bin' }

// Pages a run opens at once each start a whole-table reading while another is still being read. Each such reading once
// took a buffer of the whole 64 MiB table bound, which garbage collection does not count, so a long run's spent buffers
// piled up in memory. This file runs in a process of its own, so no earlier reading has left a buffer to reuse.
test('process-table readings in flight together claim memory for what they print, not their whole bound each', async (t) => {
  const restore = useMetadataWorkerModule(new URL('./metadata-gated-worker.ts', import.meta.url))
  t.after(restore)
  let worker: Worker | undefined
  const claimed: number[] = []
  const post = Worker.prototype.postMessage
  t.mock.method(Worker.prototype, 'postMessage', function (this: Worker, request: MetadataProcessRequest): void {
    worker = this
    claimed.push(request.output.byteLength)
    post.call(this, request)
  })
  const texts = Array.from({ length: 12 }, (_, index) => `reading ${index}`)
  const readings = texts.map((text) => readMetadataProcessAsync({ command: '/bin/echo', args: [text], environment, outputLimit: processTableOutputLimit }))
  assert.ok(worker !== undefined)
  post.call(worker, { release: true })
  assert.deepEqual(await Promise.all(readings), texts.map((text) => `${text}\n`))
  const total = claimed.reduce((sum, bytes) => sum + bytes, 0)
  assert.equal(claimed.length, 12)
  assert.ok(total <= metadataOutputLimit, `twelve readings of a few bytes each claimed ${total} bytes together`)
})
