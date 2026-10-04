import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ExecutorClient, executorRoutes, ExecutorSession, inputDispatch } from '../../src/native/webdriver-client.ts'
import { readRequests, startFakeExecutor } from './native-fake-executor.ts'

async function executor(t: TestContext, config: Record<string, unknown> = {}): Promise<{ readonly client: ExecutorClient; readonly folder: string }> {
  const folder = await mkdtemp(join(tmpdir(), 'retest-native-client-'))
  await writeFile(join(folder, 'config.json'), JSON.stringify(config))
  const server = await startFakeExecutor({ folder })
  t.after(async () => {
    await server.close()
    await rm(folder, { recursive: true, force: true })
  })
  return { client: new ExecutorClient({ executor: 'webdriveragent', host: '127.0.0.1', port: server.port }), folder }
}

async function session(client: ExecutorClient): Promise<ExecutorSession> {
  const created = await client.createSession({ timeoutMs: 2000 })
  assert.equal(created.status, 'answered')
  if (created.status !== 'answered') throw new Error('no session')
  return created.value
}

const app = { bundleId: 'dev.retest.fixtures.taskphone' }

test('the client can send only the exact routes, and none that types, reads back and types again', () => {
  for (const route of executorRoutes) assert.doesNotMatch(route, /\/value|\/clear/, route)
  const sessionMethods = Object.getOwnPropertyNames(ExecutorSession.prototype)
  const clientMethods = Object.getOwnPropertyNames(ExecutorClient.prototype)
  assert.deepEqual(sessionMethods.filter((name) => /value|clear/i.test(name)), [])
  assert.deepEqual(clientMethods.sort(), ['constructor', 'createSession', 'shutdown', 'status'])
  assert.equal(new Set(executorRoutes).size, 16)
})

test('an answer is answered and counts as sent; a WebDriver error is refused', async (t) => {
  const { client, folder } = await executor(t)
  const status = await client.status({ timeoutMs: 2000 })
  assert.deepEqual(status.status === 'answered' && status.value, { ready: true, os: 'Fake OS 1.0' })
  const active = await session(client)
  const launched = await active.launchApp({ target: app, arguments: ['-reset'], environment: { RETEST_SERVICE_URL: 'http://127.0.0.1:1' } }, { timeoutMs: 2000 })
  assert.equal(launched.status, 'answered')
  assert.equal(inputDispatch(launched), 'sent')
  const state = await active.appState(app, { timeoutMs: 2000 })
  assert.equal(state.status === 'answered' && state.value, 4)
  const launchRequest = readRequests(folder).find((request) => request.path.endsWith('/wda/apps/launch'))
  assert.deepEqual(JSON.parse(launchRequest?.body ?? '{}'), { bundleId: app.bundleId, arguments: ['-reset'], environment: { RETEST_SERVICE_URL: 'http://127.0.0.1:1' } })
  await active.terminateApp(app, { timeoutMs: 2000 })
})

test('a request with no answer before its deadline is an unknown outcome, sent once and never again', async (t) => {
  const { client, folder } = await executor(t, { routes: { 'POST /session/:session/wda/apps/launch': { hang: true } } })
  const active = await session(client)
  const started = performance.now()
  const launched = await active.launchApp({ target: app, arguments: [], environment: {} }, { timeoutMs: 300 })
  const took = performance.now() - started
  assert.equal(launched.status, 'unknown')
  assert.equal(launched.status === 'unknown' && launched.reason, 'timeout')
  assert.equal(inputDispatch(launched), 'unknown')
  assert.ok(took >= 290 && took < 2000, `ended after ${took} ms`)
  assert.equal(readRequests(folder).filter((request) => request.path.endsWith('/wda/apps/launch')).length, 1, 'the executor received the launch once')
})

test('a connection dropped after the request went is an unknown outcome', async (t) => {
  const { client } = await executor(t, { routes: { 'POST /session/:session/wda/apps/terminate': { drop: true } } })
  const active = await session(client)
  const terminated = await active.terminateApp(app, { timeoutMs: 2000 })
  assert.equal(terminated.status === 'unknown' && terminated.reason, 'connection_lost')
  assert.equal(inputDispatch(terminated), 'unknown')
})

