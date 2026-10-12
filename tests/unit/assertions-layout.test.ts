import type { LayoutLook, LayoutTarget } from '../../src/protocol/layout.ts'
import type { Responder } from '../support/api/in-process-run.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { expect } from '../../src/index.ts'
import { callLoosely } from '../support/api/call-loosely.ts'
import { appOf, inProcessRun } from '../support/api/in-process-run.ts'

const file = 'tests/unit/assertions-layout.test.ts'

function shown(left: number, top: number, right: number, bottom: number, cut?: number): LayoutTarget {
  const box = { left, top, right, bottom }
  return { count: 1, element: { shown: true, box, seen: box, field: false, ...(cut === undefined ? {} : { cut }) } }
}

const narrow = { viewport: { width: 390, height: 844 }, edge: 390, documentWidth: 390, hidesSideways: false }

// A page whose layout looks answer with `targets`, one per locator asked, and the page as `page` says.
function measuring(targets: (count: number) => LayoutTarget[], page: Partial<LayoutLook> = {}): Responder {
  return (command) => {
    if (command.kind !== 'observeLayout') return { ok: true, kind: 'click' }
    const asked = [command.locator, command.other].filter((locator) => locator !== undefined).length
    return { ok: true, kind: 'observeLayout', observation: { ...narrow, ...page, targets: targets(asked) } }
  }
}

