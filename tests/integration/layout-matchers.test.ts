import assert from 'node:assert/strict'
import { test } from 'node:test'
import { layoutPage } from '../../fixtures/layout/page.ts'
import { browserPath } from '../support/test-browser.ts'
import { servePages } from './browser-harness.ts'
import { budgets, configSource, eventsOf, runProject, testNamed, writeProject } from './cli-harness.ts'

// The layout matchers on Chromium, end to end: a test file run from a config whose two apps open the fixture page at
// 390 and at 1280 pixels wide. At 390 the buttons overlap, the price ends past the edge and the page scrolls sideways;
// at 1280 none of that holds. The card clips its title at both widths, and the ellipsis note is never cut off.

const tests = `import { expect, test } from '@rehearsal-labs/retest'

test('the narrow page shows each layout problem', { apps: ['narrow'] }, async ({ narrow }) => {
  await narrow.goto('/')
  await expect(narrow.getByTestId('save')).toOverlap(narrow.getByTestId('help'))
  await expect(narrow.getByTestId('clear')).not.toOverlap(narrow.getByTestId('search'))
  await expect(narrow.getByTestId('price')).toOverflowViewport()
  await expect(narrow.getByTestId('clipped-title')).toHaveClippedText()
  await expect(narrow.getByTestId('card')).toHaveClippedText()
  await expect(narrow.getByTestId('shortened')).not.toHaveClippedText()
  await expect(narrow).toScrollHorizontally()
})

test('the wide page shows none of the problems the width causes', { apps: ['wide'] }, async ({ wide }) => {
  await wide.goto('/')
  await expect(wide.getByTestId('save')).not.toOverlap(wide.getByTestId('help'))
  await expect(wide.getByTestId('price')).not.toOverflowViewport()
  await expect(wide).not.toScrollHorizontally()
  await expect(wide.getByTestId('clipped-title')).toHaveClippedText()
})

test('their absence fails at the narrow width, naming each measurement', { apps: ['narrow'] }, async ({ narrow }) => {
  await narrow.goto('/')
  await expect.soft(narrow.getByTestId('save')).not.toOverlap(narrow.getByTestId('help'))
  await expect.soft(narrow.getByTestId('price')).not.toOverflowViewport()
  await expect.soft(narrow.getByTestId('clipped-title')).not.toHaveClippedText()
  await expect.soft(narrow).not.toScrollHorizontally()
})

test('a measurement that cannot be taken passes neither way', { apps: ['narrow'] }, async ({ narrow }) => {
  await narrow.goto('/')
  await expect.soft(narrow.getByTestId('save')).not.toOverlap(narrow.getByTestId('missing'))
  await expect.soft(narrow.getByTestId('card')).not.toOverlap(narrow.getByTestId('clipped-title'))
  await expect.soft(narrow.getByTestId('search')).not.toHaveClippedText()
})
`

test('the layout matchers measure a real page at two emulated widths, and say what they measured', async (t) => {
  const pages = await servePages(t, { '/': layoutPage })
  const target = (width: number, height: number) => `chromium({ executablePath: ${JSON.stringify(browserPath())}, baseUrl: ${JSON.stringify(pages.url)}, viewport: { width: ${width}, height: ${height} } })`
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { narrow: ${target(390, 844)}, wide: ${target(1280, 800)} } }`),
    'tests/layout.retest.ts': tests,
  })
  const run = await runProject(t, root, { timeouts: budgets({ assertion: 600 }) })
  assert.equal(run.exit.code, 1, run.stderr)

  assert.equal(testNamed(run, 'the narrow page shows each layout problem').status, 'passed', JSON.stringify(testNamed(run, 'the narrow page shows each layout problem').failure))
  assert.equal(testNamed(run, 'the wide page shows none of the problems the width causes').status, 'passed', JSON.stringify(testNamed(run, 'the wide page shows none of the problems the width causes').failure))

  const passed = eventsOf(run.events, 'assertion.passed')
  const measured = (matcher: string, testName: string) => passed.find((event) => event.matcher === matcher && event.testId.endsWith(testName))?.layout
  const narrow = 'the narrow page shows each layout problem'
  const wide = 'the wide page shows none of the problems the width causes'
  assert.deepEqual(measured('toOverlap', narrow), { viewport: { width: 390, height: 844 }, edge: 390, shared: { across: 32, down: 32 } })
  assert.deepEqual(measured('toOverflowViewport', narrow), { viewport: { width: 390, height: 844 }, edge: 390, pastEdge: 14 })
  assert.deepEqual(measured('toScrollHorizontally', narrow), { viewport: { width: 390, height: 844 }, edge: 390, documentWidth: 404 })
  assert.deepEqual(measured('not.toOverlap', wide)?.viewport, { width: 1280, height: 800 })
  assert.deepEqual(measured('not.toScrollHorizontally', wide), { viewport: { width: 1280, height: 800 }, edge: 1280, documentWidth: 1280 })
  const clipped = passed.filter((event) => event.matcher === 'toHaveClippedText').map((event) => event.layout?.cut)
  assert.deepEqual(clipped, [14, 14, 14], 'the title, its card, and the title again at 1280')
  assert.equal(passed.find((event) => event.matcher === 'not.toHaveClippedText')?.layout?.cut, 0, 'the ellipsis note is cut short on purpose, not cut off')

  const absent = testNamed(run, 'their absence fails at the narrow width, naming each measurement')
  assert.equal(absent.status, 'failed')
  const failed = eventsOf(run.events, 'assertion.failed').filter((event) => event.testId === absent.testId)
  assert.deepEqual(
    failed.map((event) => [event.matcher, event.failure.class, event.failure.message.replace(/ Looked \d+ times? in \d+ ms\.$/, ''), event.actual?.text]),
    [
      ['not.toOverlap', 'check_failed', "getByTestId('save') and getByTestId('help') overlap: they share 32 by 32 pixels at 390 pixels wide.", 'share 32 by 32 pixels at 390 pixels wide'],
      ['not.toOverflowViewport', 'check_failed', "getByTestId('price') ends 14 pixels past the right edge at 390 pixels wide.", 'ends 14 pixels past the right edge at 390 pixels wide'],
      ['not.toHaveClippedText', 'check_failed', "A container cuts off 14 pixels of the words in getByTestId('clipped-title') at 390 pixels wide.", 'cut 14 pixels at 390 pixels wide'],
      ['not.toScrollHorizontally', 'check_failed', 'The page is 404 pixels wide and scrolls 14 pixels sideways at 390 pixels wide.', 'document 404 pixels wide at 390 pixels wide'],
    ],
  )
  assert.deepEqual(failed.map((event) => event.soft), [true, true, true, true])
  assert.ok(failed.every((event) => event.layout?.viewport.width === 390 && /^o\d+$/.test(event.observationId ?? '')), 'each failure records the look it rested on and what it measured')

  const unmeasured = testNamed(run, 'a measurement that cannot be taken passes neither way')
  const refused = eventsOf(run.events, 'assertion.failed').filter((event) => event.testId === unmeasured.testId)
  assert.deepEqual(
    refused.map((event) => [event.failure.class, event.failure.message.replace(/ Looked \d+ times? in \d+ ms\.$/, '')]),
    [
      ['not_found', "getByTestId('missing') matched no element."],
      ['check_failed', "getByTestId('card') holds getByTestId('clipped-title'), so they cannot overlap. Compare two separate elements."],
      ['check_failed', "getByTestId('search') shows no words, so Retest cannot tell whether a container cuts them off."],
    ],
  )
})
