import type { SpawnSyncReturns } from 'node:child_process'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { before, test } from 'node:test'

const probe = fileURLToPath(new URL('./process-zone-probe.ts', import.meta.url))
const readers = ['metadata sync', 'metadata async', 'shared table', 'shared individual', 'shared async table', 'shared async individual', 'native command', 'native list', 'native table', 'native own', 'firefox table', 'firefox async table', 'firefox liveness', 'firefox individual', 'firefox async individual', 'webkit start', 'webkit table', 'webkit async table', 'webkit individual', 'webkit async individual', 'media table', 'media async table', 'media individual', 'media async individual', 'media owner start', 'install start']
const results: unknown[] = []
before(async () => {
  // The reference process leads a process group of its own, as every launch these readers record does (the media
  // process starts detached). In the test runner's group, the media reader would take in that whole group and every
  // descendant, so the arguments of whatever the other test files run at the time, such as the 5 MiB of wide sleeps of
  // native-processes.test.ts, and refuse the reading as larger than its 4 MiB bound.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, env: { PATH: process.env['PATH'], TZ: 'Etc/GMT+12' }, stdio: 'ignore' })
  const ended = once(child, 'exit')
  try {
    assert.ok(child.pid !== undefined)
    for (const zone of ['Etc/GMT+12', 'Etc/GMT-14']) {
      const read: SpawnSyncReturns<string> = spawnSync(process.execPath, ['--conditions=retest-source', probe, String(child.pid), String(process.pid)], { encoding: 'utf8', env: { PATH: process.env['PATH'], TZ: zone }, timeout: 60_000 })
      assert.equal(read.status, 0, read.stderr)
      results.push(JSON.parse(read.stdout))
    }
  } finally {
    child.kill('SIGKILL')
    await ended
  }
})
for (const reader of readers) {
  test(`${reader} reads a real process started in another TZ as UTC0`, () => {
    for (const value of results) {
      assert.ok(typeof value === 'object' && value !== null && reader in value)
      const reading: unknown = Reflect.get(value, reader)
      assert.ok(typeof reading === 'object' && reading !== null && 'actual' in reading && 'expected' in reading)
      assert.equal(reading.actual, reading.expected, reader)
    }
  })
}
