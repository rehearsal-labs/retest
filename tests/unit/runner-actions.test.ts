import type { EventBody } from '../../src/protocol/events.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { scriptedTest } from '../support/scripted-process.ts'

type ActionBody = Extract<EventBody, { type: 'action.completed' | 'action.failed' }>

function actions(events: readonly { body: EventBody }[]): ActionBody[] {
  return events.flatMap(({ body }) => (body.type === 'action.completed' || body.type === 'action.failed' ? [body] : []))
}

describe('the events of a press', () => {
  test('a press on a locator records its key and its locator, and reaches the element', async () => {
    const run = await scriptedTest()
    const answer = await run.command(1, { kind: 'press', locator: { by: 'testId', value: 'task-title' }, key: 'Enter' })
    await run.finish()
    assert.deepEqual(answer, { ok: true, kind: 'press' })
    assert.deepEqual(run.page.pressed, [{ key: 'Enter', testId: 'task-title' }])
    const [pressed] = actions(run.events)
    assert.equal(pressed?.type, 'action.completed')
    assert.deepEqual([pressed?.command, pressed?.key, pressed?.locator, pressed?.session], ['press', 'Enter', { by: 'testId', value: 'task-title' }, 'page'])
  })

  test("a press on the page's keyboard records its key and no locator at all", async () => {
    const run = await scriptedTest()
    await run.command(1, { kind: 'press', key: 'Shift+Tab' })
    await run.finish()
    assert.deepEqual(run.page.pressed, [{ key: 'Shift+Tab' }])
    const [pressed] = actions(run.events)
    assert.equal(pressed?.key, 'Shift+Tab')
    assert.ok(pressed !== undefined && !('locator' in pressed), 'the event has no locator key, not even an undefined one')
  })

  test('a key the parent does not accept is refused before the page sees it, as usage or unsupported', async () => {
    const run = await scriptedTest()
    const misspelt = await run.command(1, { kind: 'press', locator: { by: 'testId', value: 'task-title' }, key: 'Entr' })
    const shortcut = await run.command(2, { kind: 'press', key: 'Control+a' })
    await run.finish()
    assert.deepEqual([misspelt.ok ? undefined : misspelt.failure.class, shortcut.ok ? undefined : shortcut.failure.class], ['usage', 'unsupported'])
    assert.match(misspelt.ok ? '' : misspelt.failure.message, /press\(\) takes a named key/)
    assert.deepEqual(run.page.pressed, [])
    assert.ok(!run.page.browser.commands.some((command) => command.kind === 'press'), 'no press reached the page')
    const failed = actions(run.events)
    assert.deepEqual(
      failed.map((event) => [event.type, event.key, 'locator' in event]),
      [
        ['action.failed', 'Entr', true],
        ['action.failed', 'Control+a', false],
      ],
    )
  })

  test('a press on an element that is not there fails as the page says', async () => {
    const run = await scriptedTest()
    const answer = await run.command(1, { kind: 'press', locator: { by: 'testId', value: 'nowhere' }, key: 'a' })
    await run.finish()
    assert.equal(answer.ok ? undefined : answer.failure.class, 'not_found')
    assert.deepEqual(actions(run.events).map((event) => [event.type, event.key]), [['action.failed', 'a']])
  })
})

const country: LocatorRecipe = { by: 'testId', value: 'country' }
const toppings: LocatorRecipe = { by: 'testId', value: 'toppings' }
const rememberMe: LocatorRecipe = { by: 'testId', value: 'remember-me' }

describe('the events of a select', () => {
  test('records the options as the test named them, that the choice changed, and that a script made it', async () => {
    const run = await scriptedTest()
    await run.command(1, { kind: 'goto', url: '/' })
    const answer = await run.command(2, { kind: 'select', locator: country, choices: [{ label: 'France' }] })
    await run.finish()
    assert.deepEqual(answer.ok && answer.kind === 'select' ? answer.changed : undefined, true)
    assert.deepEqual(run.page.selects.get('country')?.selected, ['fr'])
    const [, selected] = actions(run.events)
    assert.equal(selected?.type, 'action.completed')
    assert.deepEqual(
      [selected?.command, selected?.locator, selected?.choices, selected?.changed, selected?.input, selected?.pageUrl],
      ['select', country, [{ label: 'France' }], true, 'script', 'http://127.0.0.1:4173/'],
    )
    assert.ok(selected !== undefined && !('multiple' in selected), 'one option on its own is no list')
  })

  test('a list says so, even of one, and a choice already made records that nothing changed', async () => {
    const run = await scriptedTest()
    await run.command(1, { kind: 'select', locator: toppings, choices: [{ label: 'Cheese' }, { value: 'basil' }], multiple: true })
    await run.command(2, { kind: 'select', locator: toppings, choices: [{ value: 'olives' }], multiple: true })
    await run.command(3, { kind: 'select', locator: country, choices: [{ value: 'ca' }] })
    await run.finish()
    assert.deepEqual(run.page.selects.get('toppings')?.selected, ['olives'])
    assert.deepEqual(
      actions(run.events).map((event) => [event.choices, event.multiple, event.changed, event.input]),
      [
        [[{ label: 'Cheese' }, { value: 'basil' }], true, true, 'script'],
        [[{ value: 'olives' }], true, true, 'script'],
        [[{ value: 'ca' }], undefined, false, 'script'],
      ],
    )
  })

  test('a select that fails keeps its options and its script, and says nothing of a change', async () => {
    const run = await scriptedTest()
    const answer = await run.command(1, { kind: 'select', locator: country, choices: [{ label: 'Atlantis' }] })
    await run.finish()
    assert.equal(answer.ok ? undefined : answer.failure.class, 'not_found')
    const [failed] = actions(run.events)
    assert.deepEqual([failed?.type, failed?.choices, failed?.input], ['action.failed', [{ label: 'Atlantis' }], 'script'])
    assert.ok(failed !== undefined && !('changed' in failed))
  })

  test('the parent refuses no option at all, and several that were not a list, before the page sees either', async () => {
    const run = await scriptedTest()
    const empty = await run.command(1, { kind: 'select', locator: toppings, choices: [], multiple: true })
    const unlisted = await run.command(2, { kind: 'select', locator: toppings, choices: [{ label: 'Cheese' }, { label: 'Basil' }] })
    await run.finish()
    assert.deepEqual(
      [empty, unlisted].map((answer) => (answer.ok ? undefined : answer.failure)),
      [
        { class: 'usage', message: 'select() needs at least one option, received an empty list.' },
        { class: 'usage', message: 'select() received 2 options that were not a list. Several options need a list.' },
      ],
    )
    assert.ok(!run.page.browser.commands.some((command) => command.kind === 'select'), 'no select reached the page')
    assert.deepEqual(run.page.selects.get('toppings')?.selected, [])
    assert.deepEqual(actions(run.events).map((event) => (event.type === 'action.failed' ? event.failure.class : event.type)), ['usage', 'usage'])
  })
})

