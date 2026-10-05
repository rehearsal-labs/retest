import type { BrowserOutput } from '../../src/browser/chromium-process.ts'
import type { OwnedProcessIdentity } from '../../src/shared/process-ownership.ts'
import assert from 'node:assert/strict'
import { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { ChromiumBrowser } from '../../src/browser/browser.ts'
import { BrowserError } from '../../src/browser/browser-error.ts'
import { CdpConnection } from '../../src/browser/cdp/connection.ts'
import { ChromiumProcess } from '../../src/browser/chromium-process.ts'
import { closeGraceMs } from '../../src/browser/contract.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'

test('ordinary browser cleanup uses asynchronous snapshots and one-pid readings, in signal order', async () => {
  const child = new ChildProcess()
  Object.defineProperty(child, 'pid', { value: 6401 })
  const root: OwnedProcessIdentity = { pid: 6401, parentPid: 5001, groupId: 6401, startedAt: 'today', command: '/owned/browser' }
  let running = true
  let cleaning = false
  const calls: string[] = []
  const snapshot = (): OwnedProcessIdentity[] => running ? [root] : []
  const ownership = new OwnedProcessGroup(root.pid, root.parentPid, {
    read: () => {
      if (cleaning) throw new Error('ordinary cleanup blocked on a synchronous snapshot')
      return snapshot()
    },
    readAsync: async () => {
      await new Promise<void>((resolve) => setImmediate(resolve))
      calls.push('snapshot')
      return snapshot()
    },
    readProcess: () => { throw new Error('ordinary cleanup blocked on a synchronous one-pid reading') },
    readProcessAsync: async (pid) => {
      await new Promise<void>((resolve) => setImmediate(resolve))
      calls.push(`read ${pid}`)
      return running ? root : undefined
    },
    signal: (pid) => {
      calls.push(`signal ${pid}`)
      running = false
      child.emit('exit', null, 'SIGKILL')
    },
  })
  const before = new Set(process.listeners('exit'))
  const browser = new ChromiumProcess(child, undefined, { readable: new PassThrough(), writable: new PassThrough() }, undefined, ownership)
  cleaning = true
  try {
    assert.deepEqual(await browser.stop(0), [])
    assert.deepEqual(calls.slice(0, 4), ['snapshot', 'snapshot', 'read 6401', 'signal 6401'])
    assert.equal(running, false)
    await browser.gone()
  } finally {
    for (const listener of process.listeners('exit')) if (!before.has(listener)) process.off('exit', listener)
  }
})

test('a browser cleanup whose caller deadline ended reports unconfirmed ownership and retains its profile', async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'retest-deadline-profile-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  const child = new ChildProcess()
  Object.defineProperty(child, 'pid', { value: 6402 })
  let running = true
  const signals: number[] = []
  const ownership = new OwnedProcessGroup(6402, 5001, {
    read: () => running ? [{ pid: 6402, parentPid: 5001, groupId: 6402, startedAt: 'today', command: '/owned/browser' }] : [],
    signal: (pid) => { signals.push(pid); running = false; child.emit('exit', null, 'SIGKILL') },
  })
  const before = new Set(process.listeners('exit'))
  const browser = new ChromiumProcess(child, profile, { readable: new PassThrough(), writable: new PassThrough() }, undefined, ownership)
  try {
    const problems = (await browser.stop(0, new Deadline(0))).join(' ')
    assert.match(problems, /not confirmed before its deadline/)
    assert.doesNotMatch(problems, /was still there/, 'a failed reading establishes no liveness fact')
    assert.deepEqual(signals, [])
    assert.equal(existsSync(profile), true, 'a deadline is not proof of absence')
    assert.equal(ownership.remains(), true)
  } finally {
    for (const listener of process.listeners('exit')) if (!before.has(listener)) process.off('exit', listener)
  }
})

