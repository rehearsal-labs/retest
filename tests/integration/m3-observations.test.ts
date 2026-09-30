import type { EventOf, FinishedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TASK_APP_PASSWORD } from '../../fixtures/task-app/sign-in.ts'
import { normalizeText } from '../../src/protocol/text.ts'
import { openApp } from './browser-harness.ts'
import {
  assertStdoutIsEvents,
  budgets,
  childLog,
  configSource,
  eventsOf,
  filesHolding,
  isRunning,
  printedPids,
  runCli,
  runProject,
  runRetest,
  scenario,
  testNamed,
  textHolds,
  writeProject,
} from './cli-harness.ts'

// Acceptance check 3: the parent writes every look it serves as an `observation` event, each passed locator
// assertion names the look it rested on and is judged by the parent on it, and a test process that claims a pass
// the look does not support ends in an error with nothing passed written.

type Look = EventOf<'observation'>
type Passed = EventOf<'assertion.passed'>

// What the named look shows is what a person reading the event can judge the matcher by, without Retest's code.
function agrees(assertion: Passed, look: Look): boolean {
  const { observed } = look
  const expected = assertion.expected?.text ?? ''
  switch (assertion.matcher) {
    case 'toBeVisible':
      return observed.count === 1 && observed.visible === true
    case 'toBeHidden':
      return observed.count === 0 || observed.items.every((item) => !item.visible)
    case 'toHaveCount':
      return observed.count === Number(expected)
    case 'toHaveValue':
      return observed.value?.text === expected && assertion.actual?.text === expected
    case 'toHaveText':
      return expected.startsWith('[')
        ? JSON.stringify(observed.items.map((item) => item.text.text)) === expected
        : normalizeText(observed.text?.text ?? '') === normalizeText(expected) && assertion.actual?.text === observed.text?.text
    default:
      return false
  }
}

// Each passed locator assertion names a look the parent wrote earlier, and that look passes its matcher.
function lookOf(run: FinishedRun, assertion: Passed): Look {
  const look = eventsOf(run.events, 'observation').find((each) => each.attemptId === assertion.attemptId && each.observationId === assertion.observationId)
  assert.ok(look !== undefined && look.sequence < assertion.sequence, `${assertion.matcher} names a look written before it`)
  assert.ok(agrees(assertion, look), `${assertion.matcher} passes on ${look.observationId}: ${JSON.stringify(look.observed)}`)
  return look
}

test('every passed locator assertion names a look the parent wrote, judged on the text it compared; value passes are the test file’s', async (t) => {
  // The save answers after 1500 ms, so the check on the saved task looks several times before it passes.
  const app = await openApp(t, { mode: 'delayed' })
  const file = scenario('observations')
  const run = await runRetest(t, { files: [file], baseUrl: app.url, timeouts: budgets({ assertion: 4000 }) })
  assertStdoutIsEvents(run)
  assert.equal(run.exit.code, 0, run.stderr)

  const passed = eventsOf(run.events, 'assertion.passed')
  const byLocator = passed.filter((event) => event.locator !== undefined)
  // The last is an expect.soft check, which links like any other.
  assert.deepEqual(
    byLocator.map((event) => [event.matcher, event.judgedBy]),
    [
      ['toHaveValue', 'parent'],
      ['toHaveText', 'parent'],
      ['toHaveText', 'parent'],
      ['toBeVisible', 'parent'],
      ['toBeHidden', 'parent'],
      ['toHaveCount', 'parent'],
      ['toHaveText', 'parent'],
    ],
  )
  for (const assertion of byLocator) {
    const look = lookOf(run, assertion)
    assert.equal(assertion.pageUrl, look.pageUrl, 'the assertion carries the page address of its look')
  }
  const byValue = passed.filter((event) => event.locator === undefined)
  assert.deepEqual(byValue.map((event) => [event.matcher, event.judgedBy]), [['toMatch', 'child'], ['toBe', 'child']])

  // Every look is written, in order, and the check on the saved task rested on its last.
  const looks = eventsOf(run.events, 'observation')
  assert.deepEqual(looks.map((look) => look.observationId), looks.map((_look, index) => `o${index + 1}`))
  const saved = byLocator.find((event) => event.matcher === 'toHaveText' && event.locator?.by === 'testId' && event.locator.value === 'saved-task')
  assert.ok(saved !== undefined)
  const click = eventsOf(run.events, 'action.completed').find((event) => event.command === 'click')
  const savedLooks = looks.filter((look) => look.sequence > (click?.sequence ?? 0) && look.sequence < saved.sequence)
  assert.ok(savedLooks.length > 1, `the check looked ${savedLooks.length} times`)
  assert.equal(savedLooks.length, saved.attempts, 'one observation event for each look the assertion took')
  assert.equal(savedLooks.at(-1)?.observationId, saved.observationId, 'it rested on its last look')
  assert.equal(savedLooks[0]?.observed.text?.text, 'Saving…', 'the first look saw the page still saving')

  // inspect shows the looks under the assertion that rested on them, and marks the test file's own passes.
  const inspected = await runCli(t, ['inspect', run.output, '--test', `${file} > checks a saved task every way a locator can be checked`], {
    env: { NO_COLOR: '1' },
  })
  assert.equal(inspected.exit.code, 0, inspected.stderr)
  assert.match(inspected.stdout, new RegExp(`\\n +looked ${savedLooks.length} times, passed on ${saved.observationId}: 1 match, text "Release checklist"\\n`))
  assert.match(inspected.stdout, /✓ toMatch {2}[^\n]*reported by the test file\n/)
})

