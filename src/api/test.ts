import type { AppName, IsRegistered, RetestTypeError, StateName, Unregistered } from '../config/register.ts'
import type { ContextFor } from './apps.ts'
import type { DescribeOptions, SetupOptions, TestOptions } from './test-options.ts'
import { failure } from '../protocol/failures.ts'
import { requireScope } from './context.ts'
import { declareDescribe, declareHook, declareRows, declareSetup, declareTest } from './declare.ts'

type Body<Context> = (context: Context) => void | Promise<void>
type RowBody<Context, Row> = (context: Context, row: Row) => void | Promise<void>
type DescribeBody<Names extends AppName> = (test: Test<Names>) => void

// Written out so a setup declared before registering prints the message itself, not the alias `Unregistered`.
type SetupState = IsRegistered extends true ? StateName : Unregistered extends RetestTypeError<infer Message> ? RetestTypeError<Message> : never

// Each declaration is one signature, `(name, options, fn)` or `(name, fn)`: the function takes the options' place
// when there are none. A signature per form would turn one mistake into a list of them, and a rest tuple would
// report an unknown tag against the whole argument list instead of at the tag.

/** A `test.for` table waiting for the name and function its rows share. `$key` in the name takes the row's `key`. */
export type TestFor<Row, Inherited extends AppName = never> = <const Names extends AppName = never>(
  name: string,
  options: TestOptions<Names, Inherited> | RowBody<ContextFor<Names | Inherited>, Row>,
  fn?: RowBody<ContextFor<Names | Inherited>, Row>,
) => void

/**
 * Declares tests. `Inherited` names the apps a `test.describe` block passes down, so the `test` its function
 * receives offers them to every test and hook inside it.
 */
export interface Test<Inherited extends AppName = never> {
  /**
   * Declares a test at the top level of a `.retest.ts` file or inside `test.describe`: `test(name, fn)` or
   * `test(name, options, fn)`. Its function receives `page` without `apps`, and one page per app with them.
   * Titles are unique in a file.
   *
   * @example
   * test('saves a task', { tags: ['smoke'] }, async ({ page }) => {
   *   await page.goto('/')
   *   await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
   * })
   */
  <const Names extends AppName = never>(
    name: string,
    options: TestOptions<Names, Inherited> | Body<ContextFor<Names | Inherited>>,
    fn?: Body<ContextFor<Names | Inherited>>,
  ): void
  /**
   * Groups tests. Its name joins theirs, and its `apps`, `tags` and `state` pass down to every test inside.
   * The function runs once, while the file loads, and receives `test` with the block's apps.
   *
   * @example
   * test.describe('sharing', { apps: ['owner', 'member'] }, (test) => {
   *   test('shows the shared task', async ({ owner, member }) => {})
   * })
   */
  describe<const Names extends AppName = never>(
    name: string,
    options: DescribeOptions<Names, Inherited> | DescribeBody<Names | Inherited>,
    fn?: DescribeBody<Names | Inherited>,
  ): void
  /**
   * Runs before each test in this file or block, outermost hooks first, in the order they are declared.
   *
   * @example test.beforeEach(async ({ page }) => { await page.goto('/tasks') })
   */
  beforeEach(fn: Body<ContextFor<Inherited>>): void
  /**
   * Runs after each test in this file or block, innermost hooks first, even when the test failed. Its own
   * failures are kept beside the test's.
   *
   * @example test.afterEach(async ({ page }) => { await page.goto('/sign-out') })
   */
  afterEach(fn: Body<ContextFor<Inherited>>): void
  /**
   * One test per row. The name fills each `$key` from the row, and the function receives the row after the
   * context. Two rows that give one name fail collection.
   *
   * @example
   * test.for([{ title: 'Release checklist' }, { title: 'Groceries' }])('archives "$title"', async ({ page }, { title }) => {})
   */
  for<Row extends object>(rows: readonly Row[]): TestFor<Row, Inherited>
  /**
   * Declares a setup at the top level of a file: it signs in with one app and, when it passes, saves the
   * browser's state under its name. A test with `state` set to that name starts from a copy of it.
   *
   * @example
   * test.setup('signed-in', async ({ page }) => {
   *   await page.goto('/login')
   *   await page.getByLabel('Password').fill(secret('password'))
   * })
   */
  setup<const Name extends AppName = never>(
    state: SetupState,
    options: SetupOptions<Name> | Body<ContextFor<Name>>,
    fn?: Body<ContextFor<Name>>,
  ): void
  /**
   * Runs part of a test as a named step, reported as its own event, and returns what the callback returns.
   *
   * @example const count = await test.step('Add two tasks', async () => 2)
   */
  step<T>(name: string, body: () => T | Promise<T>): Promise<T>
}

// Every argument is checked when the file loads, because JavaScript callers have no types.

function declare(name: unknown, ...rest: unknown[]): void {
  declareTest(name, rest)
}

function describe(name: unknown, ...rest: unknown[]): void {
  declareDescribe(name, rest, test)
}

function beforeEach(fn: unknown, ...extra: unknown[]): void {
  declareHook('beforeEach', fn, extra)
}

function afterEach(fn: unknown, ...extra: unknown[]): void {
  declareHook('afterEach', fn, extra)
}

function forRows(rows: unknown): (name: unknown, ...rest: unknown[]) => void {
  return (name, ...rest) => declareRows(rows, name, rest)
}

function setup(state: unknown, ...rest: unknown[]): void {
  declareSetup(state, rest)
}

function step<T>(name: string, body: () => T | Promise<T>): Promise<T> {
  const { run, stepId } = requireScope('test.step()')
  const location = run.location()
  if (typeof name !== 'string' || typeof body !== 'function') {
    throw run.fail(failure('usage', 'test.step() takes a name and a function: test.step(name, fn).', location))
  }
  return run.step(name, body, location, stepId)
}

export const test: Test = Object.assign(declare, { describe, beforeEach, afterEach, for: forRows, setup, step })
