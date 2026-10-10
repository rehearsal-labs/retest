import type { TestContext } from 'node:test'
import type { BrowserCommand } from '../../src/browser/contract.ts'
import type { CollectorLoss, DiagnosticSink, Observation } from '../../src/diagnostics/observations.ts'
import type { Failure } from '../../src/protocol/failures.ts'
import type { CapturedFrame } from '../../src/media/capture.ts'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { locatorArguments } from '../../src/browser/locate.ts'
import { WebKitBrowser, launchWebKit } from '../../src/browser/webkit/browser.ts'
import { WebKitPage } from '../../src/browser/webkit/page.ts'
import { homePrefix, homeRecordFile, processStartedAt } from '../../src/browser/webkit/process.ts'
import { listPlanFunction, listPlanSchema } from '../../src/browser/webkit/select.ts'
import { webKitScope } from '../../src/diagnostics/webkit-collector.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { formatSessionId } from '../../src/protocol/evidence.ts'
import { awaitPosts, byTestId, closeMs, openApp, scratchFolder, servePages, setupMs } from './browser-harness.ts'
import { repositoryRoot } from './cli-harness.ts'
import { webKitPath } from './engines.ts'

// What is particular to WebKit, on the real build: helpers that launchd starts outside the browser's process group,
// recorded and ended by their record; a browser lost mid-command; a command stopped after its input went; what the
// collector covers and says when it loses its page; the page's own snapshots as a frame source; and the sweep of what
// a Retest process killed outright left behind. The shared suites run on WebKit through the webkit-*.test.ts wrappers.

const execFileAsync = promisify(execFile)

// Retest runs WebKit on macOS only; elsewhere these cases have no build to drive and are skipped by name.
const skip = process.platform === 'darwin' ? false : `Retest runs WebKit on macOS only, and this host is ${process.platform}`

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

type ProcessRow = { pid: number; parentPid: number; groupId: number; command: string }

async function processTable(): Promise<ProcessRow[]> {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,comm='])
  return stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    return match?.[4] === undefined ? [] : [{ pid: Number(match[1]), parentPid: Number(match[2]), groupId: Number(match[3]), command: match[4] }]
  })
}

/** A WebKit build launched for one test, closed after it. */
async function webkit(t: TestContext): Promise<WebKitBrowser> {
  const folder = await scratchFolder(t)
  const browser = await launchWebKit({ buildPath: webKitPath(), buildSource: 'RETEST_TEST_WEBKIT', logFile: join(folder, 'browser.log'), headless: true }, setupMs * 3)
  t.after(() => browser.close(closeMs).catch(() => undefined))
  return browser
}

async function page(t: TestContext, browser: WebKitBrowser, baseUrl: string): Promise<WebKitPage> {
  const opened = await browser.newPage({ baseUrl }, setupMs)
  assert.ok(opened instanceof WebKitPage)
  t.after(() => opened.dispose(closeMs).catch(() => undefined))
  return opened
}

function recordingSink(): DiagnosticSink & { observations: Observation[]; losses: CollectorLoss[]; unread: string[] } {
  const observations: Observation[] = []
  const losses: CollectorLoss[] = []
  const unread: string[] = []
  return { observations, losses, unread, observe: (observation) => observations.push(observation), unreadable: (method) => unread.push(method), lost: (loss) => losses.push(loss) }
}

test("WebKit's helpers run outside the browser's process group, are recorded by pid and command, and none outlives the close", { skip }, async (t) => {
  const app = await openApp(t)
  const browser = await webkit(t)
  const opened = await page(t, browser, app.url)
  assert.equal((await opened.execute({ kind: 'goto', url: '/' }, 5000)).ok, true)
  const recorded = browser.process.helpers
  assert.ok(recorded.length >= 2, `recorded ${recorded.length} helpers`)
  const table = await processTable()
  for (const helper of recorded) {
    const row = table.find((entry) => entry.pid === helper.pid)
    assert.ok(row !== undefined, `helper ${helper.label} runs`)
    assert.equal(row.parentPid, 1, `${helper.label} is a child of launchd`)
    assert.notEqual(row.groupId, browser.pid, `${helper.label} is outside the browser's process group`)
    assert.ok(helper.identity.command.startsWith(browser.build.directory), `${helper.label} runs from the build`)
  }
  assert.deepEqual(browser.identity.processIds.slice(0, 1), [browser.pid])
  const home = browser.process.home
  assert.ok(existsSync(join(home, homeRecordFile)), 'the home holds its owner record')
  await browser.close(closeMs)
  const after = await processTable()
  for (const helper of recorded) {
    const row = after.find((entry) => entry.pid === helper.pid)
    assert.ok(row === undefined || !helper.identity.command.startsWith(row.command), `${helper.label} (pid ${helper.pid}) ended`)
  }
  assert.ok(!after.some((entry) => entry.groupId === browser.pid), 'nothing of the browser group is left')
  assert.equal(existsSync(home), false, 'the temporary home is removed')
})

