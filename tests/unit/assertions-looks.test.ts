import type { CommandResult, PageCommand } from '../../src/protocol/commands.ts'
import assert from 'node:assert/strict'
import { describe, test as check } from 'node:test'
import { expect } from '../../src/index.ts'
import { lookFloorMs } from '../../src/assertions/poll-locator.ts'
import { inProcessRun, pageWithText } from '../support/api/in-process-run.ts'
import { manualTime } from '../support/manual-time.ts'
import { observationOf } from '../support/observation.ts'

const file = 'tests/unit/assertions-looks.test.ts'

/** A page that counts its changes: each look answers the next text, and says how many changes it has seen. */
function changingPage(texts: readonly string[], changesPerLook: readonly number[]) {
  let looks = 0
  const respond = (command: PageCommand): CommandResult => {
    if (command.kind !== 'observe') return { ok: false, failure: { class: 'unsupported', message: 'looks only' } }
    const index = Math.min(looks++, texts.length - 1)
    const text = texts[index] ?? ''
    const changes = changesPerLook[index] ?? 0
    return { ok: true, kind: 'observe', observation: observationOf([{ text, visible: true }]), changes }
  }
  return respond
}

function observes(commands: readonly PageCommand[]) {
  return commands.flatMap((command) => (command.kind === 'observe' ? [command.after ?? null] : []))
}

describe('a locator assertion on a page that counts its changes', () => {
  check('asks each later look to wait for the next change, at most the poll delay, and at least the floor apart', async () => {
    const time = manualTime()
    const { runPage, commands, events } = inProcessRun(file, changingPage(['Saving…', 'Saving…', 'Saving…', 'Saved'], [1, 1, 2, 3]), { time })
    const verdict = await time.runUntil(runPage(({ page }) => expect(page.getByTestId('saved-task')).toHaveText('Saved')))
    assert.equal(verdict.status, 'passed')
    // The clock moves only while the test process sleeps, so each wait reads exactly: the floor is the whole pause while
    // the delay is 50, and the page is asked for what the delay leaves beyond it. The in-process budget is 300 ms,
    // which cuts the fourth delay from 250 to the 200 that are left.
    assert.deepEqual(observes(commands), [
      null,
      { changes: 1, waitMs: 0 },
      { changes: 1, waitMs: 100 - lookFloorMs },
      { changes: 2, waitMs: 200 - lookFloorMs },
    ])
    const passed = events().find((event) => event.type === 'assertion.passed')
    assert.ok(passed?.type === 'assertion.passed')
    assert.equal(passed.attempts, 4)
  })

  check('a page that does not count its changes is looked at on the poll delays alone', async () => {
    const time = manualTime()
    const { runPage, commands } = inProcessRun(file, pageWithText('Saving…'), { time })
    const verdict = await time.runUntil(runPage(({ page }) => expect(page.getByTestId('saved-task')).toHaveText('Saved')))
    assert.equal(verdict.failure?.class, 'check_failed')
    assert.ok(observes(commands).every((after) => after === null))
    assert.match(verdict.failure?.message ?? '', /Looked 4 times in 300 ms\./)
  })

  check('the last look still lands on the deadline, with the page asked for what time is left', async () => {
    const time = manualTime()
    const { runPage, commands } = inProcessRun(file, changingPage(['Saving…'], [1]), { time, timeouts: { assertion: 120 } })
    const verdict = await time.runUntil(runPage(({ page }) => expect(page.getByTestId('saved-task')).toHaveText('Saved')))
    assert.equal(verdict.failure?.class, 'check_failed')
    // Looks at 0, 50, 100 and 120: the floor is paid in full while time allows, and the last look's pause is cut to the deadline.
    assert.deepEqual(observes(commands), [null, { changes: 1, waitMs: 0 }, { changes: 1, waitMs: 20 }, { changes: 1, waitMs: 0 }])
    assert.match(verdict.failure?.message ?? '', /Looked 4 times in 120 ms\./)
  })
})

/**
 * A clock that reads fractions of a millisecond, as the host's monotonic clock does: each look takes `lookMs`, and each
 * wait ends `earlyMs` before its time, as a Node timer can when read against that clock. `looks` holds when each look
 * was sent.
 */
function fractionalTime({ lookMs, earlyMs }: { lookMs: number; earlyMs: number }) {
  const time = manualTime()
  let spent = 0
  const looks: number[] = []
  const now = (): number => time.now() + spent
  const page = (command: PageCommand): CommandResult => {
    if (command.kind !== 'observe') return { ok: false, failure: { class: 'unsupported', message: 'looks only' } }
    looks.push(now())
    spent += lookMs
    return { ok: true, kind: 'observe', observation: observationOf([{ text: 'Saving…', visible: true }]) }
  }
  const sleep = (ms: number, signal?: AbortSignal): Promise<void> => time.sleep(Math.max(0, ms - earlyMs), signal)
  return { time: { now, sleep, runUntil: time.runUntil }, page, looks }
}

describe('an assertion on a clock that reads fractions of a millisecond', () => {
  const cases = [
    { name: 'when each look takes a tenth of a millisecond', lookMs: 0.1, earlyMs: 0 },
    { name: 'when, besides, every wait ends 0.6 ms before its time', lookMs: 0.1, earlyMs: 0.6 },
    { name: 'when an early last wait and its read would straddle the deadline', lookMs: 0.2, earlyMs: 0.9 },
  ]
  for (const { name, lookMs, earlyMs } of cases) {
    check(`fails only once its whole time has passed, with its last look at or after its deadline, ${name}`, async () => {
      const clock = fractionalTime({ lookMs, earlyMs })
      const { runPage, events } = inProcessRun(file, clock.page, { time: clock.time, timeouts: { assertion: 120 } })
      const verdict = await clock.time.runUntil(runPage(({ page }) => expect(page.getByTestId('saved-task')).toHaveText('Saved')))
      assert.equal(verdict.failure?.class, 'check_failed')
      const last = clock.looks.at(-1) ?? 0
      assert.ok(last >= 120, `the last look was sent at ${last} ms of 120: ${clock.looks.join(', ')}`)
      assert.ok(clock.looks.slice(0, -1).every((at) => at < 120), `one look at or after the deadline, the last: ${clock.looks.join(', ')}`)
      const failed = events().find((event) => event.type === 'assertion.failed')
      assert.ok(failed?.type === 'assertion.failed')
      assert.ok(failed.durationMs >= 120, `the assertion gave up after ${failed.durationMs} ms of 120`)
      assert.equal(failed.attempts, clock.looks.length)
      assert.ok(clock.time.now() < 122, `the final look ended at ${clock.time.now()} ms of 120`)
    })
  }
})

check('a non-time failure after an earlier look returns at once, including in the deadline\'s last fraction', async () => {
  const clock = manualTime()
  let spent = 0
  let looks = 0
  const time = { now: () => clock.now() + spent, sleep: clock.sleep }
  const refusal = { class: 'unsupported', message: 'The page cannot read this locator.' } as const
  const { runPage } = inProcessRun(file, () => {
    looks++
    if (looks === 1) return { ok: true, kind: 'observe', observation: observationOf([{ text: 'Saving', visible: true }]) }
    spent = 69.5
    return { ok: false, failure: refusal }
  }, { time, timeouts: { assertion: 120 } })
  const verdict = await clock.runUntil(runPage(({ page }) => expect(page.getByTestId('saved-task')).toHaveText('Saved')))
  assert.equal(looks, 2)
  assert.equal(verdict.failure?.class, refusal.class)
  assert.equal(verdict.failure?.message, refusal.message)
  assert.equal(time.now(), 119.5)
})