test('page text that holds a secret reads its name in the observation, as the test process received it', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) }, secrets: { password: env('RETEST_E2E_PASSWORD') } }`),
    'tests/account.retest.ts': `import { expect, secret, test } from '@rehearsal-labs/retest'

test('signs in with the secret as the user name', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('User name').fill(secret('password'))
  await page.getByLabel('Password').fill(secret('password'))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByTestId('account')).toHaveText('Signed in as {{password}}')
})
`,
  })
  const run = await runProject(t, root, { env: { RETEST_E2E_PASSWORD: TASK_APP_PASSWORD } })

  assert.equal(run.exit.code, 0, run.stderr)
  const [assertion] = eventsOf(run.events, 'assertion.passed')
  assert.ok(assertion !== undefined)
  assert.equal(lookOf(run, assertion).observed.text?.text, 'Signed in as {{password}}')
  assert.deepEqual(filesHolding(run.output, TASK_APP_PASSWORD), [], 'no file of the run folder holds the value')
  assert.ok(!textHolds(run.stdout, TASK_APP_PASSWORD) && !textHolds(run.stderr, TASK_APP_PASSWORD))
})

test('a test file that claims toBeVisible on a look that matched nothing ends in an error, its process gone, and no pass is written', async (t) => {
  const app = await openApp(t)
  const file = scenario('forged-visible')
  const run = await runRetest(t, { files: [file], baseUrl: app.url })
  assertStdoutIsEvents(run)

  assert.equal(run.exit.code, 1, run.stderr)
  const forged = testNamed(run, 'claims a missing element is visible')
  assert.deepEqual([forged.status, forged.failure?.class], ['failed', 'test_error'])
  assert.equal(
    forged.failure?.message,
    "The process for this file sent assertion.passed for expect(getByTestId('missing')).toBeVisible(), which fails on o1, the look it named, where nothing matched.",
  )
  assert.deepEqual(eventsOf(run.events, 'assertion.passed'), [], 'no pass is written for the claim')
  assert.deepEqual(
    eventsOf(run.events, 'observation').map((look) => [look.origin, look.observationId, look.locator, look.observed.count]),
    [['parent', 'o1', { by: 'testId', value: 'missing' }, 0]],
  )
  const [pid] = printedPids(childLog(run, file))
  assert.ok(pid !== undefined && !isRunning(pid), 'the process that lied is gone')
  assert.deepEqual([testNamed(run, 'never gets a turn').status], ['not_run'])
})
