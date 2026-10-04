import type { ChildProcess } from 'node:child_process'
import type { TestContext } from 'node:test'
import type { CdpSession } from '../../src/browser/cdp/session.ts'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { startTaskApp } from '../../fixtures/task-app/server.ts'
import { CdpConnection, type CdpDiagnostic } from '../../src/browser/cdp/connection.ts'
import { CdpClosedError, CdpDisconnectedError } from '../../src/browser/cdp/errors.ts'
import { isRecord } from '../../src/browser/cdp/message.ts'
import { PipeTransport } from '../../src/browser/cdp/transport.ts'
import { signalGroup } from '../../src/browser/chromium-process.ts'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'

const DEFAULT_BROWSER = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

type Browser = {
  child: ChildProcess
  pid: number
  ownership: OwnedProcessGroup
  profile: string
  connection: CdpConnection
  diagnostics: CdpDiagnostic[]
  exited: Promise<unknown[]>
  stderr: () => string
}

function browserPath(): string {
  const configured = process.env['RETEST_TEST_BROWSER']
  if (configured) return configured
  if (existsSync(DEFAULT_BROWSER)) return DEFAULT_BROWSER
  throw new Error(`No browser to test with: set RETEST_TEST_BROWSER, or install Google Chrome at ${DEFAULT_BROWSER}`)
}

async function launch(t: TestContext): Promise<Browser> {
  const profile = await mkdtemp(join(tmpdir(), 'retest-cdp-'))
  const args = [
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
    '--headless',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    // Keeps a fresh profile out of the login keychain that the person's own Chrome uses.
    ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
    'about:blank',
  ]
  const child = spawn(browserPath(), args, { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })
  try {
    await once(child, 'spawn')
  } catch (error) {
    await rm(profile, { recursive: true, force: true })
    throw error
  }
  const exited = once(child, 'exit')
  const { pid } = child
  assert.ok(pid !== undefined)
  const ownership = new OwnedProcessGroup(pid)
  assert.deepEqual(ownership.capture(), [])
  t.after(async () => {
    await stopGroup(pid, exited, ownership)
    await rm(profile, { recursive: true, force: true })
  })
  t.diagnostic(`browser pid and process group ${pid}, profile ${profile}`)

  const [, , stderr, input, output] = child.stdio
  assert.ok(stderr instanceof Readable && input instanceof Writable && output instanceof Readable)

  let log = ''
  stderr.on('data', (chunk: Buffer) => (log += String(chunk)))
  const diagnostics: CdpDiagnostic[] = []
  const connection = new CdpConnection(new PipeTransport({ readable: output, writable: input }), {
    timeoutMs: 10_000,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  })
  t.after(() => connection.close())
  return { child, pid, ownership, profile, connection, diagnostics, exited, stderr: () => log }
}

async function stopGroup(pid: number, exited: Promise<unknown>, ownership: OwnedProcessGroup): Promise<void> {
  assert.deepEqual(ownership.signal('SIGKILL'), [])
  await exited
  await until(() => !processGroupExists(pid), 5000, `process group ${pid} to end`)
}

function processGroupExists(pgid: number): boolean {
  return signalGroup(pgid, 0)
}

/** Lines of `ps` that mention the profile, which every browser process carries in its command line. */
async function processesUsing(profile: string): Promise<string[]> {
  const paths = [profile, await realpath(profile)]
  const { stdout } = await promisify(execFile)('ps', ['-axww', '-o', 'pid=,pgid=,command='])
  return stdout.split('\n').filter((line) => paths.some((path) => line.includes(path)))
}

async function until(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!condition()) {
    if (performance.now() > deadline) assert.fail(`timed out after ${timeoutMs} ms waiting for ${what}`)
    await delay(20)
  }
}

function field(value: unknown, ...path: string[]): unknown {
  let current = value
  for (const key of path) current = isRecord(current) ? current[key] : undefined
  return current
}

function stringField(value: unknown, ...path: string[]): string {
  const found = field(value, ...path)
  assert.equal(typeof found, 'string', `${path.join('.')} should be a string`)
  return String(found)
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  assert.fail('expected the promise to reject')
}

