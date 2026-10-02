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
