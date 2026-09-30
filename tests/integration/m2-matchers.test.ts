import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openApp } from './browser-harness.ts'
import { budgets, configSource, eventsOf, resultOf, runProject, testNamed, writeProject } from './cli-harness.ts'

// Acceptance check 10: every new matcher passes and fails as it should, expect.poll reads again without repeating
// an action, and expect.soft lets the test go on and fails it at the end with each failure kept.

function matcherTests(baseUrl: string): string {
  return `import { expect, test } from '@rehearsal-labs/retest'

async function submissions(): Promise<number> {
  const response = await fetch(${JSON.stringify(`${baseUrl}/api/submissions`)})
  const body: unknown = await response.json()
  return typeof body === 'object' && body !== null && 'count' in body && typeof body.count === 'number' ? body.count : -1
}

test('locator matchers pass', async ({ page }) => {
  await page.goto('/locators')
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page.getByText('Hidden note')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(1)
  await expect(page.getByRole('listitem')).toHaveCount(120)
  await expect(page.getByRole('button', { name: 'tree', exact: false })).toHaveText(['one', 'three'])
  await expect(page.getByLabel('Email')).toHaveValue('email by label for')
})

test('value matchers pass', async () => {
  const task = { title: 'Release checklist', due: new Date('2026-10-01T09:00:00Z'), tags: new Set(['smoke']), notes: new Map([['owner', ['alice']]]) }
  expect(task).toEqual({ title: 'Release checklist', due: new Date('2026-10-01T09:00:00Z'), tags: new Set(['smoke']), notes: new Map([['owner', ['alice']]]) })
  expect(['smoke', 'slow']).toContain('slow')
  expect('Release checklist').toContain('check')
  expect('Release checklist').toMatch(/^release/i)
})

test('toBeHidden fails on a visible element', async ({ page }) => {
  await page.goto('/locators')
  await expect(page.getByRole('heading', { name: 'Locators' })).toBeHidden()
})

test('toHaveCount fails on another count', async ({ page }) => {
  await page.goto('/locators')
  await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(2)
})

test('toHaveText with a list fails on another order', async ({ page }) => {
  await page.goto('/locators')
  await expect(page.getByRole('button', { name: 'tree', exact: false })).toHaveText(['three', 'one'])
})

test('toHaveValue fails on another value', async ({ page }) => {
  await page.goto('/locators')
  await expect(page.getByLabel('Email')).toHaveValue('email in lower case')
})

test('toEqual fails on a nested difference', async () => {
  expect({ title: 'Release checklist', tags: ['smoke', 'slow'] }).toEqual({ title: 'Release checklist', tags: ['slow', 'smoke'] })
})

test('toContain fails on a missing item', async () => {
  expect(['smoke']).toContain('slow')
})

test('toMatch fails on text the pattern does not match', async () => {
  expect('Release checklist').toMatch(/^Groceries/)
})

test('expect.poll reads again until the value matches, and never repeats the action before it', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Title').fill('Release checklist')
  await page.getByRole('button', { name: 'Save' }).click()
  let reads = 0
  await expect.poll(async () => {
    reads += 1
    return reads < 3 ? -1 : await submissions()
  }, { intervals: [20] }).toBe(1)
  expect(reads).toBe(3)
})

test('expect.poll that never matches fails when its time runs out, and saves nothing again', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Title').fill('Groceries')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect.poll(submissions, { timeout: 600, intervals: [50] }).toBe(3)
})

test('an action inside expect.poll fails the test, and is never sent', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Title').fill('Clicked from a poll')
  await expect.poll(async () => {
    await page.getByRole('button', { name: 'Save' }).click()
    return submissions()
  }).toBe(1)
})

test('expect.soft goes on after each failure and fails the test at the end', async ({ page }) => {
  await page.goto('/')
  await expect.soft(page.getByTestId('saved-task')).toHaveText('a soft failure')
  expect.soft(1 + 1).toBe(3)
  await page.getByLabel('Title').fill('after the soft failures')
  await expect(page.getByLabel('Title')).toHaveValue('after the soft failures')
})
`
}

// Recorded values are formatted for reading, so spacing is not compared.
function squeezed(text: string | undefined): string {
  return (text ?? '').replaceAll(/\s/g, '')
}

