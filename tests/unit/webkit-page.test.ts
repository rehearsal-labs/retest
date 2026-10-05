import type { TestContext } from 'node:test'
import type { PageNavigation } from '../../src/browser/contract.ts'
import type { ScriptedBuild } from './webkit-scripted-inspector.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { WebKitPage, outlast, waitedWholeBudget } from '../../src/browser/webkit/page.ts'
import { defaultScreen } from '../../src/browser/webkit/screen.ts'
import { monotonicClock } from '../../src/protocol/deadline.ts'
import { scriptedBuild } from './webkit-scripted-inspector.ts'

// How a WebKit page sets up each target and reads its main frame's events, against a scripted build. The integration
// tests drive the same page on the real build.

function openPage(t: TestContext, build: ScriptedBuild = scriptedBuild(t)) {
  const page = new WebKitPage({
    connection: build.connection,
    pageProxyId: '7',
    browserContextId: 'context-1',
    setup: { baseUrl: 'http://app.test', screen: { viewport: { width: 640, height: 480 }, deviceScaleFactor: 2, userAgent: 'Retest agent' }, restoredOrigins: [] },
    openSidePage: async () => assert.fail('no side page is opened'),
    onListenerError: (error) => assert.fail(String(error)),
  })
  t.after(() => page.markClosed('the test ended'))
  return { build, page }
}

/** Answers every setup command, and the frame tree a page reads once its target runs. */
function answerSetup(build: ScriptedBuild): void {
  build.serve((command) => {
    if (command.method === 'Page.getResourceTree') return { frameTree: { frame: { id: 'frame-1', url: 'about:blank', loaderId: 'L0', securityOrigin: '', mimeType: 'text/html' }, resources: [] } }
    if (command.method === 'Runtime.evaluate') return { result: { type: 'boolean', value: true } }
    return {}
  })
}

test('a page target is set up while it is paused: domains, the user world, the change binding, the relay and the screen, then let run', { timeout: 10_000 }, async (t) => {
  const { build, page } = openPage(t)
  answerSetup(build)
  build.proxyEvent('7', 'Target.targetCreated', { targetInfo: { targetId: 'page-8', type: 'page', isPaused: true } })
  await page.ready
  const methods = build.received.map((command) => `${command.targetId === undefined ? 'proxy' : command.targetId} ${command.method}`)
  const resumed = methods.indexOf('proxy Target.resume')
  for (const method of ['page-8 Page.enable', 'page-8 Runtime.enable', 'page-8 Network.enable', 'page-8 Console.enable', 'page-8 Page.createUserWorld', 'page-8 Runtime.addBinding', 'page-8 Page.setBootstrapScript', 'page-8 Page.overrideUserAgent', 'page-8 Debugger.enable', 'page-8 Debugger.setPauseOnDebuggerStatements', 'proxy Emulation.setDeviceMetricsOverride', 'proxy Emulation.setActiveAndFocused', 'proxy Dialog.enable']) {
    const at = methods.indexOf(method)
    assert.ok(at !== -1 && at < resumed, `${method} comes before the target runs: ${methods.join(', ')}`)
  }
  const metrics = build.received.find((command) => command.method === 'Emulation.setDeviceMetricsOverride')
  assert.deepEqual(metrics?.params, { width: 640, height: 480, fixedLayout: false, deviceScaleFactor: 2 })
  const world = build.received.find((command) => command.method === 'Page.createUserWorld')
  assert.deepEqual(world?.params, { name: 'retest' })
  assert.equal(page.mainFrameId, 'frame-1')
})

