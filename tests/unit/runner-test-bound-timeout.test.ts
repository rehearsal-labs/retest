import type { CommandResult } from '../../src/protocol/commands.ts'
import type { EventBody } from '../../src/protocol/events.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { controlledClock } from '../support/controlled-clock.ts'
import { scriptedTest } from '../support/scripted-process.ts'

type ActionFailed = Extract<EventBody, { type: 'action.failed' }>

// A command gets no more time than its test has left, in whole milliseconds rounded down, so the page's clock for it
// can end up to a millisecond before the test's own timer, and the page can answer that it ran out first. The test's
// time is what ran out either way, and the failure says so whichever clock ends first.
test("a command that runs out of the time its test had left fails the test with the test's own budget, before the test's timer fires", async (t) => {
  const clock = controlledClock(t)
  const run = await scriptedTest({ fake: { hang: 'goto' }, timeouts: { test: 500, navigation: 30_000 } })
  // Half a millisecond in, the test has 499.5 ms left: the goto gets 499, and the page's clock for it ends at 499.5.
  await clock.advance(0.5)
  let answered: CommandResult | undefined
  const answering = run.command(1, { kind: 'goto', url: '/' }).then((answer) => { answered = answer; return answer })
  await clock.flush()
  await clock.advance(499)
  await clock.flush()
  const [action] = run.events.map(({ body }) => body).filter((body): body is ActionFailed => body.type === 'action.failed')
  assert.equal(answered, undefined, "the page's answer waits for the test's own end, half a millisecond away")
  assert.equal(action, undefined)
  await clock.advance(1)
  const answer = await answering
  assert.equal(answer.ok, false)
  assert.equal(answer.ok ? undefined : answer.failure.class, 'timeout')
  assert.match(answer.ok ? '' : answer.failure.message, /^The test ran longer than its 500 ms budget\. It was waiting for /)
  run.process.deliver({ type: 'test-finished', ...run.process.scope, status: 'failed', ...(answer.ok ? {} : { failure: answer.failure }), assertionCount: 0, durationMs: 500 })
  const report = await run.report
  await clock.flush()
  assert.equal(report.timedOut, true)
  assert.match(report.failure?.message ?? '', /^The test ran longer than its 500 ms budget\. It was waiting for /)
  const [recorded] = run.events.map(({ body }) => body).filter((body): body is ActionFailed => body.type === 'action.failed')
  assert.equal(recorded?.failure.message, 'goto took longer than 499 ms.', 'the action is recorded as the page answered it')
  run.running.close()
})
