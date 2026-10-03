import type { FinishedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EXPORT_RELEASE_PATH, REPORTS } from '../../fixtures/task-app/workflow-async-page.ts'
import { openApp } from './browser-harness.ts'
import { budgets, configSource, eventsOf, runProject, testNamed, writeProject } from './cli-harness.ts'
import { failedAtIn, lineOf } from './workflow-harness.ts'

// Release 1 workflow family 10, wait for loading and asynchronous UI state, against real Chrome and the task app's
// reports page, which asks for its reports after a timer, gets them from a slow server and enables Export only once
// they are in. The cases are F10.1 to F10.5 in docs/plans/public-beta/workflow-cases.md.

const file = 'tests/async.retest.ts'
const assertFailedAt = failedAtIn(file)
const assertionMs = 1500

const tests = `import { expect, test } from '@rehearsal-labs/retest'

test('shows a loading line, then the reports that arrive late, and hides the line', async ({ page }) => {
  await page.goto('/workflow/reports')
  await expect(page.getByTestId('loading')).toBeVisible()
  await expect(page.getByTestId('report-row')).toHaveText(${JSON.stringify(REPORTS)})
  await expect(page.getByTestId('loading')).toBeHidden()
})

test('waits for Export to be enabled, then for the export to finish', async ({ page }) => {
  await page.goto('/workflow/reports')
  await expect(page.getByRole('button', { name: 'Export' })).toBeEnabled()
  await page.getByRole('button', { name: 'Export' }).click()
  await expect(page.getByTestId('export-status')).toHaveText('Preparing export…')
  // The server holds the export until this asks it to finish, so the state above stays until it has been checked.
  const released = await fetch(new URL(${JSON.stringify(EXPORT_RELEASE_PATH)}, process.env['WORKFLOW_APP_URL']), { method: 'POST' })
  expect(released.ok).toBe(true)
  await expect(page.getByTestId('export-status')).toHaveText('Export ready: ${REPORTS.length} reports')
})

test('offers to try again after a failed load, and loads on the second try', async ({ page }) => {
  await page.goto('/workflow/reports?first-load=fails')
  await expect(page.getByRole('alert')).toHaveText('Could not load reports. Try again')
  await expect(page.getByTestId('loading')).toBeHidden()
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByTestId('report-row')).toHaveCount(${REPORTS.length})
  await expect(page.getByRole('alert')).toBeHidden()
})

test('a loading line that never goes away fails at the hidden check', async ({ page }) => {
  await page.goto('/workflow/reports?defect=spinner-stays')
  await expect(page.getByTestId('report-row')).toHaveCount(${REPORTS.length})
  await test.step('the loading line goes once the reports are in', async () => {
    await expect(page.getByTestId('loading')).toBeHidden()
  })
})

test('reports that never arrive fail at the list check', async ({ page }) => {
  await page.goto('/workflow/reports?defect=never-answers')
  await test.step('the reports arrive', async () => {
    await expect(page.getByTestId('report-row')).toHaveCount(${REPORTS.length})
  })
})
`

const loads = 'shows a loading line, then the reports that arrive late, and hides the line'
const exports = 'waits for Export to be enabled, then for the export to finish'
const retries = 'offers to try again after a failed load, and loads on the second try'
const spinnerStays = 'a loading line that never goes away fails at the hidden check'
const neverArrives = 'reports that never arrive fail at the list check'

// The failed assertion of a test looked again for its whole budget before it gave up.
function assertLookedForItsBudget(run: FinishedRun, name: string): void {
  const { testId } = testNamed(run, name)
  const failed = eventsOf(run.events, 'assertion.failed').filter((event) => event.testId === testId)
  assert.equal(failed.length, 1, `${name} failed one assertion`)
  const [event] = failed
  assert.equal(event?.timeoutMs, assertionMs, `${name} had the assertion budget`)
  assert.ok((event?.durationMs ?? 0) >= assertionMs, `${name} looked for ${event?.durationMs} ms`)
  assert.ok((event?.attempts ?? 0) > 2, `${name} looked ${event?.attempts} times`)
}

test('workflow family 10: checks wait for late data, a click waits for its button, a failed load recovers, and a spinner that stays or data that never comes fails after its budget', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) } }`),
    [file]: tests,
  })
  const run = await runProject(t, root, { timeouts: budgets({ assertion: assertionMs }), env: { WORKFLOW_APP_URL: app.url } })
  assert.equal(run.exit.code, 1, run.stderr)

  // F10.1: the list check passed only after looking again while the reports were on their way.
  assert.equal(testNamed(run, loads).status, 'passed')
  const listed = eventsOf(run.events, 'assertion.passed').find((event) => event.testId === testNamed(run, loads).testId && event.matcher === 'toHaveText')
  assert.ok((listed?.attempts ?? 0) > 1, `the list check looked ${listed?.attempts} times`)

  // F10.2: Export was checked enabled once the reports were in, clicked once, and its two states each checked.
  assert.equal(testNamed(run, exports).status, 'passed')
  const exportId = testNamed(run, exports).testId
  const clicks = eventsOf(run.events, 'action.completed').filter((event) => event.testId === exportId && event.command === 'click')
  assert.equal(clicks.length, 1)
  const enabled = eventsOf(run.events, 'assertion.passed').find((event) => event.testId === exportId && event.matcher === 'toBeEnabled')
  assert.equal(enabled?.judgedBy, 'parent', 'the parent judged the enabled check on its own look')

  // F10.3: the first answer was an error the page showed, and the second try loaded.
  assert.equal(testNamed(run, retries).status, 'passed')

  // F10.4: the reports arrived, but the loading line stayed for the whole budget.
  assertFailedAt(run, spinnerStays, {
    step: 'the loading line goes once the reports are in',
    failureClass: 'check_failed',
    line: lineOf(tests, "toBeHidden()", 'the loading line goes once the reports are in'),
    message: /^getByTestId\('loading'\) is visible\. Looked \d+ times in 1500 ms\.$/,
  })
  assertLookedForItsBudget(run, spinnerStays)

  // F10.5: the server never answered, so no report ever showed.
  assertFailedAt(run, neverArrives, {
    step: 'the reports arrive',
    failureClass: 'check_failed',
    line: lineOf(tests, 'toHaveCount', 'the reports arrive'),
    message: new RegExp(`^getByTestId\\('report-row'\\) matched no element, expected ${REPORTS.length}\\. Looked \\d+ times in 1500 ms\\.$`),
  })
  assertLookedForItsBudget(run, neverArrives)
})