test('a WebKit browser killed after the press was sent answers outcome unknown, sends nothing again, and its helpers end', { skip }, async (t) => {
  const site = await servePages(t, { '/': FREEZE_ON_PRESS })
  const browser = await webkit(t)
  const opened = await page(t, browser, site.url)
  assert.equal((await opened.dispatch({ kind: 'goto', url: '/' }, 5000)).result.ok, true)
  const helpers = browser.process.helpers
  const clicking = opened.dispatch({ kind: 'click', locator: byTestId('freeze') }, 10_000)
  await awaitPosts(site, '/pressed', 1)
  // This test launched the browser, and the record names it.
  process.kill(browser.pid, 'SIGKILL')
  const { result, input } = await clicking
  t.diagnostic(`input after the loss: ${input}`)
  assert.notEqual(input, 'not_sent')
  assert.ok(!result.ok)
  assert.equal(result.failure.class, 'outcome_unknown')
  assert.match(result.failure.message, /^Retest lost the page after it began to click getByTestId\('freeze'\), so it cannot tell whether that took effect: /)
  const later = await opened.dispatch({ kind: 'observe', locator: byTestId('freeze') }, 1000)
  assert.deepEqual([later.result.ok ? '' : later.result.failure.class, later.input], ['session_lost', 'not_sent'])
  assert.equal(site.posts('/pressed'), 1, 'the press was never sent again')
  assert.equal(browser.connected, false)
  const end = performance.now() + 5000
  for (;;) {
    const table = await processTable()
    const left = helpers.filter((helper) => table.some((row) => row.pid === helper.pid && helper.identity.command.startsWith(row.command)))
    if (left.length === 0) break
    assert.ok(performance.now() < end, `helpers still running: ${left.map((helper) => helper.label).join(', ')}`)
    await delay(100)
  }
})

test('a WebKit click stopped while its press is busy keeps the class of the stop, says its input went, and is never released', { skip }, async (t) => {
  const site = await servePages(t, { '/': BUSY_ON_PRESS })
  const browser = await webkit(t)
  const opened = await page(t, browser, site.url)
  assert.equal((await opened.dispatch({ kind: 'goto', url: '/' }, 5000)).result.ok, true)
  const stop = new AbortController()
  const clicking = opened.dispatch({ kind: 'click', locator: byTestId('hold') }, 10_000, stop.signal)
  await awaitPosts(site, '/pressed', 1)
  stop.abort(interrupted)
  const { result, input } = await clicking
  t.diagnostic(`input after the stop: ${input}`)
  assert.notEqual(input, 'not_sent')
  assert.ok(!result.ok)
  assert.equal(result.failure.class, 'interrupted')
  assert.equal(result.failure.details?.['inputSent'], true)
  assert.match(result.failure.message, /Input it sent is not taken back, so it may have taken effect\.$/)
  const end = performance.now() + 5000
  let text = ''
  while (performance.now() < end) {
    const status = await opened.dispatch({ kind: 'observe', locator: byTestId('status') }, 5000)
    assert.ok(status.result.ok && status.result.kind === 'observe')
    assert.equal(status.input, 'not_sent')
    text = status.result.observation.text ?? ''
    if (text !== 'idle') break
    await delay(50)
  }
  await delay(2000)
  const settled = await opened.dispatch({ kind: 'observe', locator: byTestId('status') }, 5000)
  assert.ok(settled.result.ok && settled.result.kind === 'observe')
  t.diagnostic(`the button heard: ${settled.result.observation.text ?? ''}`)
  assert.equal(settled.result.observation.text, 'pressed', 'stopping never releases or clicks the pressed button')
  assert.equal(site.posts('/pressed'), 1, 'the press was sent once')
})