test('each matcher passes and fails correctly, poll never repeats an action, and soft fails the test at the end', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) } }`),
    'tests/matchers.retest.ts': matcherTests(app.url),
  })
  const run = await runProject(t, root, { timeouts: budgets({ assertion: 500 }) })

  assert.equal(run.exit.code, 1, run.stderr)
  const outcome = (name: string) => {
    const found = testNamed(run, name)
    return [found.status, found.failure?.class ?? null]
  }
  for (const name of ['locator matchers pass', 'value matchers pass', 'expect.poll reads again until the value matches, and never repeats the action before it']) {
    assert.deepEqual(outcome(name), ['passed', null], name)
  }
  const failures: [string, string, string, string][] = [
    ['toBeHidden fails on a visible element', 'toBeHidden', 'hidden', ''],
    ['toHaveCount fails on another count', 'toHaveCount', '2', '1'],
    ['toHaveText with a list fails on another order', 'toHaveText', '["three","one"]', '["one","three"]'],
    ['toHaveValue fails on another value', 'toHaveValue', 'email in lower case', 'email by label for'],
    ['toEqual fails on a nested difference', 'toEqual', 'slow', 'smoke'],
    ['toContain fails on a missing item', 'toContain', 'slow', 'smoke'],
    ['toMatch fails on text the pattern does not match', 'toMatch', '/^Groceries/', 'Release checklist'],
    ['expect.poll that never matches fails when its time runs out, and saves nothing again', 'toBe', '3', '2'],
  ]
  for (const [name, matcher, expected, actual] of failures) {
    assert.deepEqual(outcome(name), ['failed', 'check_failed'], name)
    const failed = eventsOf(run.events, 'assertion.failed').filter((event) => event.testId === testNamed(run, name).testId)
    assert.equal(failed.length, 1, name)
    const [event] = failed
    assert.equal(event?.matcher, matcher, name)
    assert.ok(squeezed(event?.expected?.text).includes(squeezed(expected)), `${name}: expected ${JSON.stringify(event?.expected?.text)}`)
    assert.ok(squeezed(event?.actual?.text).includes(squeezed(actual)), `${name}: actual ${JSON.stringify(event?.actual?.text)}`)
  }

  // Two saves in the run, one for each poll test, however often each poll read the count, and none from inside a poll.
  assert.equal(app.submissions(), 2)
  const inside = testNamed(run, 'an action inside expect.poll fails the test, and is never sent')
  assert.deepEqual([inside.status, inside.failure?.class], ['failed', 'usage'])
  assert.match(inside.failure?.message ?? '', /^expect\.poll\(\) calls its function again on every look, so the function may only read\. getByRole\('button', \{ name: 'Save' \}\)\.click\(\) on line \d+ would run again each time\.$/)
  assert.equal(eventsOf(run.events, 'action.completed').filter((event) => event.testId === inside.testId && event.command === 'click').length, 0)
  const polled = testNamed(run, 'expect.poll reads again until the value matches, and never repeats the action before it')
  const pollPassed = eventsOf(run.events, 'assertion.passed').filter((event) => event.testId === polled.testId && event.matcher === 'toBe')
  assert.deepEqual(pollPassed.map((event) => event.attempts), [3, 1])
  const expired = testNamed(run, 'expect.poll that never matches fails when its time runs out, and saves nothing again')
  const expiredCheck = eventsOf(run.events, 'assertion.failed').find((event) => event.testId === expired.testId)
  assert.ok((expiredCheck?.attempts ?? 0) > 2, `the poll looked ${expiredCheck?.attempts} times`)
  for (const test of [polled, expired]) {
    const clicks = eventsOf(run.events, 'action.completed').filter((event) => event.testId === test.testId && event.command === 'click')
    assert.equal(clicks.length, 1, 'one click in each poll test')
  }

  const soft = testNamed(run, 'expect.soft goes on after each failure and fails the test at the end')
  assert.deepEqual([soft.status, soft.failure?.class], ['failed', 'check_failed'])
  assert.match(soft.failure?.message ?? '', /a soft failure/)
  assert.match(String(soft.failure?.details?.['also']), /check_failed: .*3/s)
  const softFailures = eventsOf(run.events, 'assertion.failed').filter((event) => event.testId === soft.testId)
  assert.deepEqual(softFailures.map((event) => [event.matcher, event.soft]), [
    ['toHaveText', true],
    ['toBe', true],
  ])
  const after = eventsOf(run.events, 'action.completed').filter((event) => event.testId === soft.testId && event.command === 'fill')
  assert.equal(after.length, 1, 'the test went on after its soft failures')
  assert.equal(soft.assertionCount, 3)
  assert.equal(resultOf(run).counts.failed, 10)
})
