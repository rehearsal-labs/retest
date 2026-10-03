import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { resultFile, eventsFile } from '../../src/protocol/run-folder.ts'
import { browserPath, openApp } from './browser-harness.ts'
import { onlyEvent, readEvents, readResult, runCli, scratchFolder, writeFiles } from './cli-harness.ts'

const spec = `import { test, expect, type Page } from '@playwright/test'
import { title } from './helper'

async function save(page: Page, text: string): Promise<void> {
  await page.getByTestId('task-title').fill(text)
  await page.getByTestId('save-task').click()
}

test.describe('tasks', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('saves a task', async ({ page }) => {
    await save(page, title)
    await expect(page.getByTestId('saved-task')).toHaveText(title)
  })

  test('uses a member Retest does not have yet', async ({ page }) => {
    await page.getByAltText('Title').fill('x')
  })
})
`

// The folder holds no node_modules at all: neither Playwright nor Retest is installed there, and the file names
// Playwright alone.
test('a Playwright test file runs unchanged from a bare folder, and what Retest does not have yet fails by name', async (t) => {
  const app = await openApp(t)
  const root = await scratchFolder(t, 'retest-playwright-')
  await writeFiles(root, {
    'tests/tasks.spec.ts': spec,
    'tests/helper.ts': "export const title = 'Release checklist'\n",
    'tests/unit.test.ts': "throw new Error('a .test file is not taken unless it is named')\n",
  })
  const output = join(await scratchFolder(t), 'run')
  const run = await runCli(t, ['run', '--playwright', '--browser', browserPath(), '--base-url', app.url, '--no-agent', '--output', output], { cwd: root })
  assert.equal(run.exit.code, 2, `${run.stdout}\n${run.stderr}`)
  assert.match(run.stdout, /retest \S+, playwright compatibility/)

  const events = readEvents(readFileSync(join(output, eventsFile), 'utf8'))
  const started = onlyEvent(events, 'run.started')
  assert.equal(started.options.playwright, true)
  assert.deepEqual(started.files, ['tests/tasks.spec.ts'])

  const result = readResult(readFileSync(join(output, resultFile), 'utf8'))
  const tests = result.files.flatMap((file) => file.tests)
  assert.deepEqual(tests.map((each) => [each.name, each.status]), [
    ['saves a task', 'passed'],
    ['uses a member Retest does not have yet', 'error'],
  ])
  const [, unsupported] = tests
  assert.equal(unsupported?.failure?.class, 'unsupported')
  assert.equal(unsupported?.failure?.message, "page.getByAltText is not supported yet by Retest's Playwright compatibility.")
  const line = spec.split('\n').findIndex((text) => text.includes('getByAltText')) + 1
  assert.deepEqual([unsupported?.failure?.location?.file, unsupported?.failure?.location?.line], ['tests/tasks.spec.ts', line])
  assert.equal(app.submissions(), 1, 'the passing test saved once, and the refused one sent nothing')
})

const lookupSpec = `import { test, expect } from '@playwright/test'

test('finds inside a list, picks, hovers, moves through history and checks the page', async ({ page }) => {
  await page.goto('/lookup/find')
  await page.getByTestId('inbox').getByRole('listitem').nth(1).getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByTestId('last-deleted')).toHaveText('Walk the dog')
  await expect(page.locator('.task.done span')).toHaveText('Pay rent')
  await expect(page.getByPlaceholder('Search archive')).toHaveValue('archive search')
  await expect(page.getByRole('listitem').first()).toContainText('Buy milk')
  await expect(page.getByRole('listitem').last()).not.toHaveText('Buy milk')
  await expect(page.getByText(/^Saved \\d+ tasks$/, { exact: true })).toBeVisible()
  await page.goto('/lookup/states')
  await expect(page.getByTestId('agree')).toBeChecked()
  await expect(page.getByTestId('send')).toBeDisabled()
  await expect(page.getByTestId('save')).toBeEnabled({ timeout: 2000 })
  await page.goto('/lookup/hover')
  await page.getByTestId('share').hover()
  await expect(page.getByTestId('tip')).toBeVisible()
  await page.goto('/lookup/history/one')
  await expect(page).toHaveTitle('One')
  await page.getByRole('link', { name: 'Next' }).click()
  await expect(page).toHaveURL(/two$/)
  await page.goBack()
  await expect(page).toHaveURL(/one$/)
  await page.goForward()
  await page.reload()
  await expect(page).toHaveTitle(/^Two/)
  expect(await page.title()).toBe('Two')
})

test('a goto option Retest has no answer for fails by name', async ({ page }) => {
  await page.goto('/lookup/find', { waitUntil: 'networkidle' })
})

test('a click option Retest has no answer for fails by name', async ({ page }) => {
  await page.goto('/lookup/find')
  await page.getByTestId('archive').getByRole('button').click({ force: true })
})

test('the options of a step fail by name', async ({ page }) => {
  await test.step('opens', async () => {
    await page.goto('/lookup/find')
  }, { box: true })
})
`