test('the browser exit hook stays installed while the final asynchronous ownership reading is pending', async () => {
  const child = new ChildProcess()
  Object.defineProperty(child, 'pid', { value: 6403 })
  const root: OwnedProcessIdentity = { pid: 6403, parentPid: 5001, groupId: 6403, startedAt: 'today', command: '/owned/browser' }
  const reachedFinal = Promise.withResolvers<void>()
  const finalReading = Promise.withResolvers<OwnedProcessIdentity[]>()
  let readings = 0
  const ownership = new OwnedProcessGroup(root.pid, root.parentPid, {
    read: () => [root],
    readAsync: async () => {
      readings += 1
      if (readings === 3) {
        reachedFinal.resolve()
        return finalReading.promise
      }
      return [root]
    },
    readProcessAsync: async () => root,
    signal: () => undefined,
  })
  const before = new Set(process.listeners('exit'))
  const browser = new ChromiumProcess(child, undefined, { readable: new PassThrough(), writable: new PassThrough() }, undefined, ownership)
  const hook = process.listeners('exit').find((listener) => !before.has(listener))
  assert.ok(hook !== undefined)
  const stopping = browser.stop(0)
  try {
    const reached = await Promise.race([reachedFinal.promise.then(() => true), delay(2500).then(() => false)])
    assert.equal(reached, true, 'cleanup reached its final asynchronous reading')
    assert.ok(process.listeners('exit').includes(hook), 'the synchronous fallback stays available throughout the pending read')
  } finally {
    finalReading.resolve([root])
    await stopping
    process.off('exit', hook)
  }
})

test('a failed final asynchronous ownership reading is included in the browser cleanup report', async () => {
  const child = new ChildProcess()
  Object.defineProperty(child, 'pid', { value: 6404 })
  const root: OwnedProcessIdentity = { pid: 6404, parentPid: 5001, groupId: 6404, startedAt: 'today', command: '/owned/browser' }
  let readings = 0
  const ownership = new OwnedProcessGroup(root.pid, root.parentPid, {
    read: () => [root],
    readAsync: async () => {
      readings += 1
      if (readings === 3) throw new Error('final ownership reading failed')
      return [root]
    },
    readProcessAsync: async () => root,
    signal: () => undefined,
  })
  const before = new Set(process.listeners('exit'))
  const browser = new ChromiumProcess(child, undefined, { readable: new PassThrough(), writable: new PassThrough() }, undefined, ownership)
  try {
    assert.match((await browser.stop(0)).join(' '), /final ownership reading failed/)
    assert.match(ownership.readProblems.join(' '), /final ownership reading failed/)
    assert.equal(ownership.remains(), true)
  } finally {
    for (const listener of process.listeners('exit')) if (!before.has(listener)) process.off('exit', listener)
  }
})

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

test('a stopped browser keeps its profile cleanup hook until its pending output and profile cleanup finish', async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'retest-pending-profile-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  const child = new ChildProcess()
  Object.defineProperty(child, 'pid', { value: 6004 })
  let running = true
  const ownership = new OwnedProcessGroup(6004, 5001, {
    read: () => running ? [{ pid: 6004, parentPid: 5001, groupId: 6004, startedAt: 'today', command: '/owned/browser' }] : [],
    signal: () => { throw new Error('An absent process must never be signaled.') },
  })
  const output = Promise.withResolvers<string[]>()
  const before = new Set(process.listeners('exit'))
  const browser = new ChromiumProcess(child, profile, { readable: new PassThrough(), writable: new PassThrough() }, { closed: output.promise, cancel: () => undefined }, ownership)
  const hook = process.listeners('exit').find((listener) => !before.has(listener))
  assert.ok(hook !== undefined)
  running = false
  child.emit('exit', 0, null)
  const stopping = browser.stop(0)
  try {
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(existsSync(profile), true, 'ordinary cleanup is still pending')
    assert.ok(process.listeners('exit').includes(hook), 'an exiting host must still clean the owned profile')
    // Invoke only this browser's hook, as an abrupt host exit would. No other process or exit hook is touched.
    hook(0)
    assert.equal(existsSync(profile), false, 'the exit hook removes the owned profile after proving its group gone')
  } finally {
    output.resolve([])
    await stopping
    process.off('exit', hook)
  }
  assert.equal(process.listeners('exit').includes(hook), false, 'completed cleanup takes the hook away')
})

/**
 * A browser recorded through a host that reports its process as still exiting, `?Es` with its arguments unreadable as
 * macOS `ps` shows it, for `exitingReadings` readings after SIGKILL, and as gone after that.
 */
function killedBrowser(pid: number, profile: string, exitingReadings: number): { hook: (code: number) => void; signals: string[] } {
  const child = new ChildProcess()
  Object.defineProperty(child, 'pid', { value: pid })
  const record = { pid, parentPid: 5001, groupId: pid, startedAt: 'today', command: '/owned/browser --remote-debugging-pipe', state: 'Ss' }
  const signals: string[] = []
  let left: number | undefined
  const ownership = new OwnedProcessGroup(pid, 5001, {
    read: () => {
      if (left === undefined) return [record]
      if (left === 0) return []
      left -= 1
      return [{ ...record, state: '?Es', command: '(browser)' }]
    },
    signal: (signaled, signal) => {
      if (signal === 0) return
      signals.push(`${signaled} ${signal}`)
      left ??= exitingReadings
    },
  })
  const before = new Set(process.listeners('exit'))
  new ChromiumProcess(child, profile, { readable: new PassThrough(), writable: new PassThrough() }, undefined, ownership)
  const hook = process.listeners('exit').find((listener) => !before.has(listener))
  assert.ok(hook !== undefined, 'a running browser has its exit hook')
  process.off('exit', hook)
  return { hook, signals }
}

