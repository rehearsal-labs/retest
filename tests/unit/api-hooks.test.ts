import type { AppPage } from '../../src/api/app-page.ts'
import type { RuntimeBody } from '../../src/api/test-body.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { expect } from '../../src/index.ts'
import { appOf, hookAt, inProcessRun, pageWithText } from '../support/api/in-process-run.ts'

const file = 'tests/unit/api-hooks.test.ts'
const page = pageWithText('Release checklist')

/** A function that notes its name when it runs, and then does `then`. */
function noting(order: string[], name: string, then: (page: AppPage) => unknown = () => undefined): RuntimeBody {
  return (context) => {
    order.push(name)
    return then(appOf(context, 'page'))
  }
}

describe('hooks', () => {
  test('run around the test in the order given, each as a step marked with its kind', async () => {
    const order: string[] = []
    const { runTest, events, messages } = inProcessRun(file, page)
    const verdict = await runTest({
      beforeEach: [hookAt(file, 3, noting(order, 'outer before', (p) => p.goto('/outer'))), hookAt(file, 7, noting(order, 'inner before'))],
      body: noting(order, 'test', async (p) => {
        await p.goto('/test')
        await expect(p.getByTestId('saved-task')).toBeVisible()
      }),
      afterEach: [hookAt(file, 9, noting(order, 'inner after')), hookAt(file, 12, noting(order, 'outer after', (p) => p.goto('/after')))],
    })
    assert.equal(verdict.status, 'passed')
    assert.deepEqual(order, ['outer before', 'inner before', 'test', 'inner after', 'outer after'])
    const started = events().flatMap((event) => (event.type === 'step.started' ? [[event.stepId, event.name, event.hook, event.location?.line]] : []))
    assert.deepEqual(started, [
      ['step-1', 'beforeEach', 'beforeEach', 3],
      ['step-2', 'beforeEach', 'beforeEach', 7],
      ['step-3', 'afterEach', 'afterEach', 9],
      ['step-4', 'afterEach', 'afterEach', 12],
    ])
    const gotos = messages.flatMap((message) => (message.type === 'command' && message.command.kind === 'goto' ? [[message.command.url, message.stepId ?? null]] : []))
    assert.deepEqual(gotos, [
      ['/outer', 'step-1'],
      ['/test', null],
      ['/after', 'step-4'],
    ])
    const finished = events().flatMap((event) => (event.type === 'step.finished' ? [event.status] : []))
    assert.deepEqual(finished, ['passed', 'passed', 'passed', 'passed'])
  })

  test('afterEach runs after the test fails, and the test keeps its own failure first', async () => {
    const order: string[] = []
    const { runTest, events } = inProcessRun(file, page)
    const verdict = await runTest({
      body: noting(order, 'test', () => {
        expect(1).toBe(2)
      }),
      afterEach: [
        hookAt(file, 20, noting(order, 'first after', () => {
          throw new Error('cleanup broke')
        })),
        hookAt(file, 24, noting(order, 'second after')),
      ],
    })
    assert.deepEqual(order, ['test', 'first after', 'second after'], 'a failing afterEach does not stop the next')
    assert.equal(verdict.failure?.class, 'check_failed')
    assert.equal(verdict.failure?.message, 'Expected 2, received 1. toBe compares with Object.is.')
    assert.equal(verdict.failure?.details?.['also'], 'test_error: Error: cleanup broke')
    const failedStep = events().find((event) => event.type === 'step.finished' && event.status === 'failed')
    assert.ok(failedStep?.type === 'step.finished')
    assert.equal(failedStep.stepId, 'step-1')
    assert.equal(failedStep.failure?.message, 'Error: cleanup broke')
  })

  test('a throwing beforeEach skips the later ones and the test, and every afterEach still runs', async () => {
    const order: string[] = []
    const { runTest } = inProcessRun(file, page)
    const verdict = await runTest({
      beforeEach: [
        hookAt(file, 1, noting(order, 'signs in', () => {
          throw new TypeError('no account')
        })),
        hookAt(file, 2, noting(order, 'opens tasks')),
      ],
      body: noting(order, 'test'),
      afterEach: [hookAt(file, 3, noting(order, 'signs out')), hookAt(file, 4, noting(order, 'closes'))],
    })
    assert.deepEqual(order, ['signs in', 'signs out', 'closes'])
    assert.equal(verdict.failure?.class, 'test_error')
    assert.equal(verdict.failure?.message, 'TypeError: no account')
  })

  test('a failure a beforeEach catches still fails the test, which runs', async () => {
    const order: string[] = []
    const { runTest } = inProcessRun(file, page)
    const verdict = await runTest({
      beforeEach: [
        hookAt(file, 1, () => {
          try {
            expect('a').toBe('b')
          } catch {
            // Swallowed on purpose.
          }
        }),
      ],
      body: noting(order, 'test', () => expect(1).toBe(1)),
    })
    assert.deepEqual(order, ['test'])
    assert.equal(verdict.failure?.class, 'check_failed')
    assert.equal(verdict.assertionCount, 2, 'assertions in hooks count for the test')
  })

  test('an afterEach that fails fails a test that passed', async () => {
    const { runTest } = inProcessRun(file, page)
    const verdict = await runTest({
      body: () => expect(1).toBe(1),
      afterEach: [hookAt(file, 5, (context) => expect(appOf(context, 'page').getByTestId('saved-task')).toHaveText('Draft'))],
    })
    assert.equal(verdict.failure?.class, 'check_failed')
    assert.match(verdict.failure?.message ?? '', /has text "Release checklist", expected "Draft"/)
  })

  test('hooks and the test receive the same context', async () => {
    const seen: unknown[] = []
    const { runTest } = inProcessRun(file, page)
    const verdict = await runTest({
      beforeEach: [hookAt(file, 1, (context) => void seen.push(context))],
      body: (context) => {
        seen.push(context)
        expect(1).toBe(1)
      },
      afterEach: [hookAt(file, 2, (context) => void seen.push(context))],
    })
    assert.equal(verdict.status, 'passed')
    assert.equal(new Set(seen).size, 1)
  })

  test('work a hook leaves running fails the test and names the hook', async () => {
    const { runTest } = inProcessRun(file, () => undefined)
    const verdict = await runTest({
      beforeEach: [hookAt(file, 1, (context) => void appOf(context, 'page').goto('/').catch(() => undefined))],
      body: () => expect(1).toBe(1),
    })
    assert.equal(verdict.failure?.class, 'not_awaited')
    assert.match(verdict.failure?.message ?? '', /was still running when its beforeEach hook returned\. Add await before it\.$/)
  })

  test('once the parent aborts, no hook runs after the one in flight', async () => {
    const order: string[] = []
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const left = Promise.withResolvers<void>()
    const waits = async (): Promise<void> => {
      entered.resolve()
      await release.promise
      left.resolve()
    }
    const { run, runTest, events } = inProcessRun(file, page)
    const verdict = runTest({
      beforeEach: [hookAt(file, 1, noting(order, 'waits', waits))],
      body: noting(order, 'test'),
      afterEach: [hookAt(file, 2, noting(order, 'after'))],
    })
    await entered.promise
    run.abort()
    const result = await verdict
    assert.equal(result.status, 'failed')
    assert.equal(result.failure, undefined, 'the parent supplies the reason it stopped the test')
    // The hook in flight returns only now, after the verdict, and nothing may follow it.
    release.resolve()
    await left.promise
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(order, ['waits'])
    assert.equal(events().filter((event) => event.type === 'step.finished').length, 0)
  })
})