// The members this release added, as an unchanged Playwright file writes them, run against the task app, and the
// options Retest has no answer for fail by name instead of being dropped.
test('a Playwright file using scoped lookups, picks, hover, history and the new matchers runs unchanged, and unknown options fail by name', async (t) => {
  const app = await openApp(t)
  const root = await scratchFolder(t, 'retest-playwright-')
  await writeFiles(root, { 'tests/lookup.spec.ts': lookupSpec })
  const output = join(await scratchFolder(t), 'run')
  const run = await runCli(t, ['run', '--playwright', '--browser', browserPath(), '--base-url', app.url, '--no-agent', '--output', output], { cwd: root })
  assert.equal(run.exit.code, 2, `${run.stdout}\n${run.stderr}`)
  const result = readResult(readFileSync(join(output, resultFile), 'utf8'))
  const tests = result.files.flatMap((file) => file.tests)
  assert.deepEqual(
    tests.map((each) => [each.name, each.status, each.failure?.message]),
    [
      ['finds inside a list, picks, hovers, moves through history and checks the page', 'passed', undefined],
      ['a goto option Retest has no answer for fails by name', 'error', "page.goto(url, { waitUntil }) is not supported yet by Retest's Playwright compatibility."],
      ['a click option Retest has no answer for fails by name', 'error', "locator.click({ force }) is not supported yet by Retest's Playwright compatibility."],
      ['the options of a step fail by name', 'error', "test.step(title, body, options) is not supported yet by Retest's Playwright compatibility."],
    ],
  )
  const events = readEvents(readFileSync(join(output, eventsFile), 'utf8'))
  const refused = events.filter((event) => event.type === 'action.completed' || event.type === 'action.failed').filter((event) => event.testId !== tests[0]?.testId)
  assert.deepEqual(refused.map((event) => event.command), ['goto'], 'only the goto before the refused click was sent; nothing refused reached the page')
})

const rulesSpec = `import { test, expect } from '@playwright/test'

test('finds as Playwright does: any part of a name or a text in any case, and a label on any element', async ({ page }) => {
  await page.goto('/lookup/playwright')
  await expect(page.getByRole('button', { name: 'delete' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Delete' })).not.toBeHidden()
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0)
  await expect(page.getByText('order SUMMARY')).toHaveCount(1)
  await expect(page.getByLabel('unread')).toHaveText('3')
  await expect(page.getByLabel('Order summary')).toContainText('2 tasks')
  await page.getByPlaceholder('SEARCH').fill('milk')
  await expect(page.getByTestId('search')).toHaveValue('milk')
})

test('a hidden check on a page with an open shadow root is refused, never passed on what it cannot see', async ({ page }) => {
  await page.goto('/lookup/shadow')
  await expect(page.getByText('Inside')).toBeHidden()
})

test('a click on a page with an open shadow root is refused by name', async ({ page }) => {
  await page.goto('/lookup/shadow')
  await page.getByRole('button', { name: 'Outside' }).click()
})
`

// Playwright's finders match any part of a text in any case, and find a label on any element; a page with an open
// shadow root, which Playwright looks inside, is refused rather than searched less.
test("a Playwright file finds by Playwright's rules, and a page with an open shadow root is refused rather than found empty", async (t) => {
  const app = await openApp(t)
  const root = await scratchFolder(t, 'retest-playwright-')
  await writeFiles(root, { 'tests/rules.spec.ts': rulesSpec })
  const output = join(await scratchFolder(t), 'run')
  const run = await runCli(t, ['run', '--playwright', '--browser', browserPath(), '--base-url', app.url, '--no-agent', '--output', output], { cwd: root })
  assert.equal(run.exit.code, 2, `${run.stdout}\n${run.stderr}`)
  const result = readResult(readFileSync(join(output, resultFile), 'utf8'))
  const tests = result.files.flatMap((file) => file.tests)
  const refused = (action: string) =>
    `Could not ${action}: the page holds an open shadow root, in <todo-widget>. Playwright looks inside shadow roots and Retest does not, so Retest refuses the lookup rather than find less than Playwright would.`
  assert.deepEqual(
    tests.map((each) => [each.name, each.status, each.failure?.class, each.failure?.message]),
    [
      ['finds as Playwright does: any part of a name or a text in any case, and a label on any element', 'passed', undefined, undefined],
      ['a hidden check on a page with an open shadow root is refused, never passed on what it cannot see', 'error', 'unsupported', refused("read getByText('Inside')")],
      ['a click on a page with an open shadow root is refused by name', 'error', 'unsupported', refused("click getByRole('button', { name: 'Outside' })")],
    ],
  )
  const events = readEvents(readFileSync(join(output, eventsFile), 'utf8'))
  const located = events.flatMap((event) => (event.type === 'observation' && event.locator !== undefined ? [event.locator] : []))
  assert.ok(located.length > 0 && located.every((locator) => locator.dialect === 'playwright'), 'every look records that it found by Playwright\'s rules')
})

test('without --playwright, a file that is not a Retest test file is refused before anything starts', async (t) => {
  const root = await scratchFolder(t, 'retest-playwright-')
  await writeFiles(root, { 'tests/tasks.spec.ts': spec })
  const run = await runCli(t, ['run', 'tests/tasks.spec.ts', '--browser', browserPath()], { cwd: root })
  assert.equal(run.exit.code, 2)
  assert.match(run.stderr, /tests\/tasks\.spec\.ts is not a test file\. Test files end in \.retest\.ts\./)
})
