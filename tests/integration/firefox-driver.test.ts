import type { TestContext } from 'node:test'
import type { CollectorLoss, DiagnosticSink, Observation } from '../../src/diagnostics/observations.ts'
import type { Failure } from '../../src/protocol/failures.ts'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { BidiClient } from '../../src/browser/firefox/bidi-client.ts'
import { BidiProtocolError } from '../../src/browser/firefox/bidi-errors.ts'
import { FirefoxBrowser } from '../../src/browser/firefox/browser.ts'
import { launchFirefox } from '../../src/browser/firefox/launch.ts'
import { FirefoxPage } from '../../src/browser/firefox/page.ts'
import { sweepOrphanedFirefoxes } from '../../src/browser/firefox/orphans.ts'
import { firefoxConsoleUnavailable, firefoxScope } from '../../src/diagnostics/firefox-collector.ts'
import { awaitPosts, byLabel, byRole, byTestId, closeMs, openApp, scratchFolder, servePages, setupMs } from './browser-harness.ts'
import { freePort, repositoryRoot } from './cli-harness.ts'
import { firefoxPath, testFirefoxRoute } from './engines.ts'

// What is particular to Firefox, on the real browser: one WebDriver BiDi session per browser, shared by every page
// through user contexts; the sweep of a Firefox whose launcher was killed outright; a browser lost mid-command; a
// command stopped after its input went; what the collector covers and says when it loses its page; input to several
// pages at once; and the fields Firefox's accessibility locator leaves out. The shared suites run on Firefox through
// the firefox-*.test.ts wrappers.

const execFileAsync = promisify(execFile)
const onFirefoxHost = process.platform === 'darwin' && process.arch === 'arm64'
const skip = onFirefoxHost ? false : 'Retest runs Firefox on macOS on Apple silicon only'

// Posts to /pressed with a synchronous request, so the server knows the press arrived, then never returns.
const FREEZE_ON_PRESS = `<!doctype html><button data-testid="freeze" style="width: 200px; height: 60px">Freeze</button><script>
  document.querySelector('[data-testid="freeze"]').addEventListener('mousedown', () => {
    const request = new XMLHttpRequest()
    request.open('POST', '/pressed', false)
    request.send()
    for (;;) {}
  })
</script>`

// Tells the server the press arrived, then keeps the page busy long enough for Retest to be stopped mid-click.
const BUSY_ON_PRESS = `<!doctype html><button data-testid="hold" style="width: 200px; height: 60px">Hold</button>
<p data-testid="status">idle</p><script>
  const hold = document.querySelector('[data-testid="hold"]')
  const status = document.querySelector('[data-testid="status"]')
  hold.addEventListener('mousedown', () => {
    status.textContent = 'pressed'
    const request = new XMLHttpRequest()
    request.open('POST', '/pressed', false)
    request.send()
    const end = performance.now() + 1500
    while (performance.now() < end) {}
  })
  hold.addEventListener('mouseup', () => { status.textContent += ' released' })
  hold.addEventListener('click', () => { status.textContent += ' clicked' })
</script>`

const interrupted: Failure = { class: 'interrupted', message: 'The run was interrupted.' }

/** A Firefox launched for one test, closed after it. */
async function firefox(t: TestContext): Promise<FirefoxBrowser> {
  const folder = await scratchFolder(t)
  const browser = await launchFirefox({ executablePath: firefoxPath(), logFile: join(folder, 'browser.log'), headless: true, route: testFirefoxRoute() }, setupMs * 3)
  t.after(() => browser.close(closeMs).catch(() => undefined))
  return browser
}

async function commandLine(pid: number): Promise<string | undefined> {
  const { stdout } = await execFileAsync('/bin/ps', ['-ww', '-o', 'args=', '-p', String(pid)]).catch(() => ({ stdout: '' }))
  const line = stdout.trim()
  return line === '' ? undefined : line
}

