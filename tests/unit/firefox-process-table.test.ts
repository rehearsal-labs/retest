import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readProcessTable, readProcessTableAsync } from '../../src/browser/firefox/process-table.ts'
import { useMetadataWorkerModule } from '../../src/shared/metadata-process.ts'

for (const [name, read] of [['synchronous', readProcessTable], ['asynchronous', readProcessTableAsync]] as const) test(`a ${name} process table larger than one metadata reply retains every full identity through smaller bounded readings`, async () => {
  const restore = useMetadataWorkerModule(new URL('./firefox-table-worker.ts', import.meta.url))
  try {
    const entries = await read()
    assert.deepEqual(entries.map((entry) => entry.pid).sort((a, b) => a - b), [process.pid, 50_000_001, 50_000_002, 50_000_003, 50_000_004].sort((a, b) => a - b))
    assert.ok(entries.every((entry) => entry.command === `/fixture/process-${entry.pid}`))
    assert.ok(entries.every((entry) => entry.startedAt.length > 0 && entry.parentPid === 1 && entry.groupId === entry.pid))
    assert.equal(entries.find((entry) => entry.pid === 50_000_004)?.state, 'S', 'a process present before it exits during a command-line batch still prevents a false proof of absence')
  } finally {
    restore()
  }
})