test('nothing listening means the request was not sent', async () => {
  const blocker = createServer()
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  const address = blocker.address()
  const port = address !== null && typeof address === 'object' ? address.port : 0
  await new Promise<void>((resolve) => blocker.close(() => resolve()))
  const client = new ExecutorClient({ executor: 'mac2', host: '127.0.0.1', port })
  const status = await client.status({ timeoutMs: 1000 })
  assert.equal(status.status === 'not_sent' && status.reason, 'connection_refused')
  assert.equal(inputDispatch(status), 'not_sent')
})

test('a stop before the request goes sends nothing; a stop after it went leaves the outcome unknown', async (t) => {
  const { client, folder } = await executor(t, { routes: { 'POST /session/:session/wda/apps/activate': { hang: true } } })
  const active = await session(client)
  const early = new AbortController()
  early.abort()
  const before = await active.activateApp(app, { timeoutMs: 2000, signal: early.signal })
  assert.equal(before.status === 'not_sent' && before.reason, 'stopped')
  assert.equal(readRequests(folder).filter((request) => request.path.endsWith('/activate')).length, 0)
  const late = new AbortController()
  setTimeout(() => late.abort(), 150)
  const after = await active.activateApp(app, { timeoutMs: 5000, signal: late.signal })
  assert.equal(after.status === 'unknown' && after.reason, 'stopped')
  assert.equal(readRequests(folder).filter((request) => request.path.endsWith('/activate')).length, 1)
})

test('an answer that is not WebDriver JSON is unknown, not a failure of the route', async (t) => {
  const { client } = await executor(t, { routes: { 'POST /session/:session/wda/apps/launch': { garbage: true } } })
  const launched = await (await session(client)).launchApp({ target: app, arguments: [], environment: {} }, { timeoutMs: 2000 })
  assert.equal(launched.status === 'unknown' && launched.reason, 'unreadable')
  assert.equal(inputDispatch(launched), 'unknown')
})

test('an error the route raises before acting counts as not sent; any other error as unknown', async (t) => {
  const { client } = await executor(t, { routes: { 'POST /session/:session/wda/apps/launch': { error: 'unknown error' }, 'POST /session/:session/wda/apps/activate': { error: 'invalid argument' } } })
  const active = await session(client)
  const launched = await active.launchApp({ target: app, arguments: [], environment: {} }, { timeoutMs: 2000 })
  assert.equal(launched.status === 'refused' && launched.error, 'unknown error')
  assert.equal(inputDispatch(launched), 'unknown')
  const activated = await active.activateApp(app, { timeoutMs: 2000 })
  assert.equal(inputDispatch(activated), 'not_sent')
})

test('a session the executor no longer knows sends nothing more', async (t) => {
  const { client, folder } = await executor(t)
  const first = await session(client)
  // A new session replaces the active one, as both executors do.
  await session(client)
  const stale = await first.appState(app, { timeoutMs: 2000 })
  assert.equal(stale.status === 'refused' && stale.error, 'invalid session id')
  assert.match(first.ended ?? '', /no longer knows/)
  const count = readRequests(folder).length
  const after = await first.appState(app, { timeoutMs: 2000 })
  assert.equal(after.status === 'not_sent' && after.reason, 'session_ended')
  assert.equal(readRequests(folder).length, count, 'nothing reached the executor')
})

test('the tree leaves the client cut to the owned window, menus never kept', async (t) => {
  const { client } = await executor(t, { appName: 'TaskDesk' })
  const active = await session(client)
  const owned = await active.ownedSource({ platform: 'macos', bundleId: 'dev.retest.fixtures.taskdesk', appNames: ['TaskDesk'] }, { timeoutMs: 2000 })
  assert.equal(owned.status, 'answered')
  if (owned.status !== 'answered') return
  assert.match(owned.value.xml, /^<XCUIElementTypeWindow/)
  assert.doesNotMatch(owned.value.xml, /Recent Items|secret-file|MenuBar/)
  const other = await active.ownedSource({ platform: 'macos', bundleId: 'dev.retest.other', appNames: ['Other'] }, { timeoutMs: 2000 })
  assert.equal(other.status === 'unknown' && other.reason, 'unreadable')
  assert.doesNotMatch(other.status === 'unknown' ? other.message : '', /TaskDesk/)
})

test('key routes refuse the other executor\'s body shape without sending it', async (t) => {
  const { client, folder } = await executor(t)
  const active = await session(client)
  const pressed = await active.pressKeys(['a'], { timeoutMs: 1000 })
  assert.equal(pressed.status === 'not_sent' && pressed.reason, 'wrong_executor')
  assert.equal(readRequests(folder).filter((request) => request.path.endsWith('/wda/keys')).length, 0)
})
