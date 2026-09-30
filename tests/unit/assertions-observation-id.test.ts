import type { ChildEvent } from '../../src/protocol/events.ts'
import type { Responder } from '../support/api/in-process-run.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { expect } from '../../src/index.ts'
import { truncateText } from '../../src/protocol/failures.ts'
import { inProcessRun } from '../support/api/in-process-run.ts'
import { observationOf } from '../support/observation.ts'

const file = 'tests/unit/assertions-observation-id.test.ts'

type Assertion = Extract<ChildEvent, { type: 'assertion.passed' | 'assertion.failed' }>

/**
 * A page that serves each look as the parent does, with an id counted per attempt: the saved task reads
 * "Saving…" until `ready` looks have been taken. `withoutId` says which looks, counted from 1, come without one.
 */
function servedPage(ready: number, withoutId: (look: number) => boolean = () => false): Responder {
  let looks = 0
  return (command) => {
    if (command.kind !== 'observe') return { ok: true, kind: 'click' }
    looks++
    const text = looks > ready ? 'Release checklist' : 'Saving…'
    const observation = observationOf([{ text, visible: true }])
    return withoutId(looks) ? { ok: true, kind: 'observe', observation } : { ok: true, kind: 'observe', observation, observationId: `o${looks}` }
  }
}

function assertions(events: ChildEvent[]): Assertion[] {
  return events.flatMap((event) => (event.type === 'assertion.passed' || event.type === 'assertion.failed' ? [event] : []))
}

