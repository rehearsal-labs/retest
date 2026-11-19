import type { FinishedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HELD_PATH, TELL_PATH } from '../../fixtures/task-app/leaving-page.ts'
import { openApp } from './browser-harness.ts'
import { budgets, configSource, runProject, testNamed, writeProject } from './cli-harness.ts'

// A check on the line after a click that posts a form must judge the page the server answers with, here a server error
// page, not the form the click left: each case below passes on the form and fails on the error page. The save answers
// after 600 ms. In the last case the server holds it until the test lets go, which it never does, so a check of 1000 ms
// runs out while the page is still opening it.

const file = 'tests/leaving.retest.ts'

// The last case sets the page off for the save only once its click has answered: Chrome holds a call into a document
// that has set off for another until that one arrives, so a click that set the page off itself could end only once the
// save answered. The browser tells Retest the page asked for the save before it sends the request, so once the server
// holds the save, the check that follows reads a page Retest knows is opening it.
const sourceFor = (appUrl: string): string => `import { expect, test } from 'retest'

const appUrl = ${JSON.stringify(appUrl)}
const held = async () => ((await (await fetch(appUrl + '${HELD_PATH}')).json()) as { held: number }).held

test('the heading check', async ({ page }) => {
  await page.goto('/leaving/edit')
  await page.getByTestId('save').click()
  await expect(page.getByTestId('task-heading')).toBeVisible()
})

test('the error banner check', async ({ page }) => {
  await page.goto('/leaving/edit')
  await page.getByTestId('save').click()
  await expect(page.getByTestId('error-banner')).toBeHidden()
})

test('the address check', async ({ page }) => {
  await page.goto('/leaving/edit')
  await page.getByTestId('save').click()
  await expect(page).toHaveURL(/leaving\\/edit/)
})

test('the negated address check', async ({ page }) => {
  await page.goto('/leaving/edit')
  await page.getByTestId('save').click()
  await expect(page).not.toHaveURL(/leaving\\/save/)
})

test('the title check', async ({ page }) => {
  await page.goto('/leaving/edit')
  await page.getByTestId('save').click()
  await expect(page).toHaveTitle('Edit task')
})

test('the layout check', async ({ page }) => {
  await page.goto('/leaving/edit')
  await page.getByTestId('save').click()
  await expect(page.getByTestId('task-heading')).not.toOverflowViewport()
})

test('the address read', async ({ page }) => {
  await page.goto('/leaving/edit')
  await page.getByTestId('save').click()
  expect(await page.url()).toMatch(/leaving\\/save$/)
})

test('the check while the save is still on its way', async ({ page }) => {
  await page.goto('/leaving/edit?held=1')
  await page.getByTestId('save-when-told').click()
  await fetch(appUrl + '${TELL_PATH}', { method: 'POST' })
  await expect.poll(held).toBe(1)
  await expect(page.getByTestId('task-heading')).toBeVisible({ timeout: 1000 })
})
`

// The line of the first check of the page after `name`'s opening line: the line each case fails at.
function checkLine(name: string): number {
  const lines = sourceFor('').split('\n')
  const start = lines.findIndex((line) => line.includes(`test('${name}'`))
  return start + 1 + lines.slice(start).findIndex((line) => line.includes('expect(page'))
}

function outcome(run: FinishedRun, name: string): [string, string | undefined, number | undefined] {
  const result = testNamed(run, name)
  return [result.status, result.failure?.class, result.failure?.location?.line]
}

test('a check on the line after a click that posts a form reads the page the server answers, and one still waiting for it fails naming it', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) } }`),
    [file]: sourceFor(app.url),
  })
  const run = await runProject(t, root, { timeouts: budgets() })
  assert.equal(run.exit.code, 1, run.stderr)
  const save = `${app.url}/leaving/save`

  assert.deepEqual(outcome(run, 'the heading check'), ['failed', 'not_found', checkLine('the heading check')])
  assert.match(testNamed(run, 'the heading check').failure?.message ?? '', /^getByTestId\('task-heading'\) matched no element\./)
  assert.deepEqual(outcome(run, 'the error banner check'), ['failed', 'check_failed', checkLine('the error banner check')])
  assert.deepEqual(outcome(run, 'the address check'), ['failed', 'check_failed', checkLine('the address check')])
  assert.match(testNamed(run, 'the address check').failure?.message ?? '', new RegExp(`^The page is at "${save}\\?wait=600"`))
  assert.deepEqual(outcome(run, 'the negated address check'), ['failed', 'check_failed', checkLine('the negated address check')])
  assert.deepEqual(outcome(run, 'the title check'), ['failed', 'check_failed', checkLine('the title check')])
  assert.match(testNamed(run, 'the title check').failure?.message ?? '', /"Server error"/)
  assert.deepEqual(outcome(run, 'the layout check'), ['failed', 'not_found', checkLine('the layout check')])
  assert.equal(testNamed(run, 'the address read').status, 'passed')

  const waiting = testNamed(run, 'the check while the save is still on its way')
  assert.deepEqual(outcome(run, 'the check while the save is still on its way'), ['failed', 'timeout', checkLine('the check while the save is still on its way')])
  assert.equal(waiting.failure?.message, `The page was still opening ${save} when the check's 1000 ms ran out, so the check read nothing.`)
})