test('the exit hook removes the profile once the processes it killed have finished exiting', async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'retest-exit-hook-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  const { hook, signals } = killedBrowser(6101, profile, 2)
  hook(0)
  assert.deepEqual(signals, ['6101 SIGKILL'])
  assert.equal(existsSync(profile), false, 'the killed browser was still exiting at the first reading, and gone at a later one')
})

test('the exit hook keeps the profile of a browser still exiting when the close grace runs out', async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'retest-exit-hook-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  const { hook, signals } = killedBrowser(6102, profile, Number.MAX_SAFE_INTEGER)
  const started = performance.now()
  hook(0)
  assert.deepEqual(signals, ['6102 SIGKILL'])
  assert.equal(existsSync(profile), true, 'a profile is removed only once its browser is gone')
  assert.ok(performance.now() - started < closeGraceMs + 500, 'the exit hook waits no longer than the close grace')
})

/** A host for a browser whose main process dies first, leaving a helper whose parent becomes launchd. */
class DyingBrowserHost {
  main: OwnedProcessIdentity
  helper: OwnedProcessIdentity
  mainAlive = true
  helperAlive = true
  /** Readings after which an unsignaled helper ends on its own; undefined keeps it hung. */
  helperEndsAfter: number | undefined
  readonly signals: number[] = []
  #readings = 0

  constructor(pid: number) {
    this.main = { pid, parentPid: 5001, groupId: pid, startedAt: 'today', command: '/owned/browser --remote-debugging-pipe', state: 'Ss' }
    this.helper = { pid: pid + 1, parentPid: pid, groupId: pid, startedAt: 'today', command: '/owned/browser Helper --type=renderer', state: 'S' }
  }

