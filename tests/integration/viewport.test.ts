import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openApp } from './browser-harness.ts'
import { configSource, eventsOf, resultOf, runProject, writeProject } from './cli-harness.ts'

// The standalone viewport key on real Chrome: it sizes the page as a custom emulation with no touch screen and a
// pixel ratio of 1 would, keeps the browser's own user agent, and is reported as emulated.

test('a target with a viewport opens its pages at that size, with no touch screen and a pixel ratio of 1', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{
  apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)}, viewport: { width: 1280, height: 720 } }) },
}`),
    'tests/viewport.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'

test('the page is 1280 by 720', async ({ page }) => {
  await page.goto('/device')
  await expect(page.getByTestId('width')).toHaveText('1280')
  await expect(page.getByTestId('height')).toHaveText('720')
  await expect(page.getByTestId('pixel-ratio')).toHaveText('1')
  await expect(page.getByTestId('touch')).toHaveText('false')
  await page.getByTestId('touch-target').click()
  await expect(page.getByTestId('touch-events')).toHaveText('click:mouse')
})

test('a wrong size fails at its check', async ({ page }) => {
  await page.goto('/device')
  await expect(page.getByTestId('width')).toHaveText('1920')
})
`,
  })
  const run = await runProject(t, root, { env: { CI: '' } })
  assert.equal(run.exit.code, 1, run.stderr)
  const [sized, wrong] = resultOf(run).files.flatMap((file) => file.tests)
  assert.deepEqual([sized?.name, sized?.status], ['the page is 1280 by 720', 'passed'])
  assert.deepEqual([wrong?.status, wrong?.failure?.class], ['failed', 'check_failed'])
  assert.match(wrong?.failure?.message ?? '', /"1280", expected "1920"/)
  const browser = eventsOf(run.events, 'browser.started')[0]
  assert.deepEqual(browser?.target?.emulation, { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, touch: false, isMobile: false })
  const commands = eventsOf(run.events, 'action.completed').filter((event) => event.testId === sized?.testId).map((event) => event.command)
  assert.deepEqual(commands, ['goto', 'click'], 'the click was sent as a mouse click, not a tap')
})
