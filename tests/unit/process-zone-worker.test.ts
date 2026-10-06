import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'
import { metadataComplete, metadataRunning, metadataSuccess } from '../../src/shared/metadata-process.ts'

test('the metadata worker reads UTC0 even when a raw request asks for another zone', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: { PATH: process.env['PATH'], TZ: 'Etc/GMT+12' } })
  const ended = once(child, 'exit')
  const worker = new Worker(process.env['RETEST_TIMEZONE_WORKER'] === undefined ? new URL('../../src/shared/metadata-process-worker.ts', import.meta.url) : new URL(process.env['RETEST_TIMEZONE_WORKER']), { execArgv: [] })
  try {
    assert.ok(child.pid !== undefined)
    const reference = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(child.pid)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC0' } })
    assert.equal(reference.status, 0)
    for (const zone of ['Etc/GMT+12', 'Etc/GMT-14']) {
      const control = new Int32Array(new SharedArrayBuffer(12))
      const output = new SharedArrayBuffer(4 * 1024 * 1024)
      worker.postMessage({ command: '/bin/ps', args: ['-o', 'lstart=', '-p', String(child.pid)], environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: zone }, timeoutMs: 5000, control: control.buffer, output })
      const deadline = performance.now() + 6000
      while (Atomics.load(control, 0) !== metadataComplete) {
        assert.ok(performance.now() < deadline, 'the worker answers within its existing bound')
        const state = Atomics.load(control, 0)
        assert.ok(state === 0 || state === metadataRunning)
        const wait = Atomics.waitAsync(control, 0, state, deadline - performance.now())
        if (wait.async) await wait.value
      }
      assert.equal(Atomics.load(control, 1), metadataSuccess)
      const text = new TextDecoder().decode(new Uint8Array(output, 0, Atomics.load(control, 2)))
      assert.equal(text.trim(), reference.stdout.trim())
    }
  } finally {
    await worker.terminate()
    child.kill('SIGKILL')
    await ended
  }
})