function profileIn(command: string | undefined): string {
  const profile = / --profile (\S+)/.exec(command ?? '')?.[1]
  assert.ok(profile !== undefined, `the Firefox command line names its profile: ${command ?? 'none'}`)
  return profile
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(condition: () => boolean | Promise<boolean>, timeoutMs: number, message: string): Promise<void> {
  const end = performance.now() + timeoutMs
  while (!(await condition())) {
    assert.ok(performance.now() < end, message)
    await delay(50)
  }
}

function recordingSink(): DiagnosticSink & { observations: Observation[]; losses: CollectorLoss[]; unread: string[]; refused: string[] } {
  const observations: Observation[] = []
  const losses: CollectorLoss[] = []
  const unread: string[] = []
  const refused: string[] = []
  return {
    observations,
    losses,
    unread,
    refused,
    observe: (observation) => observations.push(observation),
    unreadable: (method) => unread.push(method),
    limited: (method) => refused.push(method),
    lost: (loss) => losses.push(loss),
  }
}

test('a Firefox launch names its engine and build, owns its profile, and removes it at close', { skip }, async (t) => {
  const browser = await firefox(t)
  assert.equal(browser.identity.engine, 'firefox')
  assert.equal(browser.product, 'Firefox')
  assert.match(browser.version, /^\d+\.\d+/)
  assert.match(browser.buildId ?? '', /^\d{14}$/, 'the build id is the one Firefox reports')
  t.diagnostic(`Firefox ${browser.version} build ${browser.buildId ?? 'unknown'} by the ${browser.route} route`)
  const profile = profileIn(await commandLine(browser.pid))
  assert.ok(existsSync(profile))
  assert.ok(existsSync(join(profile, '..', 'retest-owner.json')), 'the launch recorded the Firefox it started')
  await browser.close(closeMs)
  assert.equal(existsSync(profile), false, 'the profile and its folder are removed')
  await until(() => !running(browser.pid), 5000, 'the browser process ended')
})

test('a Firefox allows one WebDriver BiDi session, which every page of the browser shares through a user context of its own', { skip }, async (t) => {
  const site = await servePages(t, { '/': '<!doctype html><p data-testid="here">Here</p><script>document.cookie = "visit=" + (document.cookie ? "again" : "first")</script>' })
  const browser = await firefox(t)
  const profile = profileIn(await commandLine(browser.pid))
  const server: unknown = JSON.parse(await readFile(join(profile, 'WebDriverBiDiServer.json'), 'utf8'))
  const field = (name: string): unknown => (typeof server === 'object' && server !== null ? Reflect.get(server, name) : undefined)
  const [host, port] = [field('ws_host'), field('ws_port')]
  assert.ok(typeof host === 'string' && typeof port === 'number', 'Firefox wrote the address it listens on')
  const second = await BidiClient.connect(`ws://${host}:${port}/session`, { timeoutMs: 5000, onDiagnostic: () => {} })
  t.after(() => second.close())
  const refused = await second.send('session.new', { capabilities: {} }).catch((error: unknown) => error)
  assert.ok(refused instanceof BidiProtocolError, String(refused))
  assert.equal(refused.error, 'session not created')
  // Two pages of the one session each keep their own cookies.
  const first = await browser.newPage({ baseUrl: site.url }, setupMs)
  const other = await browser.newPage({ baseUrl: site.url }, setupMs)
  t.after(() => Promise.all([first.dispose(closeMs), other.dispose(closeMs)]).catch(() => undefined))
  for (const page of [first, other]) assert.equal((await page.execute({ kind: 'goto', url: '/' }, 5000)).ok, true)
  const cookies = await Promise.all([first.captureState(5000), other.captureState(5000)])
  assert.deepEqual(cookies.map((state) => state.cookies.map((cookie) => `${cookie.name}=${cookie.value}`)), [['visit=first'], ['visit=first']])
})

test('several pages of one Firefox each take the text filled into them, and each field holds its own', { skip }, async (t) => {
  const app = await openApp(t)
  const browser = await firefox(t)
  const pages = await Promise.all([1, 2, 3, 4].map(() => browser.newPage({ baseUrl: app.url }, setupMs)))
  t.after(() => Promise.all(pages.map((page) => page.dispose(closeMs))).catch(() => undefined))
  for (let round = 0; round < 3; round += 1) {
    await Promise.all(pages.map((page) => page.execute({ kind: 'goto', url: '/login' }, 10_000)))
    const filled = await Promise.all(pages.map((page, index) => page.execute({ kind: 'fill', locator: byTestId('user'), value: `Account ${round}-${index}` }, 5000)))
    assert.deepEqual(filled.map((result) => result.ok), [true, true, true, true], JSON.stringify(filled))
    const values = await Promise.all(pages.map((page) => page.execute({ kind: 'observe', locator: byTestId('user') }, 5000)))
    assert.deepEqual(
      values.map((result) => (result.ok && result.kind === 'observe' ? result.observation.value : JSON.stringify(result))),
      pages.map((_, index) => `Account ${round}-${index}`),
    )
  }
})

test("a password field is found by its label, and every textbox by its role, though Firefox's locator leaves password fields out", { skip }, async (t) => {
  const app = await openApp(t)
  const browser = await firefox(t)
  const page = await browser.newPage({ baseUrl: app.url }, setupMs)
  t.after(() => page.dispose(closeMs).catch(() => undefined))
  assert.equal((await page.execute({ kind: 'goto', url: '/login' }, 5000)).ok, true)
  const password = await page.execute({ kind: 'observe', locator: byLabel('Password') }, 5000)
  assert.ok(password.ok && password.kind === 'observe', JSON.stringify(password))
  assert.equal(password.observation.count, 1)
  const textboxes = await page.execute({ kind: 'observe', locator: byRole('textbox') }, 5000)
  assert.ok(textboxes.ok && textboxes.kind === 'observe', JSON.stringify(textboxes))
  assert.equal(textboxes.observation.count, 2, 'the user name and the password')
  assert.equal((await page.execute({ kind: 'fill', locator: byLabel('Password'), value: 'typed' }, 5000)).ok, true)
  const typed = await page.execute({ kind: 'observe', locator: byTestId('password') }, 5000)
  assert.ok(typed.ok && typed.kind === 'observe')
  assert.equal(typed.observation.value, 'typed')
})

test('a Firefox killed while an action waits for its element fails as a lost session, and one killed after the press leaves the outcome unknown', { skip }, async (t) => {
  const waiting = await servePages(t, { '/': '<!doctype html><button data-testid="far" disabled>Far</button>' })
  const first = await firefox(t)
  const page = await first.newPage({ baseUrl: waiting.url }, setupMs)
  assert.equal((await page.execute({ kind: 'goto', url: '/' }, 5000)).ok, true)
  const clicking = page.dispatch({ kind: 'click', locator: byTestId('far') }, 10_000)
  await delay(300)
  first.crash()
  const lost = await clicking
  assert.ok(!lost.result.ok)
  assert.equal(lost.result.failure.class, 'session_lost')
  assert.equal(lost.input, 'not_sent')

  const site = await servePages(t, { '/': FREEZE_ON_PRESS })
  const browser = await firefox(t)
  const frozen = await browser.newPage({ baseUrl: site.url }, setupMs)
  assert.equal((await frozen.execute({ kind: 'goto', url: '/' }, 5000)).ok, true)
  const pressing = frozen.dispatch({ kind: 'click', locator: byTestId('freeze') }, 10_000)
  await awaitPosts(site, '/pressed', 1)
  browser.crash()
  const { result, input } = await pressing
  t.diagnostic(`input after the loss: ${input}`)
  assert.notEqual(input, 'not_sent')
  assert.ok(!result.ok)
  assert.equal(result.failure.class, 'outcome_unknown')
  assert.match(result.failure.message, /^Retest lost the page after it began to click getByTestId\('freeze'\), so it cannot tell whether that took effect: /)
  const later = await frozen.dispatch({ kind: 'observe', locator: byTestId('freeze') }, 1000)
  assert.deepEqual([later.result.ok ? '' : later.result.failure.class, later.input], ['session_lost', 'not_sent'])
  assert.equal(site.posts('/pressed'), 1, 'the press was never sent again')
  assert.equal(browser.connected, false)
})

test('a Firefox click stopped while its press is busy keeps the stop and lets the single sent sequence settle once', { skip }, async (t) => {
  const site = await servePages(t, { '/': BUSY_ON_PRESS })
  const browser = await firefox(t)
  const page = await browser.newPage({ baseUrl: site.url }, setupMs)
  t.after(() => page.dispose(closeMs).catch(() => undefined))
  assert.equal((await page.execute({ kind: 'goto', url: '/' }, 5000)).ok, true)
  const stop = new AbortController()
  const clicking = page.dispatch({ kind: 'click', locator: byTestId('hold') }, 10_000, stop.signal)
  await awaitPosts(site, '/pressed', 1)
  stop.abort(interrupted)
  const { result, input } = await clicking
  t.diagnostic(`input after the stop: ${input}`)
  assert.notEqual(input, 'not_sent')
  assert.ok(!result.ok)
  assert.equal(result.failure.class, 'interrupted')
  assert.equal(result.failure.details?.['inputSent'], true)
  assert.match(result.failure.message, /Input it sent is not taken back, so it may have taken effect\.$/)
  await delay(2000)
  const settled = await page.dispatch({ kind: 'observe', locator: byTestId('status') }, 5000)
  assert.ok(settled.result.ok && settled.result.kind === 'observe')
  assert.equal(settled.input, 'not_sent')
  t.diagnostic(`the button heard: ${settled.result.observation.text ?? ''}`)
  assert.equal(settled.result.observation.text, 'pressed released clicked', 'the single sequence already sent settles once after the stop')
  assert.equal(site.posts('/pressed'), 1, 'the press was sent once')
})

// The console half of this case became a statement of its absence: Firefox's console source runs the page's getters
// once anyone subscribes to it (`firefoxConsoleUnavailable`), so the collector hears the network alone and says so.
test("the collector hears the page's requests and a failed one, hears no console, says the console is unavailable and what it covers, and tells the loss of its page once", { skip }, async (t) => {
  // A port nobody listens on, rather than one Firefox refuses before any request exists, such as 9.
  const closed = await freePort()
  const site = await servePages(t, {
    '/': `<!doctype html><title>One</title><script>console.log('first', 1); console.warn('careful'); setTimeout(() => { throw new Error('boom') }, 0); fetch('/missing'); fetch('http://127.0.0.1:${closed}/').catch(() => {})</script>`,
  })
  const browser = await firefox(t)
  const page = await browser.newPage({ baseUrl: site.url }, setupMs)
  assert.ok(page instanceof FirefoxPage)
  const sink = recordingSink()
  const collection = await page.collectDiagnostics(sink, 5000)
  assert.deepEqual(collection.scope, firefoxScope)
  assert.deepEqual(collection.unavailable, { console: firefoxConsoleUnavailable })
  assert.equal((await page.execute({ kind: 'goto', url: '/' }, 5000)).ok, true)
  const has = (predicate: (observation: Observation) => boolean): boolean => sink.observations.some(predicate)
  await until(() => has((o) => o.kind === 'failed') && has((o) => o.kind === 'response' && o.status === 404), 5000, 'the page was heard')
  await delay(200)
  assert.deepEqual(sink.observations.filter((observation) => observation.kind === 'console' || observation.kind === 'runtime_error'), [], 'no console message or error is heard')
  const requests = sink.observations.flatMap((observation) => (observation.kind === 'request' ? [observation.url] : []))
  assert.ok(requests.includes(`${site.url}/`) && requests.includes(`${site.url}/missing`), requests.join(' '))
  const failed = sink.observations.find((observation) => observation.kind === 'failed')
  assert.ok(failed?.kind === 'failed' && failed.reason.length > 0, JSON.stringify(failed))
  assert.deepEqual([sink.unread, sink.refused], [[], []])
  browser.crash()
  await until(() => sink.losses.length > 0, 5000, 'the loss was told')
  await delay(200)
  assert.equal(sink.losses.length, 1, 'the loss is told once')
  collection.stop()
})

test('the sweep ends a Firefox whose launcher was killed outright, with its folder, and leaves a live launch alone', { skip }, async (t) => {
  const root = await scratchFolder(t)
  const script = join(root, 'launch-and-hold.ts')
  const source = `import { launchFirefox } from ${JSON.stringify(join(repositoryRoot, 'src/browser/firefox/launch.ts'))}
const browser = await launchFirefox({ executablePath: ${JSON.stringify(firefoxPath())}, logFile: ${JSON.stringify(join(root, 'held.log'))}, headless: true, route: ${JSON.stringify(testFirefoxRoute())}, folderRoot: ${JSON.stringify(root)} }, 30000)
process.stdout.write(JSON.stringify({ pid: browser.pid }) + '\\n')
setInterval(() => {}, 1000)
`
  await writeFile(script, source)
  const launcher = spawn(process.execPath, ['--conditions=retest-source', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => {
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL')
  })
  let output = ''
  launcher.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
  })
  await until(() => output.includes('\n') || launcher.exitCode !== null, 45_000, 'the launcher started its Firefox')
  const announced: unknown = JSON.parse(output.split('\n')[0] ?? '{}')
  const pid = typeof announced === 'object' && announced !== null ? Reflect.get(announced, 'pid') : undefined
  assert.equal(typeof pid, 'number', output)
  const firefoxPid = Number(pid)
  const folders = (await readdir(root)).filter((name) => name.startsWith('retest-firefox-'))
  assert.equal(folders.length, 1)

  const whileAlive = await sweepOrphanedFirefoxes(root)
  assert.deepEqual([whileAlive.ended, whileAlive.removed], [[], []], 'a launch whose launcher runs is left alone')
  assert.ok(running(firefoxPid))

  // The launcher is this test's own child.
  launcher.kill('SIGKILL')
  await until(() => launcher.exitCode !== null || launcher.signalCode !== null, 5000, 'the launcher ended')
  await delay(500)
  assert.ok(running(firefoxPid), 'a Firefox outlives the launcher killed outright, as the platform record says')
  const swept = await sweepOrphanedFirefoxes(root)
  t.diagnostic(JSON.stringify(swept))
  assert.deepEqual(swept.ended, [firefoxPid])
  assert.deepEqual(swept.removed, [join(root, folders[0] ?? '')])
  await until(() => !running(firefoxPid), 5000, 'the orphaned Firefox ended')
  assert.equal(existsSync(join(root, folders[0] ?? '')), false)
})
