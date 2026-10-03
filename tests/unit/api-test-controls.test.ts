import type { ChildMessage } from '../../src/protocol/messages.ts'
import assert from 'node:assert/strict'
import { describe, test as check } from 'node:test'
import { readCallOptions } from '../../src/api/call-options.ts'
import { expect } from '../../src/index.ts'
import { collectionFailure, collectSource } from '../support/api/collect-source.ts'
import { inProcessRun, pageWithText } from '../support/api/in-process-run.ts'

type Command = Extract<ChildMessage, { type: 'command' }>

function commandsOf(messages: readonly ChildMessage[]): Command[] {
  return messages.flatMap((message) => (message.type === 'command' ? [message] : []))
}

describe('test.skip and test.only', () => {
  check('mark the tests they declare, and a plain test carries neither mark', async () => {
    const source = await collectSource(`test('plain', () => {})
test.skip('skipped', { tags: ['slow'] }, () => {})
test.only('focused', () => {})`)
    assert.ok(source.collected.ok)
    const [plain, skipped, focused] = source.collected.tests
    assert.deepEqual([plain?.skip, plain?.only], [undefined, undefined])
    assert.deepEqual([skipped?.name, skipped?.skip, skipped?.only, skipped?.tags], ['skipped', true, undefined, ['slow']])
    assert.deepEqual([focused?.name, focused?.only, focused?.skip], ['focused', true, undefined])
  })

  check('test.describe.skip skips every test inside, however deep, and test.describe.only marks its block', async () => {
    const source = await collectSource(`test.describe.skip('archive', (test) => {
  test('archives', () => {})
  test.describe('bulk', (test) => {
    test.only('archives all', () => {})
  })
})
test.describe.only('restore', (test) => {
  test('restores', () => {})
})
test('outside', () => {})`)
    assert.ok(source.collected.ok)
    const [archives, all, restores, outside] = source.collected.tests
    assert.equal(archives?.skip, true)
    assert.deepEqual([all?.skip, all?.only], [true, true], 'a test marked only inside a skipped block is still skipped')
    assert.deepEqual(all?.describes?.map(({ name, only }) => [name, only]), [['archive', undefined], ['bulk', undefined]])
    assert.deepEqual(restores?.describes?.map(({ name, only, location }) => [name, only, location.line]), [['restore', true, 8]])
    assert.deepEqual([restores?.skip, restores?.only], [undefined, undefined], 'the block carries the mark, not the test')
    assert.deepEqual([outside?.skip, outside?.describes], [undefined, undefined])
  })

  check('name themselves in a misuse, as test() does', async () => {
    const failure = collectionFailure(await collectSource(`test.skip('no function')`))
    assert.equal(failure.class, 'usage')
    assert.equal(failure.message, 'test.skip("no function") takes a name, optional options and a function: test.skip(name, options?, fn).')
    const block = collectionFailure(await collectSource(`test.describe.only('waits', async () => {})`))
    assert.equal(block.message, 'test.describe.only() runs its function once, while the file loads, and does not wait for it. Remove async from the function on line 2.')
  })
})

describe('locks', () => {
  check('a test holds its own locks and its blocks\', each once, the block\'s first', async () => {
    const source = await collectSource(`test.describe('mail', { locks: ['inbox'] }, (test) => {
  test('reads the inbox', { locks: ['account', 'inbox', 'account'] }, () => {})
  test('only the block', () => {})
})
test('none', () => {})`)
    assert.ok(source.collected.ok)
    const [both, block, none] = source.collected.tests
    assert.deepEqual(both?.locks, ['inbox', 'account'])
    assert.deepEqual(block?.locks, ['inbox'])
    assert.equal(none?.locks, undefined)
  })

  check('locks that are not a list of names fail collection with a usage failure', async () => {
    const failure = collectionFailure(await collectSource(`test('one name', { locks: 'inbox' }, () => {})`))
    assert.equal(failure.class, 'usage')
    assert.equal(failure.message, "locks lists names, such as locks: ['inbox'], received 'inbox'.")
    const setup = collectionFailure(await collectSource(`test.setup('signed-in', { locks: ['inbox'] }, () => {})`))
    assert.equal(setup.message, 'Unknown test.setup option "locks". test.setup() options are apps and timeout.')
  })
})

describe('per-call timeouts', () => {
  check('readCallOptions takes a whole number of milliseconds and nothing else', () => {
    assert.deepEqual(readCallOptions('click', undefined), { ok: true })
    assert.deepEqual(readCallOptions('click', {}), { ok: true })
    assert.deepEqual(readCallOptions('click', { timeout: undefined }), { ok: true })
    assert.deepEqual(readCallOptions('goto', { timeout: 1500 }), { ok: true, timeoutMs: 1500 })
    assert.deepEqual(readCallOptions('click', { force: true }), { ok: false, problem: 'Unknown click() option "force". Its only option is timeout.' })
    assert.deepEqual(readCallOptions('fill', { timeout: 0 }), {
      ok: false,
      problem: 'The timeout option of fill() must be a whole number of milliseconds from 1 to 2147483647, received 0.',
    })
    assert.deepEqual(readCallOptions('press', { timeout: 1.5 }).ok, false)
    assert.deepEqual(readCallOptions('check', 'fast'), { ok: false, problem: "check() takes options such as { timeout: 2000 }, in milliseconds, received 'fast'." })
  })

  check('a shorter timeout replaces the action budget for that call, and the command says the call set it', async () => {
    const { runPage, messages } = inProcessRun('a.retest.ts', pageWithText('Saved'), { timeouts: { action: 500, navigation: 1000 } })
    const verdict = await runPage(async ({ page }) => {
      await page.goto('/', { timeout: 400 })
      await page.getByTestId('save-task').click({ timeout: 120 })
      await page.getByTestId('task-title').fill('Release checklist')
      expect(1).toBe(1)
    })
    assert.equal(verdict.status, 'passed', JSON.stringify(verdict.failure))
    assert.deepEqual(
      commandsOf(messages).map(({ command, timeoutMs, callTimeoutMs }) => [command.kind, timeoutMs, callTimeoutMs]),
      [
        ['goto', 400, 400],
        ['click', 120, 120],
        ['fill', 500, undefined],
      ],
    )
  })

  check('a longer timeout never lengthens the budget the run set', async () => {
    const { runPage, messages } = inProcessRun('a.retest.ts', pageWithText('Saved'), { timeouts: { action: 500 } })
    const verdict = await runPage(async ({ page }) => {
      await page.getByTestId('save-task').click({ timeout: 60_000 })
      expect(1).toBe(1)
    })
    assert.equal(verdict.status, 'passed')
    assert.deepEqual(commandsOf(messages).map(({ timeoutMs, callTimeoutMs }) => [timeoutMs, callTimeoutMs]), [[500, 60_000]])
  })

  check('an option the action does not take fails the test as a usage failure and sends nothing', async () => {
    const { runPage, messages } = inProcessRun('a.retest.ts', pageWithText('Saved'))
    const verdict = await runPage(async ({ page }) => {
      await page.getByTestId('save-task').click({ force: true })
    })
    assert.equal(verdict.status, 'failed')
    assert.equal(verdict.failure?.class, 'usage')
    assert.equal(verdict.failure?.message, 'Unknown click() option "force". Its only option is timeout.')
    assert.equal(commandsOf(messages).length, 0)
  })
})