test("the main frame's commits are told as navigations with their address, and a move within the document only for a new path", { timeout: 10_000 }, async (t) => {
  const { build, page } = openPage(t)
  answerSetup(build)
  build.proxyEvent('7', 'Target.targetCreated', { targetInfo: { targetId: 'page-8', type: 'page', isPaused: true } })
  await page.ready
  const seen: PageNavigation[] = []
  page.onNavigation((navigation) => void seen.push(navigation))
  build.targetEvent('7', 'page-8', 'Page.frameNavigated', { frame: { id: 'frame-1', loaderId: 'L1', url: 'http://app.test/tasks?token=secret', securityOrigin: 'http://app.test', mimeType: 'text/html' } })
  build.targetEvent('7', 'page-8', 'Page.navigatedWithinDocument', { frameId: 'frame-1', url: 'http://app.test/tasks#details' })
  build.targetEvent('7', 'page-8', 'Page.navigatedWithinDocument', { frameId: 'frame-1', url: 'http://app.test/done' })
  build.targetEvent('7', 'page-8', 'Page.frameNavigated', { frame: { id: 'child', parentId: 'frame-1', loaderId: 'L2', url: 'http://ads.test/', securityOrigin: '', mimeType: 'text/html' } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(seen.map(({ url, document, cause }) => [url, document, cause]), [
    ['http://app.test/tasks', 'new', 'page'],
    ['http://app.test/done', 'same', 'page'],
  ])
  assert.equal(page.url, 'http://app.test/done')
})

test('a dialog holds the page: a command fails at once, naming the dialog, until it closes', { timeout: 10_000 }, async (t) => {
  const { build, page } = openPage(t)
  answerSetup(build)
  build.proxyEvent('7', 'Target.targetCreated', { targetInfo: { targetId: 'page-8', type: 'page', isPaused: true } })
  await page.ready
  build.proxyEvent('7', 'Dialog.javascriptDialogOpening', { type: 'alert', message: 'Careful' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const held = await page.execute({ kind: 'observe', locator: { by: 'testId', value: 'save' } }, 1000)
  assert.deepEqual(held, { ok: false, failure: { class: 'unsupported', message: "The page opened an alert dialog while Retest tried to read getByTestId('save'). Retest does not answer dialogs yet, and the dialog blocks the page.", details: { dialog: 'alert', inputSent: false } } })
  await assert.rejects(page.screenshot(500), /alert dialog/)
})

test('a crash of the page target loses the page, telling its collector once, and every command after it fails as lost', { timeout: 10_000 }, async (t) => {
  const { build, page } = openPage(t)
  answerSetup(build)
  build.proxyEvent('7', 'Target.targetCreated', { targetInfo: { targetId: 'page-8', type: 'page', isPaused: true } })
  await page.ready
  const losses: unknown[] = []
  page.onLost((loss) => losses.push(loss))
  build.proxyEvent('7', 'Target.targetDestroyed', { targetId: 'page-8', crashed: true })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(losses, [{ reason: 'the page crashed', crashed: true }])
  const after = await page.execute({ kind: 'click', locator: { by: 'testId', value: 'save' } }, 1000)
  assert.deepEqual(after, { ok: false, failure: { class: 'session_lost', message: "Retest lost the page before it could click getByTestId('save'): the page crashed.", details: { reason: 'the page crashed' } } })
  const late: unknown[] = []
  page.onLost((loss) => late.push(loss))
  assert.deepEqual(late, [{ reason: 'the page crashed', crashed: true }], 'a listener that comes later hears it at once')
})

test('a navigation into a new web process sets the provisional target up before it runs, and follows it once committed', { timeout: 10_000 }, async (t) => {
  const { build, page } = openPage(t)
  answerSetup(build)
  build.proxyEvent('7', 'Target.targetCreated', { targetInfo: { targetId: 'page-8', type: 'page', isPaused: true } })
  await page.ready
  build.proxyEvent('7', 'Target.targetCreated', { targetInfo: { targetId: 'page-50', type: 'page', isProvisional: true, isPaused: true } })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const provisional = build.received.filter((command) => command.targetId === 'page-50').map((command) => command.method)
  for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable', 'Page.createUserWorld', 'Runtime.addBinding', 'Page.setBootstrapScript']) assert.ok(provisional.includes(method), method)
  assert.ok(build.received.some((command) => command.method === 'Target.resume' && command.params['targetId'] === 'page-50'))
  assert.equal(build.received.filter((command) => command.method === 'Emulation.setDeviceMetricsOverride').length, 1, 'the screen belongs to the page proxy, set once')
  build.proxyEvent('7', 'Target.didCommitProvisionalTarget', { oldTargetId: 'page-8', newTargetId: 'page-50' })
  build.targetEvent('7', 'page-50', 'Page.frameNavigated', { frame: { id: 'frame-2', loaderId: 'L5', url: 'http://other.test/', securityOrigin: 'http://other.test', mimeType: 'text/html' } })
  await nextTurn()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(page.bridge.targetId, 'page-50')
  assert.equal(page.mainFrameId, 'frame-2')
  assert.equal(page.url, 'http://other.test/')
})

// The real build names a move through the history onto a response with no content only by its document's failed
// request, with no `Playwright.provisionalLoadFailed`; `webkit-browser-navigation.test.ts` shows it on the build.
test("a document request that fails before its document commits gives the navigation up, and one that fails after leaves the document", { timeout: 10_000 }, async (t) => {
  const { build, page } = openPage(t)
  answerSetup(build)
  build.proxyEvent('7', 'Target.targetCreated', { targetInfo: { targetId: 'page-8', type: 'page', isPaused: true } })
  await page.ready
  build.targetEvent('7', 'page-8', 'Page.frameNavigated', { frame: { id: 'frame-1', loaderId: 'L1', url: 'http://app.test/flip?for=reload', securityOrigin: 'http://app.test', mimeType: 'text/html' } })
  await nextTurn()
  const reloaded = page.execute({ kind: 'reload' }, 2000)
  await sent(build, 'Page.reload', 1)
  build.targetEvent('7', 'page-8', 'Network.requestWillBeSent', { requestId: 'R5', frameId: 'frame-1', loaderId: 'L5', request: { url: 'http://app.test/flip?for=reload' }, type: 'Document' })
  build.targetEvent('7', 'page-8', 'Network.responseReceived', { requestId: 'R5', frameId: 'frame-1', loaderId: 'L5', type: 'Document', response: { url: 'http://app.test/flip?for=reload', status: 204 } })
  build.targetEvent('7', 'page-8', 'Network.loadingFailed', { requestId: 'R5', errorText: 'Frame load interrupted', canceled: true })
  assert.deepEqual(await reloaded, {
    ok: false,
    failure: {
      class: 'not_actionable',
      message: 'Could not reload http://app.test/flip: the browser sent the request and gave the navigation up without opening a document, as it does for a response with no content or a download. The page stayed on http://app.test/flip.',
      details: { url: 'http://app.test/flip', inputSent: true },
    },
  })

  const cut = page.execute({ kind: 'reload' }, 300)
  await sent(build, 'Page.reload', 2)
  build.targetEvent('7', 'page-8', 'Network.requestWillBeSent', { requestId: 'R6', frameId: 'frame-1', loaderId: 'L6', request: { url: 'http://app.test/flip?for=reload' }, type: 'Document' })
  build.targetEvent('7', 'page-8', 'Page.frameNavigated', { frame: { id: 'frame-1', loaderId: 'L6', url: 'http://app.test/flip?for=reload', securityOrigin: 'http://app.test', mimeType: 'text/html' } })
  build.targetEvent('7', 'page-8', 'Network.loadingFailed', { requestId: 'R6', errorText: 'The network connection was lost.' })
  const result = await cut
  assert.equal(result.ok, false)
  assert.equal(result.ok ? undefined : result.failure.class, 'timeout', 'the committed document is still loading, not given up')
})

/** Waits until the build has received `method` `count` times. */
async function sent(build: ScriptedBuild, method: string, count: number): Promise<void> {
  while (build.received.filter((command) => command.method === method).length < count) await new Promise((resolve) => setTimeout(resolve, 2))
}

test('a timeout waits out its budget by the clock before it is told, and a stop ends the wait at once', { timeout: 10_000 }, async () => {
  for (const budget of [1, 7, 23]) {
    const endsAt = monotonicClock() + budget
    await outlast(endsAt, undefined)
    assert.ok(monotonicClock() >= endsAt, `waited out ${budget} ms`)
  }
  const stop = new AbortController()
  const started = monotonicClock()
  setTimeout(() => stop.abort(), 5)
  await outlast(started + 5000, stop.signal)
  assert.ok(monotonicClock() - started < 1000, 'the stop ended the wait')
})

// The conformance run on build 2359 saw a covered checkbox refused after 499 of its 500 ms: the browser call of the last
// look timed out early by the clock, so the deadline still read a millisecond left, and the refusal, which says it
// waited 500 ms, was told at once. Whether a failure is held is read from the failure, not only from the deadline.
test('a timeout, or a failure that says it waited the whole budget, is held to its budget; one that fails at once is not', { timeout: 10_000 }, () => {
  assert.equal(waitedWholeBudget({ class: 'not_actionable', message: 'covered', details: { check: 'hit-target', covering: 'div', waitedMs: 500 } }, 500), true)
  assert.equal(waitedWholeBudget({ class: 'not_found', message: 'no element matched', details: { waitedMs: 500 } }, 500), true)
  assert.equal(waitedWholeBudget({ class: 'timeout', message: 'did not finish loading', details: { url: 'http://app.test/' } }, 500), true)
  assert.equal(waitedWholeBudget({ class: 'not_actionable', message: 'two elements matched', details: { count: 2 } }, 500), false, 'a strict-match failure is told at once')
  assert.equal(waitedWholeBudget({ class: 'not_actionable', message: 'gave the navigation up', details: { url: 'http://app.test/', inputSent: true } }, 500), false)
  assert.equal(waitedWholeBudget({ class: 'not_found', message: 'no element matched', details: { waitedMs: 300 } }, 500), false, 'a wait of another budget is not this command')
})

test('a page with no screen of its own takes the default one', { timeout: 10_000 }, () => {
  assert.deepEqual(defaultScreen, { viewport: { width: 756, height: 469 }, deviceScaleFactor: 1 })
})

// W-10: a page whose context could not be deleted stayed subscribed to every later event of its page proxy on a pooled
// browser, and the connection kept an empty listener entry for every page that ever was.
test('a disposed page hears nothing more of its page proxy, even when its context could not be deleted, and the connection lets its entries go', { timeout: 10_000 }, async (t) => {
  const { build, page } = openPage(t)
  build.serve((command) => (command.method === 'Playwright.deleteContext' ? new Error('the context is busy') : undefined))
  answerSetup(build)
  build.proxyEvent('7', 'Target.targetCreated', { targetInfo: { targetId: 'page-8', type: 'page', isPaused: true } })
  await page.ready
  const disposed = await page.dispose(1000).catch((error: unknown) => error)
  assert.ok(disposed instanceof Error && /Could not close the page's browser context/.test(disposed.message), String(disposed))
  const before = build.received.length
  build.proxyEvent('7', 'Target.targetCreated', { targetInfo: { targetId: 'page-9', type: 'page', isPaused: true } })
  build.proxyEvent('7', 'Dialog.javascriptDialogOpening', { type: 'alert', message: 'late' })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(build.received.slice(before).map((command) => command.method), [], 'the page sets nothing up for a target of a page it no longer is')
  assert.equal(build.connection.listenedPages, 0, 'no entry is left for the page')
  const listening = build.connection.onTargetEvent('8', () => undefined)
  assert.equal(build.connection.listenedPages, 1)
  listening()
  listening()
  assert.equal(build.connection.listenedPages, 0, 'a page goes with its last listener, and a second stop does nothing more')
})
