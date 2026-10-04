import type { NativeCheckRecord } from '../../src/native/assertions.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openFake } from './native-interaction-fake.ts'

// Native checks judged from the session's scoped tree, with the web's `.not` rules and poll shape, and each check the
// platform cannot judge on the element that matched refused as unsupported rather than passed.

const state: LocatorRecipe = { by: 'testId', value: 'created-task-state' }

function phone(): Parameters<typeof openFake>[1] {
  return {
    platform: 'ios-simulator',
    screen: () => [
      { type: 'StaticText', identifier: 'created-task-state', label: 'Open', frame: { x: 300, y: 600, width: 50, height: 20 } },
      { type: 'StaticText', identifier: 'hidden-note', label: 'Later', visible: false, frame: { x: 0, y: 0, width: 50, height: 20 } },
      { type: 'TextField', identifier: 'new-task-title-field', label: '', placeholder: 'Title', text: '', frame: { x: 32, y: 466, width: 338, height: 25 } },
      { type: 'Button', identifier: 'create-task-button', label: 'Create task', enabled: false, frame: { x: 16, y: 505, width: 370, height: 55 } },
      { type: 'Cell', identifier: 'row-1', label: 'One', traits: 'Selected', frame: { x: 0, y: 700, width: 400, height: 40 } },
      { type: 'Cell', identifier: 'row-2', label: 'Two', frame: { x: 0, y: 740, width: 400, height: 40 } },
      { type: 'Switch', identifier: 'done-switch', label: 'Done', value: '1', frame: { x: 300, y: 800, width: 50, height: 30 } },
    ],
  }
}

async function verdict(t: Parameters<typeof openFake>[0], record: NativeCheckRecord, locator: LocatorRecipe = state, timeoutMs = 300): Promise<{ readonly passed: boolean; readonly failureClass?: string; readonly message?: string; readonly attempts: number }> {
  const { interaction } = await openFake(t, phone())
  const result = await interaction.expect(locator, record, timeoutMs)
  return { passed: result.passed, ...(result.failure === undefined ? {} : { failureClass: result.failure.class, message: result.failure.message }), attempts: result.attempts }
}

test('text, contained text and patterns pass and fail as on the web, and a wrong text names the element and how long Retest looked', async (t) => {
  assert.equal((await verdict(t, { matcher: 'toHaveText', text: ' Open ' })).passed, true)
  assert.equal((await verdict(t, { matcher: 'toHaveText', pattern: { pattern: '^op', flags: 'i' } })).passed, true)
  assert.equal((await verdict(t, { matcher: 'toContainText', text: 'pe' })).passed, true)
  const wrong = await verdict(t, { matcher: 'toHaveText', text: 'Done' })
  assert.equal(wrong.failureClass, 'check_failed')
  assert.match(wrong.message ?? '', /^getByTestId\('created-task-state'\) has text "Open", expected "Done"\. Compared whole text, ends trimmed, each run of spaces or line breaks read as one space\. Looked \d+ times in 300 ms\.$/)
  assert.ok(wrong.attempts > 1, 'it looked again until the deadline')
  assert.equal((await verdict(t, { matcher: 'toHaveText', text: 'Done', not: true })).passed, true)
  assert.equal((await verdict(t, { matcher: 'toHaveText', text: 'Open', not: true })).failureClass, 'check_failed')
})

test('visible and hidden follow the web\'s rules: no element is not visible and is hidden, and .not of each', async (t) => {
  assert.equal((await verdict(t, { matcher: 'toBeVisible' })).passed, true)
  assert.equal((await verdict(t, { matcher: 'toBeVisible' }, { by: 'testId', value: 'hidden-note' })).failureClass, 'check_failed')
  assert.equal((await verdict(t, { matcher: 'toBeHidden' }, { by: 'testId', value: 'hidden-note' })).passed, true)
  assert.equal((await verdict(t, { matcher: 'toBeHidden' }, { by: 'testId', value: 'nothing' })).passed, true)
  assert.equal((await verdict(t, { matcher: 'toBeVisible', not: true }, { by: 'testId', value: 'nothing' })).passed, true)
  assert.equal((await verdict(t, { matcher: 'toBeHidden', not: true }, { by: 'testId', value: 'nothing' })).failureClass, 'not_found')
})

