import assert from 'node:assert/strict'
import { test } from 'node:test'
import { worker } from './media-client-fixtures.ts'

for (const mode of ['truncated-prefix', 'truncated-header']) {
  test(`a clean child exit with ${mode} stdout rejects close as protocol failure`, async t => {
    const media = await worker(t, mode)
    await assert.rejects(media.close(500), /truncated|incomplete/i)
  })
}
