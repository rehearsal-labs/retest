import type { EventBody } from '../../src/protocol/events.ts'
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
