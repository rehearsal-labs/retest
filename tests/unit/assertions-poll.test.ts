import assert from 'node:assert/strict'
import { describe, test as check } from 'node:test'
import { expect, test } from '../../src/index.ts'
import { callLoosely } from '../support/api/call-loosely.ts'
import { inProcessRun, pageWithText } from '../support/api/in-process-run.ts'
import { manualTime } from '../support/manual-time.ts'

const file = 'tests/unit/assertions-poll.test.ts'
const page = pageWithText('Saved')

/** A read that returns each value in turn, then keeps returning the last. */
function reading<T>(first: T, ...later: T[]): { read: () => T; reads: () => number } {
  const values = [first, ...later]
  let reads = 0
  return {
    read: () => values[Math.min(reads++, values.length - 1)] ?? first,
    reads: () => reads,
  }
}

describe('expect.poll', () => {
  check('reads again until the value passes, and reports one assertion with its looks', async () => {
    const status = reading(404, 404, 200)
    const { runPage, events, commands } = inProcessRun(file, page)
    const verdict = await runPage(() => expect.poll(async () => status.read()).toBe(200))
    assert.equal(verdict.status, 'passed')
    assert.equal(verdict.assertionCount, 1)
    assert.equal(status.reads(), 3)
    assert.deepEqual(commands, [], 'a poll never touches a page')
    const passed = events().find((event) => event.type === 'assertion.passed')
    assert.ok(passed?.type === 'assertion.passed')
    assert.equal(passed.matcher, 'toBe')
    assert.equal(passed.attempts, 3)
    assert.equal(passed.session, undefined)
    assert.equal(passed.actual?.text, '200')
  })

  // The run's clock moves only from wait to wait, so every look lands at a known time.
  check('fails when its time runs out, with the last value, its looks and its budget', async () => {
    const time = manualTime()
    const looks: number[] = []
    const { runPage, events } = inProcessRun(file, page, { time })
    const read = () => {
      looks.push(time.now())
      return 'Saving…'
    }
    const verdict = await time.runUntil(runPage(() => expect.poll(read, { timeout: 150 }).toEqual('Saved')))
    assert.equal(verdict.failure?.class, 'check_failed')
    assert.equal(verdict.failure?.message, "Expected 'Saved', received 'Saving…'. Looked 3 times in 150 ms.")
    assert.deepEqual(looks, [0, 50, 150], 'the last look is at the deadline')
    const failed = events().find((event) => event.type === 'assertion.failed')
    assert.ok(failed?.type === 'assertion.failed')
    assert.deepEqual([failed.timeoutMs, failed.attempts, failed.durationMs], [150, 3, 150])
    assert.equal(failed.failure.details?.['timeoutMs'], 150)
  })

  check('waits the given intervals between looks, the last one repeating', async () => {
    const time = manualTime()
    const looks: number[] = []
    const { runPage } = inProcessRun(file, page, { time })
    const read = () => looks.push(time.now())
    const verdict = await time.runUntil(runPage(() => expect.poll(read, { intervals: [10, 60] }).toBe(4)))
    assert.equal(verdict.status, 'passed')
    assert.deepEqual(looks, [0, 10, 70, 130])
  })

  check('never repeats an action: one inside its function fails the test and is never sent', async () => {
    const { runPage, commands } = inProcessRun(file, page)
    const verdict = await runPage(({ page: handle }) =>
      expect
        .poll(async () => {
          await handle.getByTestId('save-task').click()
          return 1
        })
        .toBe(1),
    )
    assert.deepEqual(commands, [])
    assert.equal(verdict.failure?.class, 'usage')
    assert.match(
      verdict.failure?.message ?? '',
      /^expect\.poll\(\) calls its function again on every look, so the function may only read\. getByTestId\('save-task'\)\.click\(\) on line \d+ would run again each time\.$/,
    )
    assert.equal(verdict.failure?.details?.['also'], undefined, 'the failure is reported once')
  })

  check('a step inside its function may only read as well', async () => {
    const { runPage, commands } = inProcessRun(file, page)
    const verdict = await runPage(({ page: handle }) =>
      expect.poll(() => test.step('Save again', () => handle.getByTestId('save-task').click().then(() => 1))).toBe(1),
    )
    assert.deepEqual(commands, [])
    assert.equal(verdict.failure?.class, 'usage')
  })

  check('its function may read the page through an assertion', async () => {
    const { runPage, commands } = inProcessRun(file, page)
    const verdict = await runPage(({ page: handle }) =>
      expect
        .poll(async () => {
          await expect(handle.getByTestId('saved-task')).toBeVisible()
          return 'seen'
        })
        .toBe('seen'),
    )
    assert.equal(verdict.status, 'passed')
    assert.deepEqual(commands.map((command) => command.kind), ['observe'])
  })

  check('an error from its function is a look that did not pass; the last one fails the test', async () => {
    let reads = 0
    const flaky = await inProcessRun(file, page).runPage(() =>
      expect
        .poll(() => {
          reads++
          if (reads < 3) throw new Error('not ready')
          return 'ready'
        })
        .toBe('ready'),
    )
    assert.equal(flaky.status, 'passed')
    const broken = await inProcessRun(file, page).runPage(() =>
      expect
        .poll(
          (): number => {
            throw new TypeError('no such task')
          },
          { timeout: 60 },
        )
        .toBe(1),
    )
    assert.equal(broken.failure?.class, 'test_error')
    assert.match(broken.failure?.message ?? '', /^The function given to expect\.poll\(\) threw on its last look: TypeError: no such task\. Looked \d+ times in 60 ms\.$/)
  })

  check('a function still running when its time runs out fails with timeout', async () => {
    const { runPage } = inProcessRun(file, page)
    const verdict = await runPage(() => expect.poll(() => new Promise<number>(() => {}), { timeout: 50 }).toBe(1))
    assert.equal(verdict.failure?.class, 'timeout')
    assert.equal(verdict.failure?.message, 'The function given to expect.poll() was still running when its 50 ms ran out.')
  })

  check('looks only when awaited', async () => {
    const status = reading(200)
    const { runPage } = inProcessRun(file, page)
    const verdict = await runPage(() => {
      void expect.poll(status.read).toBe(200)
      expect(1).toBe(1)
    })
    assert.equal(status.reads(), 0)
    assert.equal(verdict.failure?.class, 'not_awaited')
    assert.match(verdict.failure?.message ?? '', /^expect\.poll\(\)\.toBe\(\) on line \d+ never ran because nothing awaited it\./)
  })

  check('offers toContain and toMatch, re-read each look', async () => {
    const tags = reading<readonly string[]>([], ['slow'], ['slow', 'smoke'])
    const text = reading('Saving', 'Saved')
    const { runPage } = inProcessRun(file, page)
    const verdict = await runPage(async () => {
      await expect.poll(tags.read).toContain('smoke')
      await expect.poll(text.read).toMatch(/^saved$/i)
    })
    assert.equal(verdict.status, 'passed')
    assert.equal(tags.reads(), 3)
  })

  const misuses: [string, unknown[], string][] = [
    ['a value instead of a function', [3], 'expect.poll() takes a function that reads a value, received 3.'],
    ['an unknown option', [() => 1, { retries: 2 }], 'expect.poll() options take timeout and intervals, such as { timeout: 10000, intervals: [100, 500] }, received { retries: 2 }.'],
    ['a timeout of zero', [() => 1, { timeout: 0 }], 'expect.poll() takes timeout as a whole number of milliseconds from 1 to 2147483647, received 0.'],
    ['no intervals', [() => 1, { intervals: [] }], 'expect.poll() takes intervals as a list of waits in whole milliseconds, such as [100, 500], received [].'],
  ]
  for (const [what, args, message] of misuses) {
    check(`${what} is a usage failure`, async () => {
      const verdict = await inProcessRun(file, page).runPage(() => callLoosely(expect, 'poll', args))
      assert.equal(verdict.failure?.class, 'usage')
      assert.equal(verdict.failure?.message, message)
    })
  }
})