test("the collector hears the page's console, its uncaught error and its requests through a navigation into another web process, and tells the loss of its page", { skip }, async (t) => {
  const site = await servePages(t, {
    '/': `<!doctype html><title>One</title><script>console.log('first', 1); console.warn('careful'); setTimeout(() => { throw new Error('boom') }, 0); fetch('/missing')</script>`,
  })
  const other = await servePages(t, { '/': `<!doctype html><title>Two</title><script>console.error('second page')</script>` })
  const browser = await webkit(t)
  const opened = await page(t, browser, site.url)
  const sink = recordingSink()
  const collection = await opened.collectDiagnostics(sink, 5000)
  assert.deepEqual(collection.scope, webKitScope)
  assert.equal((await opened.execute({ kind: 'goto', url: '/' }, 5000)).ok, true)
  // A host the page has not seen opens in a new web process, and the collector follows the target it swaps into.
  const second = other.url.replace('127.0.0.1', 'localhost')
  assert.equal((await opened.execute({ kind: 'goto', url: `${second}/` }, 5000)).ok, true)
  const end = performance.now() + 5000
  const has = (predicate: (observation: Observation) => boolean) => sink.observations.some(predicate)
  while (performance.now() < end && !(has((o) => o.kind === 'console' && o.text === 'second page') && has((o) => o.kind === 'runtime_error'))) await delay(50)
  const consoles = sink.observations.flatMap((observation) => (observation.kind === 'console' ? [`${observation.origin} ${observation.level} ${observation.text}`] : []))
  t.diagnostic(consoles.join(' | '))
  assert.ok(consoles.includes('page info first 1'), consoles.join(' | '))
  assert.ok(consoles.includes('page warning careful'))
  assert.ok(consoles.includes('page error second page'))
  const error = sink.observations.find((observation) => observation.kind === 'runtime_error')
  assert.ok(error?.kind === 'runtime_error' && error.message.includes('boom') && error.errorKind === 'uncaught', JSON.stringify(error))
  const requests = sink.observations.flatMap((observation) => (observation.kind === 'request' ? [observation.url] : []))
  assert.ok(requests.includes(`${site.url}/`) && requests.includes(`${site.url}/missing`) && requests.includes(`${second}/`), requests.join(' '))
  const missing = sink.observations.find((observation) => observation.kind === 'request' && observation.url === `${site.url}/missing`)
  const response = sink.observations.find((observation) => observation.kind === 'response' && missing?.kind === 'request' && observation.key === missing.key)
  assert.equal(response?.kind === 'response' ? response.status : undefined, 404)
  assert.deepEqual(sink.unread, [])
  process.kill(browser.pid, 'SIGKILL')
  const lostBy = performance.now() + 5000
  while (sink.losses.length === 0 && performance.now() < lostBy) await delay(50)
  assert.equal(sink.losses.length, 1, 'the loss is told once')
  assert.equal(sink.losses[0]?.kind, 'connection_lost')
  collection.stop()
})

