import assert from 'node:assert/strict'
import { ChildProcess } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'
import { ChromiumBrowser } from '../../src/browser/browser.ts'
import { BrowserError } from '../../src/browser/browser-error.ts'
import { CdpConnection } from '../../src/browser/cdp/connection.ts'
import { ChromiumProcess } from '../../src/browser/chromium-process.ts'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'

test('stop and gone wait for the owned log writes and close after the app exits', async () => {
  const child = new ChildProcess()
  Object.defineProperty(child, 'pid', { value: 6001 })
  let running = true
  const ownership = new OwnedProcessGroup(6001, 5001, {
    read: () => running ? [{ pid: 6001, parentPid: 5001, groupId: 6001, startedAt: 'today', command: '/owned/browser' }] : [],
    signal: () => { if (!running) throw Object.assign(new Error('gone'), { code: 'ESRCH' }) },
  })
  const output = Promise.withResolvers<string[]>()
  const browser = new ChromiumProcess(child, undefined, { readable: new PassThrough(), writable: new PassThrough() }, { closed: output.promise, cancel: () => undefined }, ownership)
  running = false
  child.emit('exit', 0, null)
  let free = false
  void browser.gone().then(() => { free = true })
  const stopping = browser.stop(100)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(free, false, 'the app exited, but its log has not closed')
  output.resolve([])
  assert.deepEqual(await stopping, [])
  await browser.gone()
  assert.equal(free, true)
})

test('a throwing pipe close is a cleanup failure after the owned process is stopped', async () => {
  const child = new ChildProcess()
  Object.defineProperty(child, 'pid', { value: 6002 })
  let running = true
  const ownership = new OwnedProcessGroup(6002, 5001, {
    read: () => running ? [{ pid: 6002, parentPid: 5001, groupId: 6002, startedAt: 'today', command: '/owned/browser' }] : [],
    signal: () => { running = false; child.emit('exit', 0, null) },
  })
  const owned = new ChromiumProcess(child, undefined, { readable: new PassThrough(), writable: new PassThrough() }, undefined, ownership)
  const connection = new CdpConnection({
    listen: () => undefined,
    send: () => { throw new Error('The target no longer answered.') },
    close: () => { throw new Error('Closing the transport failed.') },
  }, { timeoutMs: 100, onDiagnostic: () => undefined })
  const browser = new ChromiumBrowser({ process: owned, connection, executablePath: '/owned/browser', version: { product: 'Chrome', version: '1', userAgent: 'test' }, onListenerError: () => undefined })
  await assert.rejects(browser.close(100), (error: unknown) => error instanceof BrowserError && error.failure.class === 'cleanup_failed' && /Closing the transport failed/.test(error.message))
  await browser.gone
  assert.equal(running, false)
})

test('a failed process reading stays a cleanup failure after absence is confirmed', async () => {
  const child = new ChildProcess()
  Object.defineProperty(child, 'pid', { value: 6003 })
  let running = true
  let readings = 0
  const ownership = new OwnedProcessGroup(6003, 5001, {
    read: () => {
      readings += 1
      if (readings === 3) throw new Error('The host did not answer the process reading.')
      return running ? [{ pid: 6003, parentPid: 5001, groupId: 6003, startedAt: 'today', command: '/owned/browser' }] : []
    },
    signal: () => { throw new Error('An absent process must never be signaled.') },
  })
  const browser = new ChromiumProcess(child, undefined, { readable: new PassThrough(), writable: new PassThrough() }, undefined, ownership)
  running = false
  child.emit('exit', 0, null)
  const problems = await browser.stop(100)
  assert.match(problems.join(' '), /The host did not answer the process reading/)
  await browser.gone()
})

// A process stands in for the browser: it keeps its pipe open until its launch identity has been recorded.
async function startShell(profile: string, logFile: string): Promise<ChromiumProcess> {
  const browser = await ChromiumProcess.start({ executable: '/bin/sh', args: ['-c', 'read message <&3; exit 0'], profile, logFile })
  browser.pipe.writable.end('exit\n')
  return browser
}

// A host that runs many runs in one process must not gain an exit hook for every browser it could not clean up.
test('a browser whose process group has gone takes its exit hook away, even when its profile could not be removed', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-exit-hook-'))
  const locked = join(folder, 'locked')
  t.after(async () => {
    await chmod(locked, 0o755)
    await rm(folder, { recursive: true, force: true })
  })
  const profile = join(locked, 'profile')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'Preferences'), '{}')
  // A folder nobody may write keeps the profile in it from being removed.
  await chmod(locked, 0o555)
  const before = process.listenerCount('exit')
  const browser = await startShell(profile, join(folder, 'browser.log'))
  assert.equal(process.listenerCount('exit'), before + 1, 'a running browser has its hook')
  const problems = await browser.stop(1000)
  assert.match(problems.join('\n'), /^Could not remove the browser profile /)
  assert.equal(process.listenerCount('exit'), before, 'nothing is left for the hook to kill')
})

test('a browser that stopped cleanly takes its exit hook away', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-exit-hook-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const profile = join(folder, 'profile')
  await mkdir(profile)
  const before = process.listenerCount('exit')
  const browser = await startShell(profile, join(folder, 'browser.log'))
  assert.deepEqual(await browser.stop(1000), [])
  assert.equal(process.listenerCount('exit'), before)
})