describe('the events of check and uncheck', () => {
  test('a check records that it changed the control; the next finds it done, sends nothing, and says so', async () => {
    const run = await scriptedTest()
    await run.command(1, { kind: 'check', locator: rememberMe })
    await run.command(2, { kind: 'check', locator: rememberMe })
    await run.command(3, { kind: 'uncheck', locator: rememberMe })
    const radio = await run.command(4, { kind: 'uncheck', locator: { by: 'testId', value: 'plan-monthly' } })
    await run.finish()
    assert.deepEqual(run.page.ticked, [{ testId: 'remember-me', input: 'click' }, { testId: 'remember-me', input: 'click' }], 'the radio button was never clicked')
    assert.equal(radio.ok ? undefined : radio.failure.class, 'unsupported')
    assert.deepEqual(
      actions(run.events).map((event) => [event.type, event.command, event.changed]),
      [
        ['action.completed', 'check', true],
        ['action.completed', 'check', false],
        ['action.completed', 'uncheck', true],
        ['action.failed', 'uncheck', undefined],
      ],
    )
    assert.ok(actions(run.events).every((event) => !('via' in event) && !('touch' in event) && !('input' in event)))
  })

  test('a hidden control ticked through its own label says so, and one that ignores its one click says nothing of a change', async () => {
    const run = await scriptedTest()
    await run.command(1, { kind: 'check', locator: { by: 'testId', value: 'styled-terms' } })
    const stuck = await run.command(2, { kind: 'check', locator: { by: 'testId', value: 'sticky-box' } })
    await run.finish()
    assert.equal(stuck.ok ? undefined : stuck.failure.class, 'not_actionable')
    const [checked, failed] = actions(run.events)
    assert.deepEqual([checked?.command, checked?.changed, checked?.via], ['check', true, 'label'])
    assert.deepEqual(failed?.type === 'action.failed' ? failed.failure.details : undefined, { check: 'state', inputSent: true })
    assert.ok(failed !== undefined && !('changed' in failed) && !('via' in failed))
    assert.deepEqual(run.page.ticked.map((entry) => entry.testId), ['styled-terms', 'sticky-box'], 'the stuck box was clicked once')
  })

  test('on a touch screen a check taps, and each check event says so, done or not, and stays a check', async () => {
    const run = await scriptedTest({ touch: true })
    await run.command(1, { kind: 'check', locator: rememberMe })
    await run.command(2, { kind: 'uncheck', locator: { by: 'testId', value: 'nowhere' } })
    await run.finish()
    assert.deepEqual(run.page.ticked, [{ testId: 'remember-me', input: 'tap' }])
    assert.deepEqual(
      actions(run.events).map((event) => [event.type, event.command, event.touch]),
      [
        ['action.completed', 'check', true],
        ['action.failed', 'uncheck', true],
      ],
    )
  })
})

describe('the events of a scroll', () => {
  test('a scroll records its delta, on the page with no locator, or on an element', async () => {
    const run = await scriptedTest()
    await run.command(1, { kind: 'scroll', x: 0, y: 600 })
    await run.command(2, { kind: 'scroll', locator: { by: 'testId', value: 'terms' }, x: -40.5, y: 1200 })
    await run.finish()
    assert.deepEqual(run.page.scrolled, [{ x: 0, y: 600 }, { testId: 'terms', x: -40.5, y: 1200 }])
    const [page, element] = actions(run.events)
    assert.deepEqual([page?.command, page?.scroll, element?.command, element?.scroll, element?.locator], ['scroll', { x: 0, y: 600 }, 'scroll', { x: -40.5, y: 1200 }, { by: 'testId', value: 'terms' }])
    assert.ok(page !== undefined && !('locator' in page), "the page's scroll has no locator")
  })

  test('the parent refuses a scroll that moves nothing, before the page sees it', async () => {
    const run = await scriptedTest()
    const answer = await run.command(1, { kind: 'scroll', x: 0, y: 0 })
    await run.finish()
    assert.deepEqual(answer.ok ? undefined : answer.failure, { class: 'usage', message: 'scroll() takes x and y in CSS pixels, one of them other than 0, received { x: 0, y: 0 }.' })
    assert.deepEqual(run.page.scrolled, [])
    assert.ok(!run.page.browser.commands.some((command) => command.kind === 'scroll'))
    assert.deepEqual(actions(run.events).map((event) => [event.type, event.scroll]), [['action.failed', { x: 0, y: 0 }]])
  })
})