/** Navigates and waits for the `load` of that navigation's own document. */
async function navigate(session: CdpSession, url: string, timeoutMs: number): Promise<void> {
  const loaded = new Set<string>()
  let expected: string | undefined
  const { promise: load, resolve } = Promise.withResolvers<void>()
  const stop = session.on('Page.lifecycleEvent', (params) => {
    const loaderId = field(params, 'loaderId')
    if (field(params, 'name') !== 'load' || typeof loaderId !== 'string') return
    loaded.add(loaderId)
    if (loaderId === expected) resolve()
  })
  let timer: NodeJS.Timeout | undefined
  try {
    const navigation = await session.send('Page.navigate', { url })
    assert.equal(field(navigation, 'errorText'), undefined)
    expected = stringField(navigation, 'loaderId')
    if (loaded.has(expected)) return
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${url} did not load within ${timeoutMs} ms`)), timeoutMs)
    })
    await Promise.race([load, timeout])
  } finally {
    clearTimeout(timer)
    stop()
  }
}

test('drives Chrome over the debugging pipe, and a killed browser rejects its pending commands', { timeout: 60_000 }, async (t) => {
  const app = await startTaskApp()
  t.after(() => app.close())
  const browser = await launch(t)
  const { connection } = browser

  const version = await connection.send('Browser.getVersion').catch((error: unknown) => {
    throw new Error(`Chrome did not answer. Its log:\n${browser.stderr()}`, { cause: error })
  })
  const product = stringField(version, 'product')
  assert.match(product, /Chrome\/\d+/)
  t.diagnostic(`browser ${product}`)

  const browserContextId = stringField(await connection.send('Target.createBrowserContext'), 'browserContextId')
  const targetId = stringField(
    await connection.send('Target.createTarget', { url: 'about:blank', browserContextId }),
    'targetId',
  )
  const session = await connection.attach(targetId)
  const exceptions: unknown[] = []
  session.on('Runtime.exceptionThrown', (params) => exceptions.push(params))
  await session.send('Page.enable')
  await session.send('Page.setLifecycleEventsEnabled', { enabled: true })
  await session.send('Runtime.enable')

  await navigate(session, `${app.url}/`, 10_000)
  const title = await session.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })
  assert.equal(field(title, 'result', 'value'), 'Tasks')
  const script = await session.send('Runtime.evaluate', { expression: 'typeof save', returnByValue: true })
  assert.equal(field(script, 'result', 'value'), 'function')
  assert.deepEqual(exceptions, [])
  const running = await processesUsing(browser.profile)
  const groups = new Set(running.map((line) => line.trim().split(/\s+/)[1]))
  assert.ok(running.length > 0, 'ps should see the running browser')
  assert.deepEqual([...groups], [String(browser.pid)], 'every browser process should share the process group')
  t.diagnostic(`${running.length} browser processes, all in process group ${browser.pid}`)

  const hanging = rejection(
    session.send('Runtime.evaluate', { expression: 'new Promise(() => {})', awaitPromise: true }, { timeoutMs: 30_000 }),
  )
  // Chrome runs a session's commands in order, so this answer proves the hanging one arrived.
  await session.send('Runtime.evaluate', { expression: '1 + 1', returnByValue: true })
  const disconnected = new Promise<string>((resolve) => connection.onDisconnect(resolve))
  const detached = new Promise<string>((resolve) => session.onDetach(resolve))
  assert.deepEqual(browser.ownership.signal('SIGKILL'), [])

  const error = await hanging
  assert.ok(error instanceof CdpDisconnectedError, String(error))
  assert.deepEqual([error.method, error.sessionId, error.written], ['Runtime.evaluate', session.id, true])
  const reason = await disconnected
  assert.equal(reason, 'the browser closed the pipe')
  assert.equal(await detached, reason)
  assert.ok((await rejection(connection.send('Browser.getVersion'))) instanceof CdpClosedError)
  assert.deepEqual(browser.diagnostics, [])

  const [code, signal] = await browser.exited
  assert.deepEqual([code, signal], [null, 'SIGKILL'])
  await until(() => !processGroupExists(browser.pid), 5000, `process group ${browser.pid} to end`)
  assert.deepEqual(await processesUsing(browser.profile), [])

  await rm(browser.profile, { recursive: true, force: true })
  assert.equal(existsSync(browser.profile), false)
})
