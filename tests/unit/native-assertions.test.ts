import type { NativeKind } from '../../src/browser/contract.ts'
import type { NativeCheckRecord, NativeLook } from '../../src/native/assertions.ts'
import type { Failure } from '../../src/protocol/failures.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import type { FakeElement } from './native-interaction-fake.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { observeTree, pollNative, unsupportedCheck } from '../../src/native/assertions.ts'
import { manualTime } from '../support/manual-time.ts'
import { parseNativeTree } from '../../src/native/locators.ts'
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

test('enabled, disabled, value and count are judged from the tree; an iOS value equal to its placeholder passes no value check either way', async (t) => {
  const button: LocatorRecipe = { by: 'testId', value: 'create-task-button' }
  assert.equal((await verdict(t, { matcher: 'toBeDisabled' }, button)).passed, true)
  assert.equal((await verdict(t, { matcher: 'toBeEnabled' }, button)).failureClass, 'check_failed')
  assert.equal((await verdict(t, { matcher: 'toBeEnabled', not: true }, button)).passed, true)
  // An empty field shows its placeholder as its value, and so does one holding the placeholder's text.
  const field: LocatorRecipe = { by: 'testId', value: 'new-task-title-field' }
  const empty = await verdict(t, { matcher: 'toHaveValue', value: '' }, field)
  assert.equal(empty.failureClass, 'check_failed')
  assert.match(empty.message ?? '', /whose value reads as its placeholder "Title": iOS's executor writes the placeholder as the value of an empty field, so Retest cannot tell an empty field from one holding that text, and toHaveValue passes in neither direction/)
  assert.equal((await verdict(t, { matcher: 'toHaveValue', value: 'Title' }, field)).failureClass, 'check_failed')
  assert.equal((await verdict(t, { matcher: 'toHaveValue', value: '', not: true }, field)).failureClass, 'check_failed')
  assert.equal((await verdict(t, { matcher: 'toHaveValue', value: 'Title', not: true }, field)).failureClass, 'check_failed')
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

function treeOf(xml: string, platform: NativeKind): NativeLook['tree'] {
  const parsed = parseNativeTree(xml, platform)
  if (!parsed.ok) throw new Error(parsed.problem)
  return parsed.tree
}

const openTree = treeOf('<XCUIElementTypeApplication type="XCUIElementTypeApplication" name="TaskPhone" label="TaskPhone" enabled="true" visible="true" x="0" y="0" width="402" height="874"><XCUIElementTypeStaticText type="XCUIElementTypeStaticText" value="Open" name="created-task-state" label="Open" enabled="true" visible="true" x="300" y="600" width="50" height="20" traits=""/></XCUIElementTypeApplication>', 'ios-simulator')

function lookAt(tree: NativeLook['tree']): NativeLook {
  const observed = observeTree(tree, state)
  if (!observed.ok) throw new Error(observed.failure.message)
  return { observation: observed.observation, matches: observed.matches, reference: { sessionId: 'attempt:phone', instance: 'i', generation: 1, observationId: 'o1' }, tree }
}

for (const earlyMs of [0, 0.6, 0.9]) {
  test(`a native check reads at or after its fractional-clock deadline when waits fire ${earlyMs} ms early`, async () => {
    const clock = manualTime()
    let spent = 0
    const looks: number[] = []
    const time = { now: () => clock.now() + spent, sleep: (ms: number, signal?: AbortSignal) => clock.sleep(Math.max(0, ms - earlyMs), signal) }
    const result = await clock.runUntil(pollNative({
      recipe: state, record: { matcher: 'toHaveText', text: 'Done' }, timeoutMs: 120,
      platform: 'ios-simulator', signal: new AbortController().signal, time,
      look: async () => {
        looks.push(time.now())
        spent += earlyMs === 0.9 ? 0.2 : 0.1
        return { ok: true, look: lookAt(openTree) }
      },
    }))
    assert.equal(result.failure?.class, 'check_failed')
    assert.ok((looks.at(-1) ?? 0) >= 120, `last read at ${looks.at(-1)}: ${looks.join(', ')}`)
    assert.ok(time.now() < 122, `the wait ended at ${time.now()}`)
  })
}

test('a look that runs out of time before the check\'s deadline preserves the last observation and waits through the deadline', async () => {
  for (const earlyMs of [2, 8, 30]) {
    let looks = 0
    const startedAt = performance.now()
    const result = await pollNative({
      recipe: state,
      record: { matcher: 'toHaveText', text: 'Done' },
      timeoutMs: 600,
      platform: 'ios-simulator',
      signal: new AbortController().signal,
      // The first look sees "Open"; every later one sits under budgets that end it before the check's own deadline.
      look: async (timeoutMs) => {
        looks += 1
        if (looks === 1) return { ok: true, look: lookAt(openTree) }
        await sleep(Math.max(1, timeoutMs - earlyMs))
        const failure: Failure = { class: 'timeout', message: 'Reading the app\'s tree: no answer in time.' }
        return { ok: false, failure }
      },
    })
    assert.equal(result.failure?.class, 'check_failed', `${earlyMs} ms early: ${result.failure?.message ?? 'it passed'}`)
    assert.match(result.failure?.message ?? '', /has text "Open", expected "Done"/)
    assert.equal(result.actual?.text, 'Open')
    assert.ok(performance.now() - startedAt >= 600, 'an early read timeout cannot end the check early')
  }
  // With no look answered, a timeout says so and observes nothing.
  const none = await pollNative({ recipe: state, record: { matcher: 'toHaveText', text: 'Done' }, timeoutMs: 200, platform: 'ios-simulator', signal: new AbortController().signal, look: async (timeoutMs) => {
    await sleep(timeoutMs)
    return { ok: false, failure: { class: 'timeout', message: 'Reading the app\'s tree: no answer in time.' } }
  } })
  assert.equal(none.failure?.class, 'timeout')
  assert.equal(none.actual, null)
})

test('a native read timeout preserves the last look and reads once more at the exact deadline', async () => {
  const clock = manualTime()
  let spent = 0
  const looks: number[] = []
  const time = { now: () => clock.now() + spent, sleep: clock.sleep }
  const result = await clock.runUntil(pollNative({
    recipe: state, record: { matcher: 'toHaveText', text: 'Done' }, timeoutMs: 120,
    platform: 'ios-simulator', signal: new AbortController().signal, time,
    look: async () => {
      looks.push(time.now())
      if (looks.length === 1) {
        spent += 0.1
        return { ok: true, look: lookAt(openTree) }
      }
      if (looks.length === 2) spent += 69.5
      return { ok: false, failure: { class: 'timeout', message: 'Tree read timed out.' } }
    },
  }))
  assert.equal(result.failure?.class, 'check_failed')
  assert.equal(result.actual?.text, 'Open')
  assert.ok((looks.at(-1) ?? 0) >= 120, `last read at ${looks.at(-1)}: ${looks.join(', ')}`)
})

test('a state the executor did not report passes no check in either direction and fails naming what was not reported', async (t) => {
  const unreported = (platform: NativeKind, element: Partial<FakeElement>): Parameters<typeof openFake>[1] => ({ platform, screen: () => [{ type: 'Button', identifier: 'subject', label: 'Subject', frame: platform === 'macos' ? { x: 40, y: 100, width: 80, height: 24 } : { x: 16, y: 300, width: 100, height: 44 }, ...element }] })
  const subject: LocatorRecipe = { by: 'testId', value: 'subject' }
  const cases: { options: Parameters<typeof openFake>[1]; records: NativeCheckRecord[]; attribute: string }[] = [
    { options: unreported('ios-simulator', { omit: ['enabled'] }), records: [{ matcher: 'toBeDisabled' }, { matcher: 'toBeEnabled' }, { matcher: 'toBeEnabled', not: true }], attribute: 'enabled' },
    { options: unreported('macos', { type: 'Cell', omit: ['selected'] }), records: [{ matcher: 'toBeSelected', not: true }, { matcher: 'toBeSelected' }], attribute: 'selected' },
    { options: unreported('ios-simulator', { type: 'Cell', omit: ['traits'] }), records: [{ matcher: 'toBeSelected', not: true }, { matcher: 'toBeSelected' }], attribute: 'traits' },
    { options: unreported('ios-simulator', { type: 'TextField', text: 'x', omit: ['value'] }), records: [{ matcher: 'toHaveValue', value: '' }, { matcher: 'toHaveValue', value: 'x', not: true }], attribute: 'value' },
    { options: unreported('ios-simulator', { omit: ['visible'] }), records: [{ matcher: 'toBeHidden' }, { matcher: 'toBeVisible' }], attribute: 'visible' },
  ]
  for (const { options, records, attribute } of cases) {
    for (const record of records) {
      const { interaction } = await openFake(t, options)
      const result = await interaction.expect(subject, record, 300)
      assert.equal(result.passed, false, `${attribute} ${JSON.stringify(record)} passed`)
      assert.equal(result.failure?.class, 'check_failed', `${attribute} ${JSON.stringify(record)}: ${result.failure?.message ?? ''}`)
      assert.match(result.failure?.message ?? '', new RegExp(`the executor did not report its ${attribute} in the tree`), JSON.stringify(record))
      assert.equal(result.failure?.details?.['unreported'], attribute)
      // The parent, judging the same look, names the same thing.
      const look = result.look
      assert.ok(look !== undefined)
      assert.equal(unsupportedCheck(record, look.matches, subject, look.tree.platform)?.details?.['unreported'], attribute)
    }
  }
})