test('enabled, disabled, value and count are judged from the tree, an iOS placeholder reading as an empty value', async (t) => {
  const button: LocatorRecipe = { by: 'testId', value: 'create-task-button' }
  assert.equal((await verdict(t, { matcher: 'toBeDisabled' }, button)).passed, true)
  assert.equal((await verdict(t, { matcher: 'toBeEnabled' }, button)).failureClass, 'check_failed')
  assert.equal((await verdict(t, { matcher: 'toBeEnabled', not: true }, button)).passed, true)
  const field: LocatorRecipe = { by: 'testId', value: 'new-task-title-field' }
  assert.equal((await verdict(t, { matcher: 'toHaveValue', value: '' }, field)).passed, true)
  assert.equal((await verdict(t, { matcher: 'toHaveValue', value: 'Title' }, field)).failureClass, 'check_failed')
  assert.equal((await verdict(t, { matcher: 'toHaveCount', count: 2 }, { by: 'role', role: 'cell' })).passed, true)
  assert.equal((await verdict(t, { matcher: 'toHaveCount', count: 2, not: true }, { by: 'role', role: 'cell' })).failureClass, 'check_failed')
})

test('selected and checked are read where the platform has them, with .not; a single check on several matches is ambiguous', async (t) => {
  assert.equal((await verdict(t, { matcher: 'toBeSelected' }, { by: 'testId', value: 'row-1' })).passed, true)
  assert.equal((await verdict(t, { matcher: 'toBeSelected', not: true }, { by: 'testId', value: 'row-2' })).passed, true)
  assert.equal((await verdict(t, { matcher: 'toBeSelected' }, { by: 'testId', value: 'row-2' })).failureClass, 'check_failed')
  assert.equal((await verdict(t, { matcher: 'toBeSelected', not: true }, { by: 'testId', value: 'nothing' })).failureClass, 'not_found', 'a negation does not pass on no element')
  assert.equal((await verdict(t, { matcher: 'toBeChecked' }, { by: 'testId', value: 'done-switch' })).passed, true)
  assert.equal((await verdict(t, { matcher: 'toBeSelected' }, { by: 'role', role: 'cell' })).failureClass, 'ambiguous')
})

test('a check the platform cannot judge on the element that matched is refused at once as unsupported, negated or not, never passed', async (t) => {
  const cases: { record: NativeCheckRecord; locator: LocatorRecipe; reason: RegExp }[] = [
    { record: { matcher: 'toBeSelected' }, locator: state, reason: /is the StaticText "created-task-state", which has no selected state on iOS that Retest reads/ },
    { record: { matcher: 'toBeSelected', not: true }, locator: state, reason: /no selected state on iOS/ },
    { record: { matcher: 'toHaveValue', value: 'Open' }, locator: state, reason: /which has no value on iOS/ },
    { record: { matcher: 'toHaveText', text: '' }, locator: { by: 'testId', value: 'new-task-title-field' }, reason: /a field's text is what was typed, which toHaveText does not read\. Use toHaveValue\./ },
    { record: { matcher: 'toBeChecked', not: true }, locator: { by: 'testId', value: 'create-task-button' }, reason: /which has no checked state on iOS/ },
  ]
  for (const { record, locator, reason } of cases) {
    const started = performance.now()
    const result = await verdict(t, record, locator, 2000)
    assert.equal(result.failureClass, 'unsupported', JSON.stringify(record))
    assert.match(result.message ?? '', reason)
    assert.equal(result.attempts, 1, 'it did not wait')
    assert.ok(performance.now() - started < 1500)
  }
})

test('a check looks again until the app shows what it expects, and never acts', async (t) => {
  const { app, interaction } = await openFake(t, phone())
  setTimeout(() => {
    app.find('created-task-state').label = 'Done'
  }, 250)
  const result = await interaction.expect(state, { matcher: 'toHaveText', text: 'Done' }, 3000)
  assert.equal(result.passed, true)
  assert.ok(result.attempts >= 2, `looked ${result.attempts} times`)
  assert.equal(result.actual?.text, 'Done')
  assert.equal(app.requests.some((request) => request.route.endsWith('/click') || request.route.endsWith('/keys')), false)
  assert.equal(result.look?.reference.sessionId, 'attempt:phone')
})

test('a look at nothing fails as not found, naming the step that kept nothing', async (t) => {
  const result = await verdict(t, { matcher: 'toHaveText', text: 'Open' }, { by: 'testId', value: 'created-task-state', within: [{ by: 'testId', value: 'created-section' }] })
  assert.equal(result.failureClass, 'not_found')
  assert.match(result.message ?? '', /matched no element\. getByTestId\('created-section'\) matched no element\. Looked \d+ times in 300 ms\./)
})