  read = (): OwnedProcessIdentity[] => {
    this.#readings += 1
    if (!this.mainAlive && this.helperEndsAfter !== undefined && this.#readings > this.helperEndsAfter) this.helperAlive = false
    const helper = this.mainAlive ? this.helper : { ...this.helper, parentPid: 1 }
    return [...(this.mainAlive ? [this.main] : []), ...(this.helperAlive ? [helper] : [])]
  }

  signal = (pid: number, signal: NodeJS.Signals | 0): void => {
    const present = (pid === this.main.pid && this.mainAlive) || (pid === this.helper.pid && this.helperAlive)
    if (!present) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    if (signal === 0) return
    this.signals.push(pid)
    if (pid === this.helper.pid) this.helperAlive = false
  }

  /** The main process killed from outside: its helper now has launchd as its parent. */
  killMain(child: ChildProcess): void {
    this.mainAlive = false
    this.helperEndsAfter = this.helperEndsAfter === undefined ? undefined : this.#readings + this.helperEndsAfter
    child.emit('exit', null, 'SIGKILL')
  }
}

function dyingBrowser(pid: number, host: DyingBrowserHost, output?: BrowserOutput): { child: ChildProcess; browser: ChromiumProcess } {
  const child = new ChildProcess()
  Object.defineProperty(child, 'pid', { value: pid })
  const ownership = new OwnedProcessGroup(pid, 5001, host)
  const before = new Set(process.listeners('exit'))
  const browser = new ChromiumProcess(child, undefined, { readable: new PassThrough(), writable: new PassThrough() }, output, ownership)
  for (const listener of process.listeners('exit')) if (!before.has(listener)) process.off('exit', listener)
  return { child, browser }
}

test('a renderer recorded when its page opened is still ended after the main process dies first', async () => {
  const host = new DyingBrowserHost(6301)
  host.helperAlive = false
  const { child, browser: owned } = dyingBrowser(6301, host)
  host.helperAlive = true
  const connection = new CdpConnection({ listen: () => undefined, send: () => { throw new Error('The browser did not answer.') }, close: () => undefined }, { timeoutMs: 100, onDiagnostic: () => undefined })
  const browser = new ChromiumBrowser({ process: owned, connection, executablePath: '/owned/browser', version: { product: 'Chrome', version: '1', userAgent: 'test' }, onListenerError: () => undefined })
  await assert.rejects(browser.newPage({}, 100), (error: unknown) => error instanceof BrowserError)
  host.killMain(child)
  await browser.close(1000)
  assert.deepEqual(host.signals, [6302], 'the renderer recorded at the page open is ended through its record')
  await browser.gone
})

test('helpers the browser started unrecorded that end on their own after an outside kill leave a clean close', async () => {
  const host = new DyingBrowserHost(6311)
  host.helperAlive = false
  const { child, browser } = dyingBrowser(6311, host)
  host.helperAlive = true
  host.helperEndsAfter = 3
  host.killMain(child)
  assert.deepEqual(await browser.stop(0), [], 'once the group is shown empty, nothing was left behind')
  assert.deepEqual(host.signals, [], 'a helper whose launch could not be traced is never signaled')
  await browser.gone()
})

test('a hung helper the browser started unrecorded is reported, never signaled, and gone settles within its bound', async () => {
  const host = new DyingBrowserHost(6321)
  host.helperAlive = false
  const { child, browser } = dyingBrowser(6321, host)
  host.helperAlive = true
  host.killMain(child)
  const before = new Set(process.listeners('exit'))
  const problems = await browser.stop(0)
  // The hook stop puts back for a group still there would only read this stand-in host again as the test exits.
  for (const listener of process.listeners('exit')) if (!before.has(listener)) process.off('exit', listener)
  assert.match(problems.join(' '), /Process group 6321 contains processes whose launch ownership could not be verified/)
  const bound = Symbol('unsettled')
  const settled = await Promise.race([browser.gone().then(() => 'resolved', (error: unknown) => error), delay(5 * closeGraceMs + 3000).then(() => bound)])
  assert.ok(settled instanceof Error, `gone settles with a report rather than waiting on: ${String(settled)}`)
  assert.match(settled.message, /process group 6321 still had processes \d+ ms after its main process exited/)
  assert.deepEqual(host.signals, [], 'the unrecorded helper was left alone')
})

test('a browser output that closes while the main thread is busy is not reported as left open', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-output-close-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const browser = await ChromiumProcess.start({ executable: '/bin/sh', args: ['-c', 'echo started; read message <&3; echo ending >&2; exit 0'], profile: join(folder, 'profile'), logFile: join(folder, 'browser.log'), redact: (text) => text })
  // Synchronous work, such as process readings for other browsers, holding the main thread most of the time.
  const pause = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  const busy = setInterval(() => { Atomics.wait(pause, 0, 0, 300) }, 10)
  try {
    browser.pipe.writable.end('exit\n')
    assert.deepEqual(await browser.stop(closeGraceMs), [])
  } finally {
    clearInterval(busy)
  }
  assert.match(await readFile(join(folder, 'browser.log'), 'utf8'), /started\n[\s\S]*ending\n|ending\n[\s\S]*started\n/)
})

test('an output whose writers are gone but whose writing finishes after the bound, as on a busy host, is not reported', async () => {
  const host = new DyingBrowserHost(6351)
  host.helperAlive = false
  let canceled = false
  // On a busy host Chrome's output needed about two seconds of event-loop turns to finish closing after its group ended.
  const closed = delay(closeGraceMs + 500).then((): string[] => [])
  const { child, browser } = dyingBrowser(6351, host, { closed, cancel: () => { canceled = true }, writersRemain: () => false })
  host.killMain(child)
  assert.deepEqual(await browser.stop(0), [])
  assert.equal(canceled, false, 'the log was left to finish')
})

test('a browser output still held open after its group ended is reported and its reading stopped', async () => {
  const host = new DyingBrowserHost(6331)
  host.helperAlive = false
  let canceled = false
  const { child, browser } = dyingBrowser(6331, host, { closed: new Promise<string[]>(() => undefined), cancel: () => { canceled = true }, writersRemain: () => true })
  host.killMain(child)
  assert.deepEqual(await browser.stop(0), [`The browser's redacted output did not finish writing and closing within ${closeGraceMs} ms.`])
  assert.equal(canceled, true)
})

test('Retest writing the log after the browser output ended is bounded too', async () => {
  const host = new DyingBrowserHost(6341)
  host.helperAlive = false
  let canceled = false
  const { child, browser } = dyingBrowser(6341, host, { closed: new Promise<string[]>(() => undefined), cancel: () => { canceled = true }, writersRemain: () => false })
  host.killMain(child)
  assert.match((await browser.stop(0)).join(' '), /Retest did not finish writing and closing the browser's log within \d+ ms after its output ended/)
  assert.equal(canceled, true)
})
