import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openApp } from './browser-harness.ts'
import { budgets, configSource, eventsOf, runProject, testNamed, writeProject } from './cli-harness.ts'

// A check that something is gone passes on a locator that matches nothing, so a misspelt test id passes for ever. It
// still passes, and the record says so; a locator a look of the same test found first is not marked.

const file = 'tests/gone.retest.ts'

const source = `import { expect, test } from '@rehearsal-labs/retest'

test('a misspelt banner check', async ({ page }) => {
  await page.goto('/leaving/edit')
  await expect(page.getByTestId('eror-banner')).toBeHidden()
})

test('a heading seen, then gone', async ({ page }) => {
  await page.goto('/leaving/edit')
  await expect(page.getByTestId('task-heading')).toBeVisible()
  await page.getByTestId('save').click()
  await expect(page.getByTestId('task-heading')).toBeHidden()
})
`

test('a check that passed on a locator no look of its test found is marked in its event, counted in the result and named in the report', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) } }`),
    [file]: source,
  })
  const run = await runProject(t, root, { reporter: 'human', timeouts: budgets({ assertion: 3000 }) })
  assert.equal(run.exit.code, 0, run.stdout)
  const misspelt = testNamed(run, 'a misspelt banner check')
  const gone = testNamed(run, 'a heading seen, then gone')
  const passed = eventsOf(run.events, 'assertion.passed')
  assert.deepEqual(
    passed.map((event) => [event.testId === misspelt.testId ? 'misspelt' : event.testId === gone.testId ? 'gone' : 'other', event.matcher, event.neverMatched ?? false]),
    [
      ['misspelt', 'toBeHidden', true],
      ['gone', 'toBeVisible', false],
      ['gone', 'toBeHidden', false],
    ],
  )
  assert.equal(run.result?.neverMatchedChecks, 1)
  const lines = run.stdout.split('\n').filter((line) => line.includes('matched nothing'))
  assert.equal(lines.length, 1, run.stdout)
  assert.match(lines[0] ?? '', /^ {2}No match +1 check passed with a locator that matched nothing in its test$/)
})
