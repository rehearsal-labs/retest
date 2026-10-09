import type { FinishedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openApp } from './browser-harness.ts'
import { budgets, configSource, eventsOf, runProject, testNamed, writeProject } from './cli-harness.ts'
import { failedAtIn, lineOf } from './workflow-harness.ts'

// Release 1 workflow family 7, select options, checkboxes and radios, against real Chrome and the task app's
// preferences form, which shows every control's state as text and saves on the server. The cases are F7.1 to F7.4
// in docs/compatibility/workflow-cases.md.

const file = 'tests/selection.retest.ts'
const assertFailedAt = failedAtIn(file)

const tests = `import { expect, test } from '@rehearsal-labs/retest'

test('chooses a plan, ticks a box and picks a theme, and the saved choices come back after a reload', async ({ page }) => {
  await page.goto('/workflow/preferences')
  await expect(page.getByTestId('current')).toHaveText('plan=free seats=none updates=on summary=off alerts=on theme=light')
  await page.getByLabel('Plan').select('Team')
  await expect(page.getByTestId('price')).toHaveText('$12 a month')
  await page.getByLabel('Weekly summary').check()
  await page.getByLabel('Dark').check()
  await expect(page.getByLabel('Weekly summary')).toBeChecked()
  await expect(page.getByLabel('Dark')).toBeChecked()
  await expect(page.getByTestId('current')).toHaveText('plan=team seats=none updates=on summary=on alerts=on theme=dark')
  await page.getByRole('button', { name: 'Save preferences' }).click()
  await expect(page.getByRole('status')).toHaveText('Saved plan=team seats=none updates=on summary=on alerts=on theme=dark')
  await page.reload()
  await expect(page.getByLabel('Plan')).toHaveValue('team')
  await expect(page.getByLabel('Weekly summary')).toBeChecked()
  await expect(page.getByLabel('Dark')).toBeChecked()
  await expect(page.getByTestId('current')).toHaveText('plan=team seats=none updates=on summary=on alerts=on theme=dark')
})

test('unticks a ticked box, chooses by value, and a second radio replaces the first', async ({ page }) => {
  await page.goto('/workflow/preferences')
  await page.getByLabel('Product updates').uncheck()
  await page.getByLabel('Plan').select({ value: 'team' })
  await page.getByLabel('Dark').check()
  await page.getByLabel('System').check()
  await expect(page.getByLabel('Product updates')).not.toBeChecked()
  await expect(page.getByLabel('System')).toBeChecked()
  await expect(page.getByLabel('Dark')).not.toBeChecked()
  await expect(page.getByTestId('current')).toHaveText('plan=team seats=none updates=off summary=off alerts=on theme=system')
})

test('the Business plan shows a seats choice that the other plans hide', async ({ page }) => {
  await page.goto('/workflow/preferences')
  await expect(page.getByTestId('seats-field')).toBeHidden()
  await page.getByLabel('Plan').select('Business')
  await expect(page.getByLabel('Seats')).toBeVisible()
  await page.getByLabel('Seats').select('25 seats')
  await expect(page.getByTestId('current')).toHaveText('plan=business seats=25 updates=on summary=off alerts=on theme=light')
  await page.getByLabel('Plan').select('Free')
  await expect(page.getByTestId('seats-field')).toBeHidden()
  await expect(page.getByTestId('price')).toHaveText('$0 a month')
})

test('a save that ignores a checkbox fails at the saved summary', async ({ page }) => {
  await page.goto('/workflow/preferences?defect=ignores-checkbox')
  await page.getByLabel('Weekly summary').check()
  await page.getByRole('button', { name: 'Save preferences' }).click()
  await test.step('the saved preferences match the form', async () => {
    await expect(page.getByRole('status')).toHaveText('Saved plan=free seats=none updates=on summary=on alerts=on theme=light')
  })
})
`

const saves = 'chooses a plan, ticks a box and picks a theme, and the saved choices come back after a reload'
const switches = 'unticks a ticked box, chooses by value, and a second radio replaces the first'
const reveals = 'the Business plan shows a seats choice that the other plans hide'
const ignored = 'a save that ignores a checkbox fails at the saved summary'

// Each select, check and uncheck a test sent, with whether it changed anything and how its input reached the page.
function choices(run: FinishedRun, name: string): [string, boolean | undefined, string | undefined][] {
  const { testId } = testNamed(run, name)
  return eventsOf(run.events, 'action.completed')
    .filter((event) => event.testId === testId && ['select', 'check', 'uncheck'].includes(event.command))
    .map((event) => [event.command, event.changed, event.input])
}

test('workflow family 7: a select, checkboxes and radios change and save the preferences, a choice reveals another, and a save that drops a checkbox fails at its check', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) } }`),
    [file]: tests,
  })
  const run = await runProject(t, root, { timeouts: budgets({ assertion: 1500 }) })
  assert.equal(run.exit.code, 1, run.stderr)

  // F7.1: each choice changed the form once, the server saved all of them, and the reloaded page is drawn from them.
  // Every choice, the select's included, reached the page as real input, so no event marks one as made by script.
  assert.equal(testNamed(run, saves).status, 'passed')
  assert.deepEqual(choices(run, saves), [
    ['select', true, undefined],
    ['check', true, undefined],
    ['check', true, undefined],
  ])

  // F7.2: a box ticked from the start is unticked, and the second radio of the group leaves the first unchosen.
  assert.equal(testNamed(run, switches).status, 'passed')
  assert.deepEqual(choices(run, switches), [
    ['uncheck', true, undefined],
    ['select', true, undefined],
    ['check', true, undefined],
    ['check', true, undefined],
  ])

  // F7.3: the seats select exists only while Business is chosen, and is chosen from once it shows.
  assert.equal(testNamed(run, reveals).status, 'passed')

  // F7.4: the box was ticked and sent, but the server saved the weekly summary as off.
  assertFailedAt(run, ignored, {
    step: 'the saved preferences match the form',
    failureClass: 'check_failed',
    line: lineOf(tests, "getByRole('status')", 'the saved preferences match the form'),
    message: /^getByRole\('status'\) has text "Saved plan=free seats=none updates=on summary=off alerts=on theme=light", expected "Saved plan=free seats=none updates=on summary=on alerts=on theme=light"\./,
  })
})
