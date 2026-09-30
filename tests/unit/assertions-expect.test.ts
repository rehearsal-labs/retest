import type { PageCommand } from '../../src/protocol/commands.ts'
import type { Responder } from '../support/api/in-process-run.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { expect } from '../../src/index.ts'
import { truncateText } from '../../src/protocol/failures.ts'
import { inProcessRun } from '../support/api/in-process-run.ts'
import { observationOf } from '../support/observation.ts'

const file = 'tests/unit/assertions-expect.test.ts'

/** A page whose saved task shows "Saving…" until `ready` looks have been taken. */
function savedAfter(ready: number): { respond: Responder; looks: () => number } {
  let looks = 0
  const respond: Responder = (command: PageCommand) => {
    if (command.kind !== 'observe') return { ok: true, kind: 'click' }
    looks++
    const text = looks > ready ? 'Release checklist' : 'Saving…'
    return { ok: true, kind: 'observe', observation: observationOf([{ text, visible: true }]) }
  }
  return { respond, looks: () => looks }
}

describe('locator assertions', () => {
  test('look again until the text appears, and never repeat the action before them', async () => {
    const page = savedAfter(3)
    const { commands, events, runPage } = inProcessRun(file, page.respond, { timeouts: { assertion: 2000 } })
    const verdict = await runPage(async ({ page: handle }) => {
      await handle.getByTestId('save-task').click()
      await expect(handle.getByTestId('saved-task')).toHaveText('Release checklist')
    })
    assert.equal(verdict.status, 'passed')
    assert.deepEqual(
      commands.map((command) => command.kind),
      ['click', 'observe', 'observe', 'observe', 'observe'],
    )
    const passed = events().find((event) => event.type === 'assertion.passed')
    assert.ok(passed?.type === 'assertion.passed')
    assert.equal(passed.attempts, 4)
    assert.equal(passed.timeoutMs, 2000)
    assert.ok(passed.durationMs >= 50 + 100 + 250 - 10, `backed off, took ${passed.durationMs} ms`)
    assert.deepEqual(passed.locator, { by: 'testId', value: 'saved-task' })
    assert.equal(passed.session, 'page')
  })

  test('report expected and actual text, attempts and the rule when time runs out', async () => {
    const page = savedAfter(Number.POSITIVE_INFINITY)
    const { events, runPage } = inProcessRun(file, page.respond, { timeouts: { assertion: 200 } })
    const verdict = await runPage(async ({ page: handle }) => {
      await expect(handle.getByTestId('saved-task')).toHaveText('Release checklist')
    })
    assert.equal(verdict.failure?.class, 'check_failed')
    const failed = events().find((event) => event.type === 'assertion.failed')
    assert.ok(failed?.type === 'assertion.failed')
    assert.deepEqual(failed.expected, truncateText('Release checklist'))
    assert.deepEqual(failed.actual, truncateText('Saving…'))
    assert.equal(failed.comparison, 'whole text, ends trimmed, each run of spaces or line breaks read as one space')
    assert.equal(failed.attempts, page.looks())
    assert.ok(failed.attempts >= 3)
    assert.ok(failed.durationMs >= 200)
    assert.equal(failed.failure, verdict.failure)
    assert.equal(verdict.failure?.details?.['timeoutMs'], 200)
  })

  test('the assertion budget is cut to the time the test has left', async () => {
    const page = savedAfter(Number.POSITIVE_INFINITY)
    const { events, runPage } = inProcessRun(file, page.respond, { timeouts: { assertion: 5000, test: 150 } })
    await runPage(async ({ page: handle }) => {
      await expect(handle.getByTestId('saved-task')).toBeVisible().catch(() => undefined)
      await expect(handle.getByTestId('saved-task')).toHaveText('x').catch(() => undefined)
    })
    const failed = events().find((event) => event.type === 'assertion.failed')
    assert.ok(failed?.type === 'assertion.failed')
    assert.ok((failed.timeoutMs ?? 0) <= 150, `budget ${failed.timeoutMs}`)
  })

  test('a failed look ends the assertion with that failure', async () => {
    const lost: Responder = () => ({ ok: false, failure: { class: 'session_lost', message: 'The browser is gone.' } })
    const { runPage } = inProcessRun(file, lost)
    const verdict = await runPage(async ({ page }) => {
      await expect(page.getByTestId('saved-task')).toBeVisible()
    })
    assert.equal(verdict.failure?.class, 'session_lost')
    assert.equal(verdict.failure?.location?.file, file)
  })

  test('a look that times out at the assertion deadline falls back to the last observation', async () => {
    let looks = 0
    const slow: Responder = () => {
      looks++
      if (looks === 1) return { ok: true, kind: 'observe', observation: observationOf([]) }
      return new Promise((resolve) => setTimeout(() => resolve({ ok: false, failure: { class: 'timeout', message: 'slow' } }), 150))
    }
    const { runPage } = inProcessRun(file, slow, { timeouts: { assertion: 100 } })
    const verdict = await runPage(async ({ page }) => {
      await expect(page.getByTestId('saved-task')).toBeVisible()
    })
    assert.equal(verdict.failure?.class, 'not_found')
  })

  test('an answer that is not an observation never makes it look forever', async () => {
    const wrong: Responder = () => ({ ok: true, kind: 'click' })
    const { runPage } = inProcessRun(file, wrong, { timeouts: { assertion: 120 } })
    const verdict = await runPage(async ({ page }) => {
      await expect(page.getByTestId('saved-task')).toBeVisible()
    })
    assert.equal(verdict.failure?.class, 'not_found')
  })
})

describe('value assertions', () => {
  test('toBe checks at once with Object.is and reports both values', async () => {
    const { events, commands, runPage } = inProcessRun(file, () => undefined)
    const verdict = await runPage(() => {
      expect(Number.NaN).toBe(Number.NaN)
      expect(0).toBe(-0)
    })
    assert.equal(commands.length, 0)
    assert.equal(verdict.assertionCount, 2)
    assert.equal(verdict.failure?.class, 'check_failed')
    assert.equal(verdict.failure?.message, 'Expected -0, received 0. toBe compares with Object.is.')
    const [passed, failed] = events()
    assert.ok(passed?.type === 'assertion.passed' && failed?.type === 'assertion.failed')
    assert.equal(passed.session, undefined)
    assert.deepEqual(failed.expected, truncateText('-0'))
    assert.equal(failed.comparison, 'Object.is')
  })

  test('a very long value is truncated in the event and shortened in the message', async () => {
    const { events, runPage } = inProcessRun(file, () => undefined)
    const long = 'x'.repeat(5000)
    const verdict = await runPage(() => {
      expect(long).toBe('y')
    })
    const failed = events().find((event) => event.type === 'assertion.failed')
    assert.ok(failed?.type === 'assertion.failed')
    assert.equal(failed.actual?.truncated, true)
    assert.equal(failed.actual?.length, 5002)
    assert.ok((verdict.failure?.message.length ?? 0) < 500)
  })

  test('expect outside a test is a usage error', () => {
    assert.throws(() => expect(1).toBe(1), { name: 'RetestError', message: 'expect() can only run inside a test.' })
  })
})
