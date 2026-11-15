import type { NewPageOptions } from '../../src/browser/contract.ts'
import type { DiagnosticSink, Observation } from '../../src/diagnostics/observations.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recordedWindow } from '../../src/browser/default-window.ts'
import { assertOk, goto, launchGated, observe, openPage, servePages, setupMs, within } from './browser-harness.ts'

// How a Chromium page opens on real Chrome, counted on the wire: which commands go out together, and how many times
// opening a page waits for an answer before it sends more.

/** The wire in order: each command Retest sent, by method, and each answer the browser gave to one. */
type Wire = ({ readonly sent: string } | { readonly answered: true })[]

// What the browser's popup watch sends by itself as it lets go of a page it held, which no page's opening waits on.
const watchCommands: ReadonlySet<string> = new Set(['Runtime.runIfWaitingForDebugger', 'Target.detachFromTarget'])

/** The rounds in a stretch of the wire: each the commands sent with no answer between them, the watch's left out. */
function rounds(wire: Wire): string[][] {
  const found: string[][] = []
  let current: string[] | undefined
  for (const entry of wire) {
    if ('answered' in entry) {
      current = undefined
      continue
    }
    if (watchCommands.has(entry.sent)) continue
    if (current === undefined) {
      current = []
      found.push(current)
    }
    current.push(entry.sent)
  }
  return found
}

// The page's own set-up, after its emulation, in the order it goes out: its frame read before its events are on and
// again after, the browser's popup watch, when the page starts it, going between.
const beforeWatch = ['Page.getFrameTree', 'Page.enable', 'Emulation.setFocusEmulationEnabled']
const afterWatch = [
  'Page.getFrameTree',
  'Page.setLifecycleEventsEnabled',
  'Runtime.enable',
  'Runtime.addBinding',
  'Page.addScriptToEvaluateOnNewDocument',
  'Page.addScriptToEvaluateOnNewDocument',
  'Page.addScriptToEvaluateOnNewDocument',
  'Page.setInterceptFileChooserDialog',
]

const touchPhone: NewPageOptions['emulation'] = { viewport: { width: 400, height: 700 }, deviceScaleFactor: 1, touch: true, isMobile: true }

test('a page opens in four rounds of commands, its whole set-up in the last, and its capture starts in one more', async (t) => {
  const wire: Wire = []
  const browser = await launchGated(t, {
    hold: (method) => {
      wire.push({ sent: method })
      return undefined
    },
    watch: (message) => {
      if (message['id'] !== undefined) wire.push({ answered: true })
    },
  })
  const site = await servePages(t, { '/': '<!doctype html><p data-testid="text">Here</p><script>console.log("set up and heard")</script>' })
  // Chrome's headless shell is also given Chrome's languages, user agent and fonts, after any emulation, and its context
  // Chrome's default grants; Chrome for Testing and the shell of the pinned release, headless, give a page with no
  // emulation Retest 0.4.2's window.
  const shell = browser.product === 'HeadlessChrome'
  const parity = shell ? ['Emulation.setUserAgentOverride', 'Page.setFontFamilies'] : []
  const window = recordedWindow({ product: browser.product, version: browser.version, userAgent: browser.userAgent }) === undefined ? [] : ['Emulation.setDeviceMetricsOverride']
  const grants = shell ? ['Browser.setPermission', 'Browser.setPermission', 'Browser.setPermission'] : []
  const cases = [
    // The first page of a browser starts the browser's popup watch, in the same round as its own set-up.
    { options: {}, setUp: [...parity, ...window, ...beforeWatch, 'Target.setAutoAttach', ...afterWatch] },
    { options: {}, setUp: [...parity, ...window, ...beforeWatch, ...afterWatch] },
    { options: { emulation: touchPhone }, setUp: ['Emulation.setDeviceMetricsOverride', 'Emulation.setTouchEmulationEnabled', ...parity, ...beforeWatch, ...afterWatch] },
  ]
  for (const { options, setUp } of cases) {
    const start = wire.length
    const page = await openPage(t, browser, site.url, options)
    const opened = wire.length
    assert.deepEqual(rounds(wire.slice(start, opened)), [
      ['Target.createBrowserContext'],
      ['Browser.setDownloadBehavior', 'Target.createTarget', ...grants],
      ['Target.attachToTarget'],
      setUp,
    ])
    // The page's Runtime domain, enabled as it opened, is the one the collector hears console messages through.
    const { promise: heard, resolve } = Promise.withResolvers<Observation>()
    const sink: DiagnosticSink = {
      observe: (observation) => {
        if (observation.kind === 'console') resolve(observation)
      },
      unreadable: () => undefined,
      lost: () => undefined,
    }
    assert.ok(page.collectDiagnostics !== undefined)
    const collection = await page.collectDiagnostics(sink, setupMs)
    t.after(() => collection.stop())
    assert.deepEqual(rounds(wire.slice(opened)), [['Log.enable', 'Network.enable']])
    assertOk(await goto(page, '/'))
    assert.equal((await observe(page, 'text')).text, 'Here')
    const message = await within(heard, setupMs, 'the collector heard no console message from the page')
    assert.equal(message.kind === 'console' ? message.text : undefined, 'set up and heard')
  }
})
