import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openApp } from './browser-harness.ts'
import { budgets, configSource, eventsOf, resultOf, runProject, testNamed, writeProject } from './cli-harness.ts'

// Acceptance check 3: role, label and text locators, through test files run by the command line in real Chrome,
// against the conformance page `fixtures/task-app/locators-page.ts`.

const locatorTests = `import { expect, test } from '@rehearsal-labs/retest'

test.beforeEach(async ({ page }) => {
  await page.goto('/locators')
})

test('role matches the whole name Chrome computes, case and all, and any part with exact: false', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Save' })).toHaveText('Save')
  await expect(page.getByRole('button', { name: 'save' })).toHaveText('save')
  await expect(page.getByRole('button', { name: 'SAVE' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Save dra' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '  Save \\n draft ' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'SAVE', exact: false })).toHaveText(['Save', 'save', 'Save draft'])
  await expect(page.getByRole('button', { name: 'Close dialog' })).toHaveText('×')
  await expect(page.getByRole('button', { name: 'Archive task' })).toHaveText('archive')
  await expect(page.getByRole('button', { name: 'Print page' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Locators' })).toBeVisible()
})

test('role leaves out aria-hidden, undisplayed, hidden, invisible and inert elements', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Delete' })).toHaveText('shown')
  await page.getByRole('button', { name: 'Delete' }).click()
})

test('a locator is found again for each command, so a renamed button is found by its new name', async ({ page }) => {
  await page.getByRole('button', { name: 'Start' }).click()
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveText('toggle')
  await expect(page.getByRole('button', { name: 'Start' })).toHaveCount(0)
})

test('label finds a form control by label for, a wrapping label, aria-labelledby, aria-label, title and placeholder', async ({ page }) => {
  await expect(page.getByLabel('Email')).toHaveValue('email by label for')
  await expect(page.getByLabel('email')).toHaveValue('email in lower case')
  await expect(page.getByLabel('Full name')).toHaveValue('name by wrapping label')
  await expect(page.getByLabel('Notes')).toHaveValue('notes by aria-labelledby')
  await expect(page.getByLabel('Phone')).toHaveValue('phone by aria-label')
  await expect(page.getByLabel('Search tasks')).toHaveValue('search by title')
  await expect(page.getByLabel('City')).toHaveValue('city by placeholder')
  await expect(page.getByLabel('Size')).toHaveValue('Large')
  await expect(page.getByLabel('EMAIL', { exact: false })).toHaveCount(2)
  await expect(page.getByLabel('Hidden field')).toHaveCount(0)
  await page.getByLabel('Phone').fill('555 0100')
  await expect(page.getByLabel('Phone')).toHaveValue('555 0100')
})

test('text finds the innermost element whose whole text matches, skipping script, style, template and noscript', async ({ page }) => {
  await expect(page.getByText('Welcome back')).toHaveCount(1)
  await expect(page.getByText('Plan pro')).toBeVisible()
  await expect(page.getByText('notes')).toHaveText('notes')
  await expect(page.getByText('Ship it')).toBeVisible()
  await expect(page.getByText('PLAN', { exact: false })).toHaveText('Plan')
  await expect(page.getByText('/* Welcome back */')).toHaveCount(0)
  await expect(page.getByText('Hidden note')).toHaveCount(1)
  await expect(page.getByText('Hidden note')).toBeHidden()
})

test('locators stay in the top-level document, out of shadow roots and frames', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'tree', exact: false })).toHaveText(['one', 'three'])
  await expect(page.getByText('Framed text')).toHaveCount(0)
  await expect(page.getByText('two')).toHaveCount(0)
})

test('an action on a role that matches three buttons fails at once', async ({ page }) => {
  await page.getByRole('button', { name: 'save', exact: false }).click()
})

test('an action on a label that matches two fields fails at once', async ({ page }) => {
  await page.getByLabel('EMAIL', { exact: false }).fill('new@example.test')
})

test('an action on text that matches nothing fails when the action budget runs out', async ({ page }) => {
  await page.getByText('Welcome').click()
})
`

test('role, label and text locators follow their rules in real Chrome, and ambiguity or absence fails an action', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) } }`),
    'tests/locators.retest.ts': locatorTests,
  })
  const run = await runProject(t, root, { timeouts: budgets({ action: 1500 }) })

  assert.equal(run.exit.code, 1, run.stderr)
  const statuses = resultOf(run).files.flatMap((file) => file.tests.map((each) => [each.name, each.status, each.failure?.class]))
  assert.deepEqual(statuses, [
    ['role matches the whole name Chrome computes, case and all, and any part with exact: false', 'passed', undefined],
    ['role leaves out aria-hidden, undisplayed, hidden, invisible and inert elements', 'passed', undefined],
    ['a locator is found again for each command, so a renamed button is found by its new name', 'passed', undefined],
    ['label finds a form control by label for, a wrapping label, aria-labelledby, aria-label, title and placeholder', 'passed', undefined],
    ['text finds the innermost element whose whole text matches, skipping script, style, template and noscript', 'passed', undefined],
    ['locators stay in the top-level document, out of shadow roots and frames', 'passed', undefined],
    ['an action on a role that matches three buttons fails at once', 'failed', 'ambiguous'],
    ['an action on a label that matches two fields fails at once', 'failed', 'ambiguous'],
    ['an action on text that matches nothing fails when the action budget runs out', 'failed', 'not_found'],
  ])

  const failed = eventsOf(run.events, 'action.failed')
  const role = failed.find((event) => event.locator?.by === 'role')
  assert.deepEqual(role?.locator, { by: 'role', role: 'button', name: 'save', exact: false })
  assert.deepEqual(role?.failure.details, { count: 3 })
  assert.match(role?.failure.message ?? '', /^Could not click getByRole\('button', \{ name: 'save', exact: false \}\): it matches 3 elements/)
  assert.ok((role?.durationMs ?? Infinity) < 1000, `an ambiguous role took ${role?.durationMs} ms`)
  const label = failed.find((event) => event.locator?.by === 'label')
  assert.equal(label?.failure.message, "Could not fill getByLabel('EMAIL', { exact: false }): it matches 2 elements, and a locator must match exactly one. Retest did not fill any of them.")
  assert.ok((label?.durationMs ?? Infinity) < 1000, `an ambiguous label took ${label?.durationMs} ms`)
  const text = testNamed(run, 'an action on text that matches nothing fails when the action budget runs out')
  assert.match(text.failure?.message ?? '', /getByText\('Welcome'\).*no element matched within 1500 ms/s)

  const completed = eventsOf(run.events, 'action.completed').filter((event) => event.command !== 'goto')
  assert.deepEqual(
    completed.map((event) => [event.command, event.locator]),
    [
      ['click', { by: 'role', role: 'button', name: 'Delete' }],
      ['click', { by: 'role', role: 'button', name: 'Start' }],
      ['fill', { by: 'label', text: 'Phone' }],
    ],
  )
  const passedChecks = eventsOf(run.events, 'assertion.passed').filter((event) => event.locator?.by === 'text')
  assert.ok(passedChecks.some((event) => event.matcher === 'toBeHidden' && event.locator?.by === 'text' && event.locator.text === 'Hidden note'))
})
