import type { TestContext } from 'node:test'
import type { Emulation, OwnedPage } from '../../src/browser/contract.ts'
import type { TaskAppMode } from '../../fixtures/task-app/modes.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emulationFor } from '../../src/config/devices.ts'
import {
  assertOk,
  byRole,
  click,
  failureOf,
  fill,
  goto,
  observe,
  observeUntil,
  openApp,
  openPage,
  servePages,
  sharedBrowser,
  tap,
  timed,
} from './browser-harness.ts'

const browser = sharedBrowser()

async function emulatedPage(t: TestContext, emulation: Emulation | undefined, mode?: TaskAppMode) {
  const app = await openApp(t, mode === undefined ? {} : { mode })
  const page = await openPage(t, browser(), app.url, emulation === undefined ? {} : { emulation })
  return { app, page }
}

async function readDevice(page: OwnedPage) {
  assertOk(await goto(page, '/device'))
  const read = async (testId: string) => (await observe(page, testId)).text
  return {
    width: await read('width'),
    pixelRatio: await read('pixel-ratio'),
    touch: await read('touch'),
    userAgent: await read('user-agent'),
    userAgentHeader: await read('user-agent-header'),
    clientHints: await read('client-hints'),
    clientHintsHeader: await read('client-hints-header'),
  }
}

test('a named device sets the viewport, the pixel ratio, a touch screen and its user agent, and sends no client hints', async (t) => {
  const pixel = emulationFor('Pixel 9', browser().version)
  const { page } = await emulatedPage(t, pixel)
  assert.deepEqual(await readDevice(page), {
    width: '412',
    pixelRatio: '2.625',
    touch: 'true',
    userAgent: pixel.userAgent,
    userAgentHeader: pixel.userAgent,
    clientHints: '',
    clientHintsHeader: '',
  })
})

test('a screen of its own without a user agent keeps the browser user agent and has no touch screen', async (t) => {
  const screen = { viewport: { width: 800, height: 600 }, deviceScaleFactor: 1, touch: false, isMobile: false }
  const { page } = await emulatedPage(t, screen)
  const { clientHints, clientHintsHeader, ...device } = await readDevice(page)
  assert.deepEqual(device, {
    width: '800',
    pixelRatio: '1',
    touch: 'false',
    userAgent: browser().userAgent,
    userAgentHeader: browser().userAgent,
  })
  assert.match(clientHints ?? '', /Chrom/, 'the page keeps reading the browser client hints')
  assert.match(clientHintsHeader ?? '', /v="\d+"/, 'the browser keeps sending its own client hints')
})

test('a page without emulation keeps the browser own screen and has no touch screen', async (t) => {
  const { page } = await emulatedPage(t, undefined)
  const device = await readDevice(page)
  assert.equal(device.touch, 'false')
  assert.equal(device.userAgent, browser().userAgent)
})

test('the emulation holds for every document the page opens', async (t) => {
  const { page } = await emulatedPage(t, emulationFor('iPhone 17', browser().version))
  assertOk(await goto(page, '/'))
  assert.equal((await readDevice(page)).width, '402')
  assertOk(await goto(page, '/device'))
  assert.equal((await readDevice(page)).width, '402')
})

test('tap fires the touch handlers and then the click handler, and reports a tap', async (t) => {
  const { app, page } = await emulatedPage(t, emulationFor('Pixel 9', browser().version))
  assertOk(await goto(page, '/device'))
  assert.deepEqual(await tap(page, 'touch-target'), { ok: true, kind: 'tap', page: { url: `${app.url}/device`, title: 'Device' } })
  assert.equal((await observe(page, 'touch-events')).text, 'touchstart touchend click:touch')
})

test('on a touch screen a click is sent as a tap and reported as one', async (t) => {
  const { app, page } = await emulatedPage(t, emulationFor('Galaxy S24', browser().version))
  assertOk(await goto(page, '/device'))
  assert.deepEqual(await click(page, byRole('button', 'Touch me')), { ok: true, kind: 'tap', page: { url: `${app.url}/device`, title: 'Device' } })
  assert.equal((await observe(page, 'touch-events')).text, 'touchstart touchend click:touch')
})

