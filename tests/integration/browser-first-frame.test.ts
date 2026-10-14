import assert from 'node:assert/strict'
import { test } from 'node:test'
import { firstFrameWaitMs } from '../../src/browser/first-frame.ts'
import { assertOk, check, goto, openPage, servePages, setupMs, sharedBrowser, timed } from './browser-harness.ts'

const browser = sharedBrowser()

/**
 * A page that, once it has loaded, keeps its main thread busy for `ms` from its next task, so the browser draws its
 * first frame only after that, as a slow runner drew the first frame of a page that had just loaded.
 */
function busyOnceLoaded(ms: number): string {
  return `<!doctype html><title>Busy</title><link rel="icon" href="data:,"><input type="checkbox" data-testid="box"><script>
  addEventListener('load', () => setTimeout(() => { const end = performance.now() + ${ms}; while (performance.now() < end) {} }, 0))
</script>`
}

test('an action right after a goto to a page busy once it loaded answers within its own budget, since the goto waited for the first frame', async (t) => {
  const site = await servePages(t, { '/': busyOnceLoaded(1500) })
  const page = await openPage(t, browser(), site.url)
  const opened = await goto(page, '/')
  assertOk(opened)
  assert.equal(opened.ok && 'firstFrame' in opened, false, 'the goto ended once the page was drawn')
  const checked = await timed(check(page, 'box', 500))
  assertOk(checked.value)
  assert.ok(checked.ms < 500, `the check answered within its own 500 ms: ${Math.round(checked.ms)} ms`)
})

test('a page still busy when the wait ends does not hold its goto, which says the page drew no first frame', async (t) => {
  const busyMs = 6000
  const site = await servePages(t, { '/': busyOnceLoaded(busyMs) })
  const page = await openPage(t, browser(), site.url)
  const opened = await timed(goto(page, '/', 10_000))
  assert.deepEqual(opened.value, { ok: true, kind: 'goto', url: `${site.url}/`, page: { url: `${site.url}/` }, firstFrame: false })
  assert.ok(opened.ms >= firstFrameWaitMs, `the goto waited for the frame first: ${Math.round(opened.ms)} ms`)
  assert.ok(opened.ms < busyMs, `the goto ended while the page was still busy: ${Math.round(opened.ms)} ms`)
  // Firefox closes a page whose main thread is busy only once it is free again, so the test ends on an idle page.
  const idle = await page.execute({ kind: 'observe', locator: { by: 'testId', value: 'box' } }, busyMs + setupMs)
  assert.ok(idle.ok && idle.kind === 'observe' && idle.observation.count === 1, JSON.stringify(idle))
})
