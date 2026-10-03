import type { Readable } from 'node:stream'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { readdir, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { signalGroup } from '../../src/browser/chromium-process.ts'
import { errorCode } from '../../src/shared/error-code.ts'
import { s } from '../../src/protocol/schema.ts'
import { BidiClient, readBidi } from './bidi-client.ts'
import { BidiClosedError, BidiDisconnectedError, BidiProtocolError } from './bidi-errors.ts'
import { createUserContext, navigate, openTab, readUntil } from './firefox-page.ts'
import { firefoxPath, startSession } from './firefox-session.ts'
import { closeMs, commandMs, launchSession, openApp, rejection, scratchFolder, stopFailure, viewport, within } from './harness.ts'
import { FirefoxLaunchError, launchFirefox } from './launch-firefox.ts'
import { processTable } from './process-table.ts'

const serverFileSchema = s.object({ ws_host: s.string(), ws_port: s.number({ integer: true }) })
const heldSchema = s.object({ pid: s.number({ integer: true }), folder: s.string(), webSocketUrl: s.string() })
const runnerPath = fileURLToPath(new URL('./launch-and-hold.ts', import.meta.url))

async function childrenOf(pid: number): Promise<{ pid: number; group: number }[]> {
  return (await processTable()).filter((line) => line.command.includes(` -parentPid ${pid} `))
}

/** Opens another connection and asks it for a session, keeping Firefox's own message. */
async function secondSession(webSocketUrl: string): Promise<unknown> {
  const client = await BidiClient.connect(`${webSocketUrl}/session`, { timeoutMs: commandMs, onDiagnostic: () => {} })
  try {
    return await client.send('session.new', { capabilities: {} }, { keepErrorMessage: true }).then(
      () => 'accepted',
      (error: unknown) => error,
    )
  } finally {
    client.close()
  }
}

function isSessionLimit(outcome: unknown): boolean {
  return outcome instanceof BidiProtocolError && outcome.error === 'session not created' && outcome.protocolMessage === 'Maximum number of active sessions'
}

test('launches headless Firefox with its own profile in its own process group, and the session names that process', async (t) => {
  const app = await openApp(t)
  const { firefox, client, session } = await launchSession(t)
  assert.match(firefox.webSocketUrl, /^ws:\/\/127\.0\.0\.1:\d+$/)
  assert.ok(firefox.profile.startsWith(join(tmpdir(), `retest-firefox-${process.pid}-`)), firefox.profile)
  assert.ok((await processTable()).some((line) => line.pid === firefox.pid && line.group === firefox.pid), 'the main process leads its own process group')
  const written = readBidi(serverFileSchema, JSON.parse(await readFile(join(firefox.profile, 'WebDriverBiDiServer.json'), 'utf8')), 'WebDriverBiDiServer.json')
  assert.deepEqual(written, { ws_host: '127.0.0.1', ws_port: Number(new URL(firefox.webSocketUrl).port) }, 'the profile names the same address')
  assert.equal(session.browserName, 'firefox')
  assert.equal(session.processId, firefox.pid)
  assert.equal(session.profile, firefox.profile)
  assert.equal(session.headless, true)
  await navigate(await openTab(client, await createUserContext(client, commandMs), viewport, commandMs), `${app.url}/`, commandMs)
  const children = await childrenOf(firefox.pid)
  assert.ok(children.length > 0, 'Firefox has child processes')
  assert.deepEqual(children.filter((line) => line.group !== firefox.pid), [], 'every child process is in the group')
  t.diagnostic(`Firefox ${session.browserVersion} on ${session.platformName} ${session.platformVersion}, ${children.length} child processes`)
})

test('browser.close ends every process of the group, and the profile is removed', async (t) => {
  const app = await openApp(t)
  const { firefox, client } = await launchSession(t)
  await navigate(await openTab(client, await createUserContext(client, commandMs), viewport, commandMs), `${app.url}/`, commandMs)
  assert.ok((await childrenOf(firefox.pid)).length > 0, 'Firefox has child processes')
  const disconnected = new Promise<string>((resolve) => client.onDisconnect(resolve))
  const started = performance.now()
  assert.deepEqual(await client.request('browser.close', {}, s.object({}), { timeoutMs: closeMs }), {})
  assert.equal(await within(disconnected, closeMs, 'the WebSocket did not close'), 'the WebSocket closed with code 1000')
  assert.equal(await firefox.waitForGroupEnd(closeMs), true, `process group ${firefox.pid} should end within ${closeMs} ms`)
  t.diagnostic(`the process group was gone ${Math.round(performance.now() - started)} ms after browser.close`)
  assert.deepEqual(await childrenOf(firefox.pid), [], 'no child process is left')
  assert.equal(await stopFailure(firefox, 0), undefined)
})

test('a Firefox killed in the middle of a command fails it as a lost connection instead of hanging', async (t) => {
  const app = await openApp(t)
  const { firefox, client } = await launchSession(t)
  const tab = await openTab(client, await createUserContext(client, commandMs), viewport, commandMs)
  const requests = app.requests()
  const hanging = rejection(navigate(tab, `${app.url}/hang`, 60_000))
  await readUntil(async () => app.requests(), (count) => count > requests, 5000)
  const lost = new Promise<string>((resolve) => client.onDisconnect(resolve))
  const killedAt = performance.now()
  firefox.kill()

  const failure = await within(hanging, closeMs, 'the waiting command never settled')
  t.diagnostic(`the waiting navigate failed ${Math.round(performance.now() - killedAt)} ms after SIGKILL`)
  assert.ok(failure instanceof BidiDisconnectedError, String(failure))
  assert.equal(failure.method, 'browsingContext.navigate')
  assert.equal(failure.written, true, 'a command that was sent has an unknown outcome')
  assert.equal(await within(lost, closeMs, 'no disconnect was reported'), 'the WebSocket connection was lost (code 1006)')
  const later = await rejection(client.send('session.status', {}))
  assert.ok(later instanceof BidiClosedError, String(later))
  assert.equal(await firefox.waitForGroupEnd(closeMs), true)
  assert.deepEqual(await childrenOf(firefox.pid), [], 'no child process is left')
})

test('one session at a time: a second connection is refused one, a closed connection keeps it, and session.end frees it', async (t) => {
  const { firefox, client } = await launchSession(t)
  assert.ok(isSessionLimit(await rejection(client.send('session.new', { capabilities: {} }, { keepErrorMessage: true }))), 'a second session.new on the same connection')
  assert.ok(isSessionLimit(await secondSession(firefox.webSocketUrl)), 'session.new on a second connection')

  const ended = new Promise<string>((resolve) => client.onDisconnect(resolve))
  assert.deepEqual(await client.send('session.end', {}), {})
  assert.equal(await within(ended, closeMs, 'Firefox kept the connection after session.end'), 'the WebSocket closed with code 1000')
  const next = await BidiClient.connect(`${firefox.webSocketUrl}/session`, { timeoutMs: commandMs, onDiagnostic: () => {} })
  assert.equal((await startSession(next, commandMs)).processId, firefox.pid, 'after session.end a new connection gets a session')
  next.close()
  await sleep(500)
  assert.ok(isSessionLimit(await secondSession(firefox.webSocketUrl)), 'a connection closed without session.end still holds its session')
})

test('a runner killed outright leaves Firefox running with its session taken, and the next launch ends it', async (t) => {
  const folder = await scratchFolder(t)
  const runner = spawn(process.execPath, ['--conditions=retest-source', runnerPath, join(folder, 'held.log')], { stdio: ['ignore', 'pipe', 'inherit'] })
  const line = await within(firstLine(runner.stdout), 30_000, 'the runner never named its Firefox')
  const held = readBidi(heldSchema, JSON.parse(line), 'launch-and-hold')
  t.after(() => leaveNothing(held))
  runner.kill('SIGKILL')
  await once(runner, 'exit')
  await sleep(500)

  assert.equal(signalGroup(held.pid, 0), true, 'Firefox is still running after its runner died')
  assert.equal(existsSync(held.folder), true, 'its profile is still there')
  assert.ok(isSessionLimit(await secondSession(held.webSocketUrl)), 'its session is still taken, so no one can drive it')

  const { sweep } = await launchSession(t)
  t.diagnostic(`the next launch ended ${JSON.stringify(sweep.ended)} and removed ${JSON.stringify(sweep.removed)}`)
  assert.deepEqual(sweep.problems, [])
  assert.ok(sweep.ended.includes(held.pid), `the sweep ended Firefox ${held.pid}`)
  assert.ok(sweep.removed.includes(held.folder), `the sweep removed ${held.folder}`)
  assert.equal(signalGroup(held.pid, 0), false, 'the orphan and its children are gone')
  assert.equal(existsSync(held.folder), false)
})

test('the spawn route starts Firefox where this process may read Firefox data, and otherwise fails within its budget naming the likely cause', async (t) => {
  const folder = await scratchFolder(t)
  const dataFolder = join(homedir(), 'Library', 'Application Support', 'Firefox')
  const refused = process.platform === 'darwin' && (await readdir(dataFolder).then(() => false, (error: unknown) => errorCode(error) === 'EPERM'))
  t.diagnostic(`this process ${refused ? 'may not' : 'may'} read ${dataFolder}, so the spawn route should ${refused ? 'fail' : 'start Firefox'}`)
  const prefix = `retest-firefox-${process.pid}-`
  const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith(prefix)))
  const budgetMs = 8000
  const started = performance.now()
  const launch = launchFirefox({
    executablePath: firefoxPath(),
    logFile: join(folder, 'firefox.log'),
    headless: true,
    route: 'spawn',
    timeoutMs: budgetMs,
    commandTimeoutMs: commandMs,
    onDiagnostic: () => {},
  })
  if (refused) {
    const failure = await rejection(launch)
    const elapsedMs = Math.round(performance.now() - started)
    t.diagnostic(`failed after ${elapsedMs} ms: ${String(failure)}`)
    assert.ok(failure instanceof FirefoxLaunchError, String(failure))
    assert.match(failure.message, /^Firefox started by the spawn route did not print its WebDriver BiDi address within 8000 ms\. macOS does not let this process read .+; the likely cause is a profile dialog/)
    assert.ok(elapsedMs >= budgetMs && elapsedMs < budgetMs + 3000, `the launch gave up after ${elapsedMs} ms`)
  } else {
    const { firefox, client, session } = await launch
    assert.equal(session.processId, firefox.pid)
    await client.request('browser.close', {}, s.object({}), { timeoutMs: closeMs })
    assert.equal(await stopFailure(firefox, closeMs), undefined)
  }
  const left = (await readdir(tmpdir())).filter((name) => name.startsWith(prefix) && !before.has(name))
  assert.deepEqual(left, [], 'no profile folder is left')
  assert.deepEqual((await processTable()).filter((line) => line.command.includes(join(tmpdir(), prefix))), [], 'no Firefox of this launch is left')
})

// The orphan test's own cleanup, for a failure before the sweep: the Firefox it made, if still there, and its folder.
async function leaveNothing(held: { pid: number; folder: string }): Promise<void> {
  signalGroup(held.pid, 'SIGKILL')
  await rm(held.folder, { recursive: true, force: true })
}

// The first line a runner prints, which names the Firefox it launched.
async function firstLine(input: Readable): Promise<string> {
  for await (const line of createInterface({ input })) return line
  throw new Error('the runner ended without naming its Firefox')
}