test('a click on a screen without touch is a mouse click', async (t) => {
  const { app, page } = await emulatedPage(t, undefined)
  assertOk(await goto(page, '/device'))
  assert.deepEqual(await click(page, 'touch-target'), { ok: true, kind: 'click', page: { url: `${app.url}/device`, title: 'Device' } })
  assert.equal((await observe(page, 'touch-events')).text, 'click:mouse')
})

test('tap on a page without a touch screen fails at once as unsupported and sends nothing', async (t) => {
  const { page } = await emulatedPage(t, undefined)
  assertOk(await goto(page, '/device'))
  const { value: result, ms } = await timed(tap(page, 'touch-target', 5000))
  assert.deepEqual(failureOf(result), {
    class: 'unsupported',
    message: "Could not tap getByTestId('touch-target'): the page does not emulate a touch screen, and tap() needs one.",
  })
  assert.ok(ms < 500, `took ${ms} ms`)
  assert.equal((await observe(page, 'touch-events')).text, '')
})

test('tap saves a task on the task page, whose layout is zoomed out to fit a phone', async (t) => {
  const { app, page } = await emulatedPage(t, emulationFor('Pixel 9', browser().version))
  assertOk(await goto(page, '/'))
  assertOk(await fill(page, 'task-title', 'Release checklist'))
  assert.deepEqual(await tap(page, 'save-task'), { ok: true, kind: 'tap', page: { url: `${app.url}/`, title: 'Tasks' } })
  await observeUntil(page, 'saved-task', (seen) => seen.text === 'Release checklist')
  assert.equal(app.submissions(), 1)
})

// Without a viewport tag a phone lays the page out 980 pixels wide, and zooms out further to fit wider content. The
// fixed button sits beyond that layout viewport, where no scrolling can bring it, yet it is on screen.
const WIDE_PAGE = `<!doctype html><body style="margin: 0"><div style="width: 2000px; height: 10px"></div>
<button data-testid="far" style="position: fixed; left: 1200px; top: 300px; width: 200px; height: 100px">Far</button>
<p data-testid="status">none</p>
<script>document.querySelector('[data-testid="far"]').addEventListener('click', () => {
  document.querySelector('[data-testid="status"]').textContent = 'tapped at ' + Math.round(visualViewport.scale * 100) + '%'
})</script>`

test('tap reaches a fixed element beyond the layout viewport of a page zoomed out to fit a phone', async (t) => {
  const site = await servePages(t, { '/': WIDE_PAGE })
  const page = await openPage(t, browser(), site.url, { emulation: emulationFor('Pixel 9', browser().version) })
  assertOk(await goto(page, '/'))
  assertOk(await tap(page, 'far'))
  await observeUntil(page, 'status', (seen) => seen.text === 'tapped at 25%')
})

test('tap has the same checks as click: an overlay stops it before any touch is sent', async (t) => {
  const { app, page } = await emulatedPage(t, emulationFor('Pixel 9', browser().version), 'overlay')
  assertOk(await goto(page, '/'))
  const failure = failureOf(await tap(page, 'save-task', 500))
  assert.equal(failure.class, 'not_actionable')
  assert.deepEqual(failure.details, { check: 'hit-target', covering: '<div>', waitedMs: 500 })
  assert.equal(failure.message, "Could not tap getByTestId('save-task') within 500 ms: another element, <div>, covers its centre.")
  assert.equal(app.submissions(), 0)
})

test('a cover that appears when the screen is touched takes the click the tap makes, and the page never hears it', async (t) => {
  const { app, page } = await emulatedPage(t, emulationFor('Pixel 9', browser().version), 'covered-on-press')
  assertOk(await goto(page, '/'))
  assertOk(await fill(page, 'task-title', 'Release checklist'))
  const failure = failureOf(await tap(page, 'save-task'))
  assert.equal(failure.class, 'not_actionable')
  assert.equal(
    failure.message,
    `Could not tap getByTestId('save-task'): it took the touch, but the click that follows a tap went to another element, <div data-testid="cover">. Retest stopped the click before the page received it.`,
  )
  assert.deepEqual(failure.details, { check: 'hit-target', interceptedBy: '<div data-testid="cover">', event: 'mousedown' })
  assert.equal((await observe(page, 'saved-task')).text, '')
  assert.equal(app.submissions(), 0)
})