describe('the look a locator assertion rests on', () => {
  test('a pass names its last look and sends its matcher and arguments whole', async () => {
    const { runPage, events } = inProcessRun(file, servedPage(2))
    const verdict = await runPage(({ page }) => expect(page.getByTestId('saved-task')).toHaveText('Release checklist'))
    assert.equal(verdict.status, 'passed')
    const [passed] = assertions(events())
    assert.equal(passed?.type, 'assertion.passed')
    assert.equal(passed.observationId, 'o3')
    assert.deepEqual(passed.check, { matcher: 'toHaveText', text: 'Release checklist' })
    assert.equal('judgedBy' in passed, false, 'who judged a pass is the parent to say')
  })

  test('a failure names the last look its actual text came from', async () => {
    const { runPage, events } = inProcessRun(file, servedPage(Number.POSITIVE_INFINITY), { timeouts: { assertion: 120 } })
    const verdict = await runPage(({ page }) => expect(page.getByTestId('saved-task')).toHaveText('Release checklist'))
    assert.equal(verdict.failure?.class, 'check_failed')
    const [failed] = assertions(events())
    assert.equal(failed?.type, 'assertion.failed')
    assert.equal(failed.observationId, `o${failed.attempts}`)
    assert.deepEqual(failed.actual, truncateText('Saving…'))
    assert.deepEqual(failed.check, { matcher: 'toHaveText', text: 'Release checklist' })
  })

  test('a soft failure names its look and carries its check like any other', async () => {
    const { runPage, events } = inProcessRun(file, servedPage(Number.POSITIVE_INFINITY), { timeouts: { assertion: 60 } })
    await runPage(async ({ page }) => {
      await expect.soft(page.getByTestId('saved-task')).toBeVisible()
      await expect.soft(page.getByTestId('saved-task')).toHaveCount(2)
    })
    const found = assertions(events()).map((event) => [event.type, event.soft ?? false, event.observationId, event.check])
    assert.deepEqual(found, [
      ['assertion.passed', false, 'o1', { matcher: 'toBeVisible' }],
      ['assertion.failed', true, found[1]?.[2], { matcher: 'toHaveCount', count: 2 }],
    ])
    assert.match(String(found[1]?.[2]), /^o\d+$/)
  })

  test('each matcher sends its own record', async () => {
    const { runPage, events } = inProcessRun(file, servedPage(0), { timeouts: { assertion: 60 } })
    const texts = ['Release checklist']
    const verdict = await runPage(async ({ page }) => {
      const task = page.getByTestId('saved-task')
      await expect(task).toBeVisible()
      await expect(task).toHaveText('Release checklist')
      const listed = expect(task).toHaveText(texts)
      texts.push('changed after the call')
      await listed
      await expect(task).toHaveCount(1)
      await expect(task).toHaveValue('').catch(() => undefined)
      await expect(page.getByTestId('dialog')).toBeHidden().catch(() => undefined)
    })
    assert.equal(verdict.status, 'failed')
    assert.deepEqual(
      assertions(events()).map((event) => event.check),
      [
        { matcher: 'toBeVisible' },
        { matcher: 'toHaveText', text: 'Release checklist' },
        { matcher: 'toHaveText', texts: ['Release checklist'] },
        { matcher: 'toHaveCount', count: 1 },
        { matcher: 'toHaveValue', value: '' },
        { matcher: 'toBeHidden' },
      ],
    )
  })

  test('an expected text past the event limit is cut in expected and whole in check', async () => {
    const long = 'x'.repeat(5000)
    const { runPage, events } = inProcessRun(file, servedPage(0), { timeouts: { assertion: 60 } })
    await runPage(({ page }) => expect(page.getByTestId('saved-task')).toHaveText(long))
    const [failed] = assertions(events())
    assert.equal(failed?.expected?.truncated, true)
    assert.deepEqual(failed?.check, { matcher: 'toHaveText', text: long })
  })

  test('a look served without an id is named by none, even after one with an id', async () => {
    const { runPage, events } = inProcessRun(file, servedPage(1, (look) => look === 2))
    const verdict = await runPage(({ page }) => expect(page.getByTestId('saved-task')).toHaveText('Release checklist'))
    assert.equal(verdict.status, 'passed')
    const [passed] = assertions(events())
    assert.equal(passed?.attempts, 2)
    assert.equal(passed !== undefined && 'observationId' in passed, false)
    assert.deepEqual(passed?.check, { matcher: 'toHaveText', text: 'Release checklist' })
  })

  test('a look that failed after one that was served names the one that was served', async () => {
    let looks = 0
    const losing: Responder = () => {
      looks++
      if (looks > 1) return { ok: false, failure: { class: 'session_lost', message: 'The browser is gone.' } }
      return { ok: true, kind: 'observe', observation: observationOf([]), observationId: 'o1' }
    }
    const { runPage, events } = inProcessRun(file, losing)
    const verdict = await runPage(({ page }) => expect(page.getByTestId('saved-task')).toBeVisible())
    assert.equal(verdict.failure?.class, 'session_lost')
    const [failed] = assertions(events())
    assert.equal(failed?.observationId, 'o1')
    assert.equal(failed?.actual, null)
    assert.deepEqual(failed?.check, { matcher: 'toBeVisible' })
  })

  test('an assertion whose first look failed names none', async () => {
    const lost: Responder = () => ({ ok: false, failure: { class: 'session_lost', message: 'The browser is gone.' } })
    const { runPage, events } = inProcessRun(file, lost)
    await runPage(({ page }) => expect(page.getByTestId('saved-task')).toBeHidden())
    const [failed] = assertions(events())
    assert.equal(failed !== undefined && 'observationId' in failed, false)
    assert.deepEqual(failed?.check, { matcher: 'toBeHidden' })
  })

  test('beside a locator assertion, value assertions and expect.poll name no look and send no check', async () => {
    const { runPage, events } = inProcessRun(file, servedPage(0))
    const verdict = await runPage(async ({ page }) => {
      await expect(page.getByTestId('saved-task')).toBeVisible()
      expect(2).toBe(2)
      expect.soft('a').toBe('b')
      await expect.poll(() => 3).toBe(3)
    })
    assert.equal(verdict.status, 'failed')
    const found = assertions(events()).map((event) => [event.matcher, event.observationId, event.check, 'judgedBy' in event])
    assert.deepEqual(found, [
      ['toBeVisible', 'o1', { matcher: 'toBeVisible' }, false],
      ['toBe', undefined, undefined, false],
      ['toBe', undefined, undefined, false],
      ['toBe', undefined, undefined, false],
    ])
    for (const event of assertions(events()).slice(1)) assert.equal('observationId' in event || 'check' in event, false)
  })
})
