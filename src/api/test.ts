import type { TestBody } from './test-body.ts'
import { failure } from '../protocol/failures.ts'
import { currentScope, requireScope } from './context.ts'
import { collectionRoot, registerTest } from './registry.ts'
import { callerLocation } from './source-location.ts'

/** Options for one test. `timeout` is the test's own budget in milliseconds. */
export type TestOptions = { readonly timeout?: number }

export interface Test {
  /**
   * Declares a test. Call it at the top level of a `.retest.ts` file; names must be unique in the file.
   *
   * @example
   * test('saves a task', async ({ page }) => {
   *   await page.goto('/')
   *   await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
   * })
   */
  (name: string, ...rest: [body: TestBody] | [options: TestOptions, body: TestBody]): void
  /**
   * Runs part of a test as a named step, reported as its own event, and returns what the callback returns.
   *
   * @example const count = await test.step('Add two tasks', async () => 2)
   */
  step<T>(name: string, body: () => T | Promise<T>): Promise<T>
}

function declareTest(name: string, ...rest: [body: TestBody] | [options: TestOptions, body: TestBody]): void {
  const scope = currentScope()
  if (scope !== undefined) {
    const message = 'test() cannot run inside a test. Declare every test at the top level of its file.'
    throw scope.run.fail(failure('usage', message, scope.run.location()))
  }
  const root = collectionRoot()
  registerTest(name, rest, root === undefined ? undefined : callerLocation(root))
}

function step<T>(name: string, body: () => T | Promise<T>): Promise<T> {
  const { run, stepId } = requireScope('test.step()')
  const location = run.location()
  if (typeof name !== 'string' || typeof body !== 'function') {
    throw run.fail(failure('usage', 'test.step() takes a name and a function: test.step(name, fn).', location))
  }
  return run.step(name, body, location, stepId)
}

export const test: Test = Object.assign(declareTest, { step })
