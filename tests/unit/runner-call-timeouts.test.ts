import type { EventBody } from '../../src/protocol/events.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { describeWait } from '../../src/reporters/failure-card.ts'
import { formatDuration } from '../../src/reporters/format.ts'
import { scriptedApp, scriptedTest } from '../support/scripted-process.ts'
import { stamp } from './reporters-fixtures.ts'

type ActionFailed = Extract<EventBody, { type: 'action.failed' }>

const missing = { kind: 'click', locator: { by: 'testId', value: 'missing' } } as const

function failedAction(events: readonly { body: EventBody }[]): ActionFailed {
  const found = events.map(({ body }) => body).find((body): body is ActionFailed => body.type === 'action.failed')
  assert.ok(found !== undefined, 'the action failed')
  return found
}

// The parent's own path: a scripted test file process sends the command, the parent gives the fake page its time.
describe('a call that gives itself a timeout', () => {
  test('is held to it by the parent, whatever time the test process claims, and the event records what was applied', async () => {
    const scripted = await scriptedTest({ timeouts: { action: 5000, test: 10_000 } })
    const startedAt = performance.now()
    // A forged message: it claims the whole action budget while saying the call asked for 300 ms.
    scripted.process.deliver({ type: 'command', ...scripted.process.scope, id: 1, app: scriptedApp, command: missing, timeoutMs: 5000, callTimeoutMs: 300 })
    const answer = await scripted.process.answer(1)
    const tookMs = performance.now() - startedAt
    assert.equal(answer.ok, false)
    assert.equal(answer.ok ? undefined : answer.failure.message, "getByTestId('missing') matched no element in 300 ms.")
    assert.ok(tookMs < 3000, `the page was given 300 ms and answered after ${Math.round(tookMs)} ms, not the 5000 ms claimed`)
    const event = failedAction(scripted.events)
    assert.deepEqual([event.timeoutMs, event.callTimeoutMs], [300, 300])
    const [stamped] = stamp([event])
    assert.ok(stamped?.type === 'action.failed')
    assert.match(describeWait(stamped, formatDuration), /, limit 300 ms set by the call$/)
    await scripted.finish()
  })

  test("is cut to the test's time left, and the card says the call's longer timeout was not the limit", async () => {
    const scripted = await scriptedTest({ timeouts: { action: 5000, test: 400 } })
    scripted.process.deliver({ type: 'command', ...scripted.process.scope, id: 1, app: scriptedApp, command: missing, timeoutMs: 2000, callTimeoutMs: 2000 })
    const answer = await scripted.process.answer(1)
    assert.equal(answer.ok, false)
    // The test ran out of time, so the parent ends its process; the page's own answer to the click comes after.
    const report = await scripted.report
    assert.equal(report.timedOut, true)
    await scripted.running.settle(3000)
    const event = failedAction(scripted.events)
    assert.equal(event.callTimeoutMs, 2000)
    assert.ok(event.timeoutMs !== undefined && event.timeoutMs > 0 && event.timeoutMs <= 400, `the parent gave the command ${event.timeoutMs} ms`)
    const [stamped] = stamp([event])
    assert.ok(stamped?.type === 'action.failed')
    const waited = describeWait(stamped, formatDuration)
    assert.match(waited, /, limit \d+ ms, shorter than the 2s the call asked for$/)
    assert.doesNotMatch(waited, /set by the call/)
    scripted.running.close()
  })

  test('a call that gives no timeout records none, and its card shows no limit of its own', async () => {
    const scripted = await scriptedTest({ timeouts: { action: 300 } })
    scripted.process.deliver({ type: 'command', ...scripted.process.scope, id: 1, app: scriptedApp, command: missing, timeoutMs: 300 })
    await scripted.process.answer(1)
    const event = failedAction(scripted.events)
    assert.deepEqual([event.timeoutMs, event.callTimeoutMs], [undefined, undefined])
    const [stamped] = stamp([event])
    assert.ok(stamped?.type === 'action.failed')
    assert.match(describeWait(stamped, formatDuration), /^\d+ ms for click$/)
    await scripted.finish()
  })
})