describe('layout matchers in a test', () => {
  test('toOverlap measures both elements in one look, and its negation passes on elements apart, recording what it measured', async () => {
    const run = inProcessRun(file, measuring(() => [shown(0, 0, 100, 40), shown(120, 0, 200, 40)]), { timeouts: { assertion: 200 } })
    const verdict = await run.runPage(({ page }) => expect(page.getByTestId('save')).not.toOverlap(page.getByTestId('help')))
    assert.equal(verdict.status, 'passed')
    assert.deepEqual(run.commands, [{ kind: 'observeLayout', locator: { by: 'testId', value: 'save' }, other: { by: 'testId', value: 'help' }, check: true }])
    const [passed] = run.events().filter((event) => event.type === 'assertion.passed')
    assert.equal(passed?.matcher, 'not.toOverlap')
    assert.deepEqual(passed?.check, { matcher: 'toOverlap', other: { by: 'testId', value: 'help' }, not: true })
    assert.deepEqual(passed?.locator, { by: 'testId', value: 'save' })
    assert.equal(passed?.actual?.text, 'do not touch at 390 pixels wide')
    assert.deepEqual(passed?.layout, { viewport: { width: 390, height: 844 }, edge: 390, shared: { across: -20, down: 40 } })
  })

  test('a negated toOverlap on elements that overlap fails naming the pixels and the width, after looking until its time is up', async () => {
    const run = inProcessRun(file, measuring(() => [shown(0, 0, 100, 40), shown(68, 8, 200, 40)]), { timeouts: { assertion: 120 } })
    const verdict = await run.runPage(({ page }) => expect(page.getByTestId('save')).not.toOverlap(page.getByTestId('help')))
    assert.equal(verdict.failure?.class, 'check_failed')
    assert.match(verdict.failure?.message ?? '', /^getByTestId\('save'\) and getByTestId\('help'\) overlap: they share 32 by 32 pixels at 390 pixels wide\. Looked \d+ times in 120 ms\.$/)
    assert.ok(run.commands.length > 1, 'it looked again')
    const [failed] = run.events().filter((event) => event.type === 'assertion.failed')
    assert.deepEqual(failed?.layout?.shared, { across: 32, down: 32 })
    assert.equal(failed?.expected?.text, "share no more than 4 pixels across or down with getByTestId('help')")
  })

  test('toOverlap passes once the elements overlap, and a missing element fails as not found', async () => {
    let looks = 0
    const moving = measuring(() => (++looks < 3 ? [shown(0, 0, 100, 40), shown(150, 0, 200, 40)] : [shown(0, 0, 100, 40), shown(60, 0, 200, 40)]))
    const run = inProcessRun(file, moving, { timeouts: { assertion: 2000 } })
    assert.equal((await run.runPage(({ page }) => expect(page.getByTestId('save')).toOverlap(page.getByTestId('help')))).status, 'passed')
    assert.equal(looks, 3)
    const missing = inProcessRun(file, measuring(() => [shown(0, 0, 100, 40), { count: 0 }]), { timeouts: { assertion: 120 } })
    const verdict = await missing.runPage(({ page }) => expect(page.getByTestId('save')).toOverlap(page.getByTestId('help')))
    assert.equal(verdict.failure?.class, 'not_found')
    assert.match(verdict.failure?.message ?? '', /^getByTestId\('help'\) matched no element\. Looked \d+ times in 120 ms\.$/)
  })

  test('toOverflowViewport looks at one element, and its negation fails naming how far past the edge it ends', async () => {
    const run = inProcessRun(file, measuring(() => [shown(300, 0, 404, 40)]), { timeouts: { assertion: 120 } })
    const verdict = await run.runPage(async ({ page }) => {
      await expect(page.getByTestId('price')).toOverflowViewport()
      await expect(page.getByTestId('price')).not.toOverflowViewport()
    })
    assert.deepEqual(run.commands[0], { kind: 'observeLayout', locator: { by: 'testId', value: 'price' }, check: true })
    assert.equal(verdict.failure?.class, 'check_failed')
    assert.match(verdict.failure?.message ?? '', /^getByTestId\('price'\) ends 14 pixels past the right edge at 390 pixels wide\. Looked \d+ times in 120 ms\.$/)
  })

  test('toHaveClippedText asks for the words, and its negation fails naming the pixels cut off', async () => {
    const run = inProcessRun(file, measuring(() => [shown(0, 0, 100, 20, 14)]), { timeouts: { assertion: 120 } })
    const verdict = await run.runPage(({ page }) => expect.soft(page.getByTestId('title')).not.toHaveClippedText())
    assert.deepEqual(run.commands[0], { kind: 'observeLayout', locator: { by: 'testId', value: 'title' }, words: true, check: true })
    assert.match(verdict.failure?.message ?? '', /^A container cuts off 14 pixels of the words in getByTestId\('title'\) at 390 pixels wide\. Looked \d+ times in 120 ms\.$/)
    const [failed] = run.events().filter((event) => event.type === 'assertion.failed')
    assert.equal(failed?.soft, true)
    assert.equal(failed?.actual?.text, 'cut 14 pixels at 390 pixels wide')
    assert.deepEqual(failed?.layout, { viewport: { width: 390, height: 844 }, edge: 390, cut: 14 })
  })

  test('toScrollHorizontally measures the page alone, and its negation fails naming the width of the document', async () => {
    const run = inProcessRun(file, measuring(() => [], { documentWidth: 1024 }), { timeouts: { assertion: 120 } })
    const verdict = await run.runPage(async ({ page }) => {
      await expect(page).toScrollHorizontally({ timeout: 60 })
      await expect(page).not.toScrollHorizontally()
    })
    assert.deepEqual(run.commands[0], { kind: 'observeLayout', check: true })
    assert.match(verdict.failure?.message ?? '', /^The page is 1024 pixels wide and scrolls 634 pixels sideways at 390 pixels wide\. Looked \d+ times in 120 ms\.$/)
    const events = run.events().filter((event) => event.type === 'assertion.passed' || event.type === 'assertion.failed')
    assert.deepEqual(events.map((event) => [event.type, event.matcher, event.locator, event.timeoutMs]), [
      ['assertion.passed', 'toScrollHorizontally', undefined, 60],
      ['assertion.failed', 'not.toScrollHorizontally', undefined, 120],
    ])
  })

  test('toOverlap takes a locator of the same page, and refuses anything else before it looks', async () => {
    const text = inProcessRun(file, measuring(() => []))
    const notLocator = await text.runPage(({ page }) => callLoosely(expect(page.getByTestId('save')), 'toOverlap', ['help']))
    assert.equal(notLocator.failure?.class, 'usage')
    assert.match(notLocator.failure?.message ?? '', /^toOverlap\(\) takes the other element's locator, such as page\.getByTestId\('help'\), received /)
    const run = inProcessRun(file, measuring(() => []), { apps: ['web', 'admin'] })
    const verdict = await run.runTest({
      apps: ['web', 'admin'],
      body: (context) => expect(appOf(context, 'web').getByTestId('save')).toOverlap(appOf(context, 'admin').getByTestId('help')),
    })
    assert.equal(verdict.failure?.class, 'usage')
    assert.equal(verdict.failure?.message, "toOverlap() compares two elements of one page: getByTestId('save') is on web and getByTestId('help') on admin.")
    assert.deepEqual([...text.commands, ...run.commands], [], 'nothing was measured')
  })

  test('a layout matcher on a value is refused as a misplaced matcher', async () => {
    const run = inProcessRun(file, measuring(() => []))
    const verdict = await run.runPage(() => callLoosely(expect(3), 'toOverflowViewport', []))
    assert.equal(verdict.failure?.class, 'usage')
    assert.equal(verdict.failure?.message, 'toOverflowViewport is for locators. Use toBe on a value.')
    const page = await inProcessRun(file, measuring(() => [])).runPage(() => callLoosely(expect('page'), 'toScrollHorizontally', []))
    assert.equal(page.failure?.message, 'toScrollHorizontally is for a page. Use toBe on a value.')
  })
})