test("WebKit's own snapshots are a frame source of PNG frames carrying the page's session, and a page named as another session records nothing", { skip }, async (t) => {
  const app = await openApp(t)
  const browser = await webkit(t)
  const opened = await page(t, browser, app.url)
  const identity = { testId: 'test-1', attemptId: 'attempt-1', app: 'web', sessionId: formatSessionId('attempt-1', 'web') }
  opened.identify({ sessionId: identity.sessionId, owner: { runId: 'run-1', testId: identity.testId, attemptId: identity.attemptId, app: identity.app }, runtime: browser.identity })
  const elsewhere = opened.webKitFrameSource({ ...identity, sessionId: formatSessionId('attempt-2', 'web') })
  assert.equal(elsewhere.availability().available, false)
  assert.equal(elsewhere.name, 'webkit')
  const source = opened.webKitFrameSource(identity)
  assert.deepEqual(source.availability(), { available: true, mode: 'screenshot-loop' })
  const frames: CapturedFrame[] = []
  const started = performance.now()
  const clock = () => Math.round((performance.now() - started) * 1000)
  const start = await source.start({ fps: 10, clock, deliver: (frame) => frames.push(frame), ended: () => {}, timeoutMs: 5000 })
  assert.deepEqual(start, { ok: true, mode: 'screenshot-loop' })
  assert.equal((await opened.execute({ kind: 'goto', url: '/' }, 5000)).ok, true)
  assert.equal((await opened.execute({ kind: 'fill', locator: byTestId('task-title'), value: 'Release checklist' }, 5000)).ok, true)
  await delay(500)
  const stats = await source.stop(5000)
  t.diagnostic(JSON.stringify({ ...stats, problems: stats.problems.length }))
  assert.ok(stats.delivered >= 1 && frames.length === stats.delivered, `delivered ${stats.delivered}`)
  for (const frame of frames) {
    assert.deepEqual(frame.identity, identity)
    assert.equal(frame.format, 'png')
    assert.deepEqual([...frame.bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'a PNG')
  }
  const capture = await opened.webKitCapture(2000)
  assert.ok(capture.ok)
  assert.deepEqual([capture.capture.source, capture.capture.reference], ['webkit', { sessionId: identity.sessionId }])
  assert.deepEqual([...capture.capture.png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
})

test('a WebKit home a killed Retest process left is swept by the next launch, by its record, and a live one is left alone', { skip }, async (t) => {
  const folder = await scratchFolder(t)
  const script = join(folder, 'launch.ts')
  await writeFile(script, `import { launchWebKit } from ${JSON.stringify(join(repositoryRoot, 'src/browser/webkit/browser.ts'))}
const browser = await launchWebKit({ buildPath: ${JSON.stringify(webKitPath())}, buildSource: 'test', logFile: ${JSON.stringify(join(folder, 'child.log'))}, headless: true })
await browser.newPage({}, 10000)
process.stdout.write('ready ' + browser.process.home + '\\n')
setInterval(() => {}, 1000)
`)
  const child = spawn(process.execPath, ['--conditions=retest-source', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  const home = await new Promise<string>((resolve, reject) => {
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      const match = /ready (\S+)/.exec(output)
      if (match?.[1] !== undefined) resolve(match[1])
    })
    child.once('exit', (code) => reject(new Error(`the child ended with ${code} before it was ready: ${output}`)))
  })
  // This test started the child; ending it outright skips its cleanup, as a SIGKILL of a run would.
  child.kill('SIGKILL')
  await new Promise((resolve) => child.once('exit', resolve))
  assert.ok(existsSync(join(home, homeRecordFile)), 'the killed process left its home and its record')
  const live = await mkdtemp(join(await realpath(tmpdir()), homePrefix(process.pid)))
  t.after(() => rm(live, { recursive: true, force: true }))
  await writeFile(join(live, homeRecordFile), JSON.stringify({ version: 1, startTimeVersion: 1, path: live, launcher: { pid: process.pid, startedAt: processStartedAt(process.pid) }, processes: [] }))
  const ended = performance.now() + 5000
  // The orphaned browser ends once its pipe closes; the sweep ends any recorded process still there either way.
  while (performance.now() < ended && (await processTable()).some((row) => row.command.startsWith(webKitPath()) && row.parentPid === 1 && row.command.endsWith('/Playwright'))) await delay(100)
  const browser = await webkit(t)
  assert.equal(existsSync(home), false, 'the next launch removed the home the killed process left')
  assert.ok(existsSync(live), 'a home whose Retest process still runs is left alone')
  assert.ok((await readdir(tmpdir())).every((entry) => !entry.startsWith(homePrefix(child.pid ?? 0)) || entry === live), 'nothing of the killed process is left')
  await browser.close(closeMs)
})

// WebKit's tree gives a table's cells and headers, a tooltip and a select's options no name, where Chrome's names them
// from their text: such a lookup is refused at once, before it could find less than Chrome, and what WebKit names is
// found as it is.
test("a lookup WebKit's tree cannot answer as Chrome's does is refused by name at once, and one it can is answered", { skip }, async (t) => {
  const browser = await webkit(t)
  const site = await servePages(t, {
    '/table': '<!doctype html><table><tr><th>Name</th></tr><tr><td>Grace Hopper</td></tr></table><div role="listbox" aria-label="Cities"><div role="option">Paris</div></div>',
    '/select': '<!doctype html><select aria-label="Country"><option>Canada</option></select><div role="listbox" aria-label="Cities"><div role="option">Paris</div></div>',
  })
  const opened = await page(t, browser, site.url)
  assert.equal((await opened.execute({ kind: 'goto', url: '/table' }, 5000)).ok, true)
  const cell = { by: 'role', role: 'cell', name: 'Grace Hopper' } as const
  const started = performance.now()
  const refused = await opened.execute({ kind: 'observe', locator: cell }, 3000)
  assert.ok(performance.now() - started < 1000, 'refused at once')
  assert.deepEqual(refused, {
    ok: false,
    failure: {
      class: 'unsupported',
      message: "Could not look up getByRole('cell', { name: 'Grace Hopper' }): Chrome names a cell from its text, and WebKit's accessibility tree does not, so Retest refuses the lookup rather than find less on WebKit. Find it with getByText() or getByTestId(), or by its position with nth().",
      details: { role: 'cell' },
    },
  })
  const header = await opened.execute({ kind: 'click', locator: { by: 'role', role: 'columnheader', name: 'Name' } }, 3000)
  assert.equal(header.ok ? undefined : header.failure.class, 'unsupported')
  const cells = await opened.execute({ kind: 'observe', locator: { by: 'role', role: 'cell' } }, 3000)
  assert.ok(cells.ok && cells.kind === 'observe' && cells.observation.count === 1, 'cells by role alone are counted')
  const option = await opened.execute({ kind: 'observe', locator: { by: 'role', role: 'option', name: 'Paris' } }, 3000)
  assert.ok(option.ok && option.kind === 'observe' && option.observation.count === 1, "an option WebKit names is found: no select's options are on the page")

  assert.equal((await opened.execute({ kind: 'goto', url: '/select' }, 5000)).ok, true)
  // A custom option no option of the select could be named is answered exactly; options counted by role are refused,
  // since Chrome counts the select's option and WebKit's tree leaves it out.
  const options = await opened.execute({ kind: 'observe', locator: { by: 'role', role: 'option', name: 'Paris' } }, 3000)
  assert.ok(options.ok && options.kind === 'observe' && options.observation.count === 1, `the custom option is found beside a select's options: ${JSON.stringify(options)}`)
  const counted = await opened.execute({ kind: 'observe', locator: { by: 'role', role: 'option' } }, 3000)
  assert.equal(counted.ok ? undefined : counted.failure.class, 'unsupported', "with a select's options on the page, options counted by role are refused")
  assert.equal(counted.ok ? undefined : counted.failure.details?.['role'], 'option')
})

// A list that takes several options and holds `holds` at first, which logs every input and change event with what it
// holds at that moment.
function loggedList(holds: readonly string[]): string {
  const options = ['A', 'B', 'C', 'D', 'E'].map((label) => `<option${holds.includes(label) ? ' selected' : ''}>${label}</option>`).join('')
  return `<!doctype html><select data-testid="list" multiple size="5" style="height: 120px">${options}</select>
<p data-testid="log"></p><script>
  const list = document.querySelector('[data-testid="list"]')
  const log = document.querySelector('[data-testid="log"]')
  for (const type of ['input', 'change']) {
    list.addEventListener(type, () => { log.textContent += type + ':' + [...list.selectedOptions].map((option) => option.text).join('') + ' ' })
  }
</script>`
}

// W-8: WebKit's list once reached the first option asked for with Home and plain arrows, so a page saw "A alone", then
// "B alone", on its way to B, C and D, and an autosave on change stored a selection nobody asked for.
test('choosing several options in a WebKit list never selects an option nobody asked for, and a choice that cannot be reached that way is refused by name, typing nothing', { skip }, async (t) => {
  const presets = ['', 'C', 'B,C', 'A', 'E']
  const site = await servePages(t, Object.fromEntries(presets.map((holds) => [`/holds-${holds.replace(',', '-')}`, loggedList(holds.split(','))])))
  const browser = await webkit(t)
  const opened = await page(t, browser, site.url)
  const choose = async (holds: string, wanted: readonly string[]) => {
    assert.equal((await opened.execute({ kind: 'goto', url: `/holds-${holds.replace(',', '-')}` }, 5000)).ok, true)
    const result = await opened.execute({ kind: 'select', locator: byTestId('list'), choices: wanted.map((label) => ({ label })), multiple: true }, 5000)
    const log = await opened.execute({ kind: 'observe', locator: byTestId('log') }, 2000)
    assert.ok(log.ok && log.kind === 'observe')
    const heard = (log.observation.text ?? '').trim().split(' ').filter((entry) => entry !== '')
    for (const entry of heard) {
      const held = entry.slice(entry.indexOf(':') + 1).split('')
      assert.ok(held.every((label) => wanted.includes(label)), `holding ${holds || 'nothing'} and asked for ${wanted.join('')}, the page heard ${entry}: ${heard.join(' ')}`)
    }
    return { result, heard }
  }
  // From the list's first option, with Home, and from its last, with End.
  for (const [holds, wanted] of [['', ['A', 'B']], ['C', ['A', 'B', 'C']], ['', ['D', 'E']], ['B,C', ['C', 'D', 'E']]] as const) {
    const { result, heard } = await choose(holds, wanted)
    assert.deepEqual(result.ok ? result.kind : result.failure, 'select', `holding ${holds || 'nothing'}, asked for ${wanted.join('')}`)
    assert.equal(heard.at(-1), `change:${wanted.join('')}`)
  }
  // One option the list holds alone is passed through, since Home changes nothing there.
  const passed = await choose('A', ['B', 'C'])
  assert.equal(passed.result.ok, true, JSON.stringify(passed.result))
  assert.equal(passed.heard.at(-1), 'change:BC')
  // Options away from both ends: the keys would select A or E on the way, so nothing is typed.
  for (const [holds, wanted] of [['B,C', ['B', 'C', 'D']], ['', ['B', 'C']], ['E', ['B', 'C']]] as const) {
    const { result, heard } = await choose(holds, wanted)
    assert.ok(!result.ok, JSON.stringify(result))
    assert.equal(result.failure.class, 'unsupported')
    assert.match(result.failure.message, /touch neither end, so the keys would select an option nobody asked for on the way, which the page would hear\. Retest typed nothing\.$/)
    assert.deepEqual(heard, [], 'the page heard nothing')
  }
})

// W-5: a page busy in a long loop once held a goto's one-second reading of the page, and the next command, for as long
// as the loop ran, up to the launch timeout, where Chrome answers within each command's own budget.
test('a WebKit page busy in a long loop holds a command no longer than its own budget', { skip }, async (t) => {
  const site = await servePages(t, { '/': '<!doctype html><title>Busy</title><p data-testid="here">here</p><script>addEventListener("load", () => setTimeout(() => { const end = performance.now() + 8000; while (performance.now() < end) {} }, 0))</script>' })
  const browser = await webkit(t)
  const opened = await page(t, browser, site.url)
  const opening = performance.now()
  const opened2 = await opened.execute({ kind: 'goto', url: '/' }, 5000)
  const gotoMs = performance.now() - opening
  t.diagnostic(`goto answered after ${Math.round(gotoMs)} ms: ${JSON.stringify(opened2)}`)
  assert.equal(opened2.ok, true)
  assert.ok(gotoMs < 3000, `goto waited ${Math.round(gotoMs)} ms on a page that stays busy for 8000 ms`)
  const looking = performance.now()
  const look = await opened.execute({ kind: 'observe', locator: byTestId('here') }, 1000)
  const lookMs = performance.now() - looking
  assert.equal(look.ok ? 'answered' : look.failure.class, 'timeout', JSON.stringify(look))
  assert.ok(lookMs < 2000, `a look with a 1000 ms budget answered after ${Math.round(lookMs)} ms`)
})

// The keys that choose a WebKit list are planned in a call of their own, which finds the select again by its locator;
// an action pinned to one element plans from that element only, as each look that readies a key checks it.
test("a WebKit list's keys are planned only from the element an action is pinned to, and a pinned choice reaches only that list", { skip }, async (t) => {
  const list = (testId: string) => `<select multiple data-testid="${testId}" onchange="document.title += '${testId}:' + [...this.selectedOptions].map((option) => option.text).join('') + '|'"><option>A</option><option>B</option><option>C</option></select>`
  const site = await servePages(t, { '/': `<!doctype html><title></title>${list('first')}${list('second')}` })
  const browser = await webkit(t)
  const opened = await page(t, browser, site.url)
  assert.equal((await opened.execute({ kind: 'goto', url: '/' }, 5000)).ok, true)
  const read = await opened.readElements([byTestId('first'), byTestId('second')], 5000)
  assert.ok(read.ok, JSON.stringify(read))
  const [first, second] = read.reads.map((each) => each.keys)
  assert.ok(first?.length === 1 && second?.length === 1 && first[0] !== second[0], JSON.stringify(read.reads))
  const plan = (testId: string, element: string | null) => opened.world.call(listPlanFunction, locatorArguments(byTestId(testId), [{ choices: [{ label: 'A' }, { label: 'B' }], element }]), listPlanSchema, new Deadline(5000))
  const planned = { status: 'planned', keys: [{ key: 'Home', shift: false }, { key: 'ArrowDown', shift: true }] }
  assert.deepEqual(await plan('first', first[0] ?? null), planned)
  assert.deepEqual(await plan('second', first[0] ?? null), { status: 'moved' }, 'the second list is not the element pinned')
  assert.deepEqual(await plan('second', null), planned, 'an action pinned to nothing plans from the list its locator finds')
  const choose: Extract<BrowserCommand, { kind: 'select' }> = { kind: 'select', locator: byTestId('second'), choices: [{ label: 'A' }, { label: 'B' }], multiple: true }
  const refused = await opened.dispatchTo(choose, first[0] ?? '', 2000)
  assert.deepEqual([refused.input, refused.result.ok ? 'chosen' : refused.result.failure.details?.['refused']], ['not_sent', 'moved'], JSON.stringify(refused))
  const chosen = await opened.dispatchTo(choose, second[0] ?? '', 5000)
  assert.ok(chosen.result.ok, JSON.stringify(chosen))
  const heard = await opened.readPage([], 2000)
  assert.equal(heard.title, 'second:A|second:AB|', 'only the pinned list heard a change, and only of options asked for')
})

// The conformance runs saw a click on a hidden element refused after 499.x ms of its 500 ms budget, and a covered
// checkbox after 499 of 500, each saying it had waited 500: a refusal that came back with less than a whole millisecond
// left, which a deadline reads as none, or with the last look's browser call timed out early by the clock, was told at
// once rather than once the budget had passed.
test('a click on an element that stays hidden, and a check of a checkbox that stays covered, are refused only once the whole budget has passed, every time', { skip }, async (t) => {
  const covered = '<input type="checkbox" data-testid="covered" style="position: absolute; top: 20px; left: 20px; width: 30px; height: 30px"><div style="position: absolute; top: 0; left: 0; width: 120px; height: 120px; background: white"></div>'
  const site = await servePages(t, { '/': `<!doctype html><button data-testid="hidden" style="display: none">Hidden</button>${covered}` })
  const browser = await webkit(t)
  const opened = await page(t, browser, site.url)
  assert.equal((await opened.execute({ kind: 'goto', url: '/' }, 5000)).ok, true)
  const budgetMs = 60
  const early: string[] = []
  const tries = [
    { command: { kind: 'click', locator: byTestId('hidden') }, check: 'visible' },
    { command: { kind: 'check', locator: byTestId('covered') }, check: 'hit-target' },
  ] as const
  for (const { command, check } of tries) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const started = performance.now()
      const result = await opened.execute(command, budgetMs)
      const tookMs = performance.now() - started
      assert.deepEqual(result.ok ? 'done' : [result.failure.class, result.failure.details?.['check']], ['not_actionable', check], JSON.stringify(result))
      if (tookMs < budgetMs) early.push(`${command.kind} ${tookMs.toFixed(3)}`)
    }
  }
  assert.deepEqual(early, [], `refusals told before their ${budgetMs} ms budget had passed`)
})
