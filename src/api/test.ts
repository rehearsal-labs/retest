import type { AppName, DefaultJudgeName, IsRegistered, JudgeName, RetestTypeError, StateName, Unregistered } from '../config/register.ts'
import type { ContextFor } from './apps.ts'
import type { EvaluateCheck } from './evaluate.ts'
import type { DescribeOptions, SetupOptions, TestOptions } from './test-options.ts'
import { failure } from '../protocol/failures.ts'
import { requireScope } from './context.ts'
import { declareDescribe, declareHook, declareRows, declareSetup, declareTest } from './declare.ts'
import { evaluate } from './evaluate.ts'

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

/** Declares one test, `(name, fn)` or `(name, options, fn)`, as `test` does: the shape of `test.skip` and `test.only`. */
export interface DeclareTest<Inherited extends AppName = never> {
  <const Names extends AppName = never>(
    name: string,
    options: TestOptions<Names, Inherited> | Body<ContextFor<Names | Inherited>>,
    fn?: Body<ContextFor<Names | Inherited>>,
  ): void
}

/** Declares a block of tests, `(name, fn)` or `(name, options, fn)`: the shape of `test.describe`, its `.skip` and its `.only`. */
export interface DeclareDescribe<Inherited extends AppName = never> {
  <const Names extends AppName = never>(
    name: string,
    options: DescribeOptions<Names, Inherited> | DescribeBody<Names | Inherited>,
    fn?: DescribeBody<Names | Inherited>,
  ): void
}

/** `test.describe`, with `.skip` and `.only` for the whole block. */
export interface Describe<Inherited extends AppName = never> extends DeclareDescribe<Inherited> {
  /**
   * Declares a block whose tests do not run. Each is reported as skipped, never as passed, and needs no setup.
   *
   * @example test.describe.skip('archive', (test) => { test('archives a task', async ({ page }) => {}) })
   */
  readonly skip: DeclareDescribe<Inherited>
  /**
   * Declares a block whose tests run while the run leaves out every test not marked only. A run prints a warning
   * when it does, and refuses it when CI is set unless `--allow-only` is given.
   *
   * @example test.describe.only('checkout', (test) => { test('pays', async ({ page }) => {}) })
   */
  readonly only: DeclareDescribe<Inherited>
}

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
   * Declares a test that does not run. It is reported as skipped, never as passed, and needs no setup.
   *
   * @example test.skip('archives a task', async ({ page }) => {})
   */
  readonly skip: DeclareTest<Inherited>
  /**
   * Declares a test that runs while the run leaves out every test not marked only, in every file. A run prints a
   * warning when it does, and refuses it when CI is set unless `--allow-only` is given.
   *
   * @example test.only('saves a task', async ({ page }) => {})
   */
  readonly only: DeclareTest<Inherited>
  /**
   * Groups tests. Its name joins theirs, and its `apps`, `tags`, `state` and `locks` pass down to every test
   * inside. The function runs once, while the file loads, and receives `test` with the block's apps.
   * `test.describe.skip` and `test.describe.only` mark every test inside.
   *
   * @example
   * test.describe('sharing', { apps: ['owner', 'member'] }, (test) => {
   *   test('shows the shared task', async ({ owner, member }) => {})
   * })
   */
  readonly describe: Describe<Inherited>
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
  /**
   * An AI check: a judge from the config decides whether evidence meets a requirement written before it looks. Retest's
   * own process captures the evidence and records the verdict. A required check that does not pass fails the test,
   * even when the test catches the error; an advisory one only records a warning. Use it where a requirement needs
   * reading, not for facts an ordinary assertion can check.
   *
   * @example
   * await test.evaluate({
   *   requirement: 'The message says the task was saved and shows its title.',
   *   evidence: { app: 'web', capture: 'screenshot' },
   * })
   */
  evaluate<const Judge extends JudgeName = DefaultJudgeName & JudgeName>(check: EvaluateCheck<Judge>): Promise<void>
}

// Every argument is checked when the file loads, because JavaScript callers have no types.

function declare(name: unknown, ...rest: unknown[]): void {
  declareTest(name, rest)
}

function skip(name: unknown, ...rest: unknown[]): void {
  declareTest(name, rest, 'skip')
}

function only(name: unknown, ...rest: unknown[]): void {
  declareTest(name, rest, 'only')
}

function describeSkip(name: unknown, ...rest: unknown[]): void {
  declareDescribe(name, rest, test, 'skip')
}

function describeOnly(name: unknown, ...rest: unknown[]): void {
  declareDescribe(name, rest, test, 'only')
}

const describe = Object.assign((name: unknown, ...rest: unknown[]): void => declareDescribe(name, rest, test), { skip: describeSkip, only: describeOnly })

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

export const test: Test = Object.assign(declare, { skip, only, describe, beforeEach, afterEach, for: forRows, setup, step, evaluate })
