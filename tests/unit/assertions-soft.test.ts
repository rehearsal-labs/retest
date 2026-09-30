import type { Responder } from '../support/api/in-process-run.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { expect } from '../../src/index.ts'
import { callLoosely } from '../support/api/call-loosely.ts'
import { inProcessRun, pageWithText } from '../support/api/in-process-run.ts'

const file = 'tests/unit/assertions-soft.test.ts'

describe('expect.soft', () => {
  test('a failure lets the test go on, and the test fails at the end with every one of them', async () => {
    const reached: string[] = []
    const { runPage, events } = inProcessRun(file, pageWithText('Draft'), { timeouts: { assertion: 60 } })
    const verdict = await runPage(async ({ page }) => {
      expect.soft(1).toBe(2)
      reached.push('after the value')
      await expect.soft(page.getByTestId('saved-task')).toHaveText('Saved')
      reached.push('after the locator')
      expect.soft('a').toBe('a')
    })
    assert.deepEqual(reached, ['after the value', 'after the locator'])
    assert.equal(verdict.status, 'failed')
    assert.equal(verdict.assertionCount, 3)
    assert.equal(verdict.failure?.class, 'check_failed')
    assert.equal(verdict.failure?.message, 'Expected 2, received 1. toBe compares with Object.is.')
    assert.match(String(verdict.failure?.details?.['also']), /^check_failed: getByTestId\('saved-task'\) has text "Draft", expected "Saved"\./)
    const reported = events().flatMap((event) =>
      event.type === 'assertion.passed' || event.type === 'assertion.failed' ? [[event.type, event.matcher, event.soft ?? false]] : [],
    )
    assert.deepEqual(reported, [
      ['assertion.failed', 'toBe', true],
      ['assertion.failed', 'toHaveText', true],
      ['assertion.passed', 'toBe', false],
    ])
  })

  test('soft checks that pass leave the test passing', async () => {
    const { runPage } = inProcessRun(file, pageWithText('Saved'))
    const verdict = await runPage(async ({ page }) => {
      expect.soft([1]).toEqual([1])
      await expect.soft(page.getByTestId('saved-task')).toBeVisible()
    })
    assert.equal(verdict.status, 'passed')
  })

  test('a later hard failure stops the test and sits after the soft ones', async () => {
    const { runPage } = inProcessRun(file, pageWithText(''))
    let reachedEnd = false
    const verdict = await runPage(() => {
      expect.soft('a').toBe('b')
      expect(1).toBe(2)
      reachedEnd = true
    })
    assert.equal(reachedEnd, false)
    assert.equal(verdict.failure?.message, "Expected 'b', received 'a'. toBe compares with Object.is.")
    assert.equal(verdict.failure?.details?.['also'], 'check_failed: Expected 2, received 1. toBe compares with Object.is.')
  })

  test('only the check is softened: a page that could not be read still stops the test', async () => {
    const lost: Responder = () => ({ ok: false, failure: { class: 'session_lost', message: 'The browser is gone.' } })
    const { runPage, events } = inProcessRun(file, lost)
    let reachedEnd = false
    const verdict = await runPage(async ({ page }) => {
      await expect.soft(page.getByTestId('saved-task')).toBeVisible()
      reachedEnd = true
    })
    assert.equal(reachedEnd, false)
    assert.equal(verdict.failure?.class, 'session_lost')
    const failed = events().find((event) => event.type === 'assertion.failed')
    assert.equal(failed?.type === 'assertion.failed' ? failed.soft : 'missing', undefined)
  })

  test('misuse is not softened', async () => {
    const { runPage } = inProcessRun(file, pageWithText(''))
    let reachedEnd = false
    const verdict = await runPage(() => {
      callLoosely(expect.soft(3), 'toHaveText', ['3'])
      reachedEnd = true
    })
    assert.equal(reachedEnd, false)
    assert.equal(verdict.failure?.class, 'usage')
    assert.equal(verdict.failure?.message, 'toHaveText is for locators. Use toBe on a value.')
  })

  test('outside a test it is a usage error', () => {
    assert.throws(() => expect.soft(1).toBe(1), { name: 'RetestError', message: 'expect.soft() can only run inside a test.' })
  })
})
