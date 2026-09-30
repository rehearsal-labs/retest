import assert from 'node:assert/strict'
import { describe, test as check } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { RetestError } from '../../src/api/failure.ts'
import { expect, test } from '../../src/index.ts'
import { inProcessRun, pageWithText } from '../support/api/in-process-run.ts'

const file = 'tests/unit/api-test-run.test.ts'
const visible = pageWithText('Release checklist')

describe('TestRun', () => {
  check('passes an awaited action and assertion, sending one command at a time', async () => {
    const { commands, runPage } = inProcessRun(file, visible)
    const verdict = await runPage(async ({ page }) => {
      await page.goto('/')
      await page.getByTestId('save-task').click()
      await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
    })
    assert.equal(verdict.status, 'passed')
    assert.equal(verdict.assertionCount, 1)
    assert.deepEqual(
      commands.map((command) => command.kind),
      ['goto', 'click', 'observe'],
    )
  })

  check('an action sent while another runs fails at once and names both lines', async () => {
    const { commands, runPage } = inProcessRun(file, visible)
    let reachedEnd = false
    const verdict = await runPage(async ({ page }) => {
      const saving = page.getByTestId('save-task').click()
      await page.getByTestId('task-title').fill('Two')
      await saving
      reachedEnd = true
    })
    assert.equal(verdict.failure?.class, 'concurrent_commands')
    assert.equal(commands.length, 1, 'the second command never left the child')
    assert.equal(reachedEnd, false)
    const line = verdict.failure?.location?.line ?? 0
    assert.equal(verdict.failure?.location?.file, file)
    assert.equal(
      verdict.failure?.message,
      `Line ${line - 1} (getByTestId('save-task').click()) was still running when line ${line} (getByTestId('task-title').fill()) sent the next command to page. Retest sends one command at a time to each app. Add await on line ${line - 1}.`,
    )
    assert.deepEqual(verdict.failure?.details, {
      running: `${file}:${line - 1}`,
      next: `${file}:${line}`,
      also: `not_awaited: getByTestId('save-task').click() on line ${line - 1} was never awaited. Add await before it.`,
    })
  })

  check('an assertion cannot start while an action runs, but assertions may overlap', async () => {
    const { runPage } = inProcessRun(file, visible)
    const verdict = await runPage(async ({ page }) => {
      await Promise.all([expect(page.getByTestId('a')).toBeVisible(), expect(page.getByTestId('b')).toBeVisible()])
      const saving = page.getByTestId('save-task').click()
      await expect(page.getByTestId('saved-task')).toBeVisible()
      await saving
    })
    assert.equal(verdict.failure?.class, 'concurrent_commands')
    assert.match(verdict.failure?.message ?? '', /expect\(getByTestId\('saved-task'\)\)\.toBeVisible\(\)/)
    assert.equal(verdict.assertionCount, 2)
  })

  check('an action cannot start while an assertion is still looking', async () => {
    const { runPage } = inProcessRun(file, pageWithText('Saving…'))
    const verdict = await runPage(async ({ page }) => {
      const looking = expect(page.getByTestId('saved-task')).toHaveText('Saved')
      void looking.then(undefined, () => undefined)
      await sleep(20)
      await page.getByTestId('save-task').click()
    })
    assert.equal(verdict.failure?.class, 'concurrent_commands')
  })

  check('an assertion never awaited never looks at the page, and fails the test', async () => {
    const { commands, runPage } = inProcessRun(file, visible)
    const verdict = await runPage(async ({ page }) => {
      void expect(page.getByTestId('saved-task')).toBeVisible()
      expect(1).toBe(1)
    })
    assert.deepEqual(commands, [])
    assert.equal(verdict.failure?.class, 'not_awaited')
    assert.match(verdict.failure?.message ?? '', /never ran because nothing awaited it/)
    assert.equal(verdict.assertionCount, 1)
  })

  check('work still running when the body returns fails the test', async () => {
    const { runPage } = inProcessRun(file, () => undefined)
    const verdict = await runPage(async ({ page }) => {
      page.getByTestId('save-task').click().catch(() => undefined)
      expect(1).toBe(1)
    })
    assert.equal(verdict.failure?.class, 'not_awaited')
    assert.match(verdict.failure?.message ?? '', /was still running when the test returned/)
  })

  check('a failure the test catches still fails it', async () => {
    const { runPage } = inProcessRun(file, pageWithText('Draft'), { timeouts: { assertion: 60 } })
    const verdict = await runPage(async ({ page }) => {
      await expect(page.getByTestId('saved-task')).toHaveText('Release checklist').catch(() => undefined)
      try {
        expect('a').toBe('b')
      } catch {
        // Swallowed on purpose.
      }
    })
    assert.equal(verdict.failure?.class, 'check_failed')
    assert.match(verdict.failure?.message ?? '', /has text "Draft", expected "Release checklist"/)
    assert.match(String(verdict.failure?.details?.['also']), /^check_failed: Expected 'b', received 'a'/)
    assert.equal(verdict.assertionCount, 2)
  })

  check('a test with no assertion fails with no_assertions at its own location', async () => {
    const { runPage } = inProcessRun(file, visible)
    const verdict = await runPage(async ({ page }) => {
      await page.getByTestId('save-task').click()
    })
    assert.equal(verdict.failure?.class, 'no_assertions')
    assert.deepEqual(verdict.failure?.location, { file, line: 1, column: 1 })
  })

  check('errors thrown by test code become test_error with their location, and a recorded one is not repeated', async () => {
    const thrown = inProcessRun(file, visible)
    const plain = await thrown.runPage(() => {
      throw new TypeError('bad fixture')
    })
    assert.equal(plain.failure?.class, 'test_error')
    assert.equal(plain.failure?.message, 'TypeError: bad fixture')
    assert.equal(plain.failure?.location?.file, file)

    const value = await inProcessRun(file, visible).runPage(() => {
      throw 'a string'
    })
    assert.equal(value.failure?.message, "The test threw 'a string'.")

    const recorded = await inProcessRun(file, visible).runPage(() => {
      expect(2).toBe(3)
    })
    assert.equal(recorded.failure?.class, 'check_failed')
    assert.equal(recorded.failure?.details?.['also'], undefined)
  })

  check('test.step nests, reports each step, and returns what its callback returns', async () => {
    const { events, runPage } = inProcessRun(file, visible)
    let value = 0
    const verdict = await runPage(async ({ page }) => {
      value = await test.step('outer', () =>
        test.step('inner', async () => {
          await expect(page.getByTestId('saved-task')).toBeVisible()
          return 42
        }),
      )
      expect(value).toBe(42)
    })
    assert.equal(verdict.status, 'passed')
    assert.equal(value, 42)
    const steps = events().filter((event) => event.type === 'step.started' || event.type === 'step.finished')
    assert.deepEqual(
      steps.map((event) => [event.type, event.stepId, event.type === 'step.started' ? (event.parentStepId ?? null) : event.status]),
      [
        ['step.started', 'step-1', null],
        ['step.started', 'step-2', 'step-1'],
        ['step.finished', 'step-2', 'passed'],
        ['step.finished', 'step-1', 'passed'],
      ],
    )
    const assertion = events().find((event) => event.type === 'assertion.passed' && event.matcher === 'toBeVisible')
    assert.equal(assertion?.stepId, 'step-2')
  })

  check('each command names the step the test code was in when it sent it', async () => {
    const { messages, runPage } = inProcessRun(file, visible)
    const verdict = await runPage(async ({ page }) => {
      await page.goto('/')
      await test.step('outer', async () => {
        await page.getByTestId('task-title').fill('Release checklist')
        await test.step('inner', () => expect(page.getByTestId('saved-task')).toBeVisible())
        await page.getByTestId('save-task').click()
      })
      await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
    })
    assert.equal(verdict.status, 'passed')
    const commands = messages.flatMap((message) => (message.type === 'command' ? [[message.command.kind, message.stepId ?? null]] : []))
    assert.deepEqual(commands, [
      ['goto', null],
      ['fill', 'step-1'],
      ['observe', 'step-2'],
      ['click', 'step-1'],
      ['observe', null],
    ])
  })

  check('a failing step reports its failure and rejects with the original error', async () => {
    const { events, runPage } = inProcessRun(file, visible)
    const verdict = await runPage(async () => {
      await test.step('breaks', () => {
        throw new Error('inside the step')
      })
    })
    assert.equal(verdict.failure?.message, 'Error: inside the step')
    const finished = events().find((event) => event.type === 'step.finished')
    assert.equal(finished?.type === 'step.finished' ? finished.failure?.message : undefined, 'Error: inside the step')
  })

  check('after an abort the body is left behind and later commands are refused', async () => {
    const { run, commands, runPage } = inProcessRun(file, visible)
    const resume = Promise.withResolvers<void>()
    const answered = Promise.withResolvers<unknown>()
    const verdict = runPage(async ({ page }) => {
      await resume.promise
      await page.goto('/').then(
        () => answered.resolve('the command was sent'),
        (error: unknown) => answered.resolve(error),
      )
      await new Promise(() => {})
    })
    run.abort()
    const result = await verdict
    assert.equal(result.status, 'failed')
    assert.equal(result.failure, undefined, 'the parent supplies the reason it stopped the test')
    // The body carries on only after the verdict, as code the parent no longer waits for.
    resume.resolve()
    const later = await answered.promise
    assert.ok(later instanceof RetestError, String(later))
    assert.equal(later.failure.class, 'interrupted')
    assert.deepEqual(commands, [])
  })

  check('an answer to a command this run never sent is ignored', async () => {
    const { run, commands, runPage } = inProcessRun(file, visible)
    run.resolveCommand(999, { ok: false, failure: { class: 'timeout', message: 'Not for this run.' } })
    const verdict = await runPage(async ({ page }) => {
      await expect(page.getByTestId('saved-task')).toBeVisible()
    })
    assert.equal(verdict.status, 'passed')
    assert.equal(commands.length, 1)
  })

  check('misuse from JavaScript fails with a usage error that names the fix', async () => {
    const { runPage } = inProcessRun(file, visible)
    const verdict = await runPage(async ({ page }) => {
      const locator: unknown = page.getByTestId('saved-task')
      expect(locator).toBe(undefined)
    })
    assert.equal(verdict.failure?.class, 'usage')
    assert.equal(verdict.failure?.message, 'toBe is for values. Use toHaveText or toBeVisible on a locator.')
  })
})
