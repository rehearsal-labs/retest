import type { LocatorTarget } from '../api/app-page.ts'
import type { Scope } from '../api/context.ts'
import type { Locator } from '../api/page.ts'
import type { RetestTypeError } from '../config/register.ts'
import type { LocatorCheck } from './poll-locator.ts'
import type { ValueCheck } from './value-checks.ts'
import { locatorTarget } from '../api/app-page.ts'
import { requireScope } from '../api/context.ts'
import { formatValue } from '../api/format-value.ts'
import { misuse } from '../api/misuse.ts'
import { isThenable } from '../api/operation.ts'
import { Secret } from '../api/secret.ts'
import { describeLocator } from '../protocol/locator.ts'
import { maxTimeout } from '../protocol/timeouts.ts'
import { countCheck, hiddenCheck, textCheck, textsCheck, valueCheck, visibleCheck } from './locator-checks.ts'
import { pollLocator } from './poll-locator.ts'
import { pollValue } from './poll-value.ts'
import { assertValue } from './value.ts'
import { containCheck, equalCheck, matchCheck, sameCheck } from './value-checks.ts'

// The type checker and JavaScript callers get the same sentence for a matcher used on the wrong kind of thing.
const misplaced = {
  toBe: 'toBe is for values. Use toHaveText or toBeVisible on a locator.',
  toEqual: 'toEqual is for values. Use toHaveText on a locator.',
  toContain: 'toContain is for values. Use toHaveText on a locator.',
  toMatch: 'toMatch is for values. Use toHaveText on a locator.',
  toBeVisible: 'toBeVisible is for locators. Use toBe on a value.',
  toBeHidden: 'toBeHidden is for locators. Use toBe on a value.',
  toHaveText: 'toHaveText is for locators. Use toBe on a value.',
  toHaveCount: 'toHaveCount is for locators. Use toBe on a value.',
  toHaveValue: 'toHaveValue is for locators. Use toBe on a value.',
} as const

type Misplaced = typeof misplaced

/** Matchers for a locator. They look at the page again until they pass or time runs out, so await them. */
export interface LocatorAssertions {
  /**
   * Waits until exactly one element matches and it is visible.
   *
   * @example await expect(page.getByTestId('saved-task')).toBeVisible()
   */
  toBeVisible(): Promise<void>
  /**
   * Waits until no element matches, or none that matches is visible.
   *
   * @example await expect(page.getByRole('dialog')).toBeHidden()
   */
  toBeHidden(): Promise<void>
  /**
   * Waits until exactly one element matches and its whole text equals `expected`, or, given a list, until the
   * matches have exactly those texts in order. Both ends are trimmed and each run of spaces or line breaks
   * reads as one space; nothing else is loosened.
   *
   * @example
   * await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
   * await expect(page.getByRole('listitem')).toHaveText(['One', 'Two'])
   */
  toHaveText(expected: string | readonly string[]): Promise<void>
  /**
   * Waits until exactly `count` elements match, visible or not.
   *
   * @example await expect(page.getByRole('listitem')).toHaveCount(2)
   */
  toHaveCount(count: number): Promise<void>
  /**
   * Waits until exactly one field matches and its value is exactly `value`.
   *
   * @example await expect(page.getByLabel('Title')).toHaveValue('Release checklist')
   */
  toHaveValue(value: string): Promise<void>
  readonly toBe: RetestTypeError<Misplaced['toBe']>
  readonly toEqual: RetestTypeError<Misplaced['toEqual']>
  readonly toContain: RetestTypeError<Misplaced['toContain']>
  readonly toMatch: RetestTypeError<Misplaced['toMatch']>
}

/** Matchers that compare a value. `Result` is `void` for `expect`, and a promise for `expect.poll`. */
export interface ValueMatchers<Actual, Result> {
  /**
   * Checks that the value is `expected`, compared with `Object.is`. `expected` must have the value's type.
   *
   * @example expect(count).toBe(2)
   */
  toBe(expected: NoInfer<Actual>): Result
  /**
   * Checks that the value equals `expected` deeply: primitives by `Object.is`, plain objects by their own keys,
   * arrays item by item, `Date` by its time, `Map` by key then value and `Set` by member. Any other object must
   * be the same object. A key set to undefined still counts.
   *
   * @example expect(task).toEqual({ title: 'Release checklist', done: false })
   */
  toEqual(expected: NoInfer<Actual>): Result
  /**
   * Checks that a string holds the text, case-sensitive, or that an array holds the item, by SameValueZero.
   *
   * @example expect(tags).toContain('smoke')
   */
  readonly toContain: [Actual] extends [string]
    ? (text: string) => Result
    : [Actual] extends [readonly (infer Item)[]]
      ? (item: Item) => Result
      : RetestTypeError<'toContain looks in a string or an array.'>
  /**
   * Checks that the text matches the pattern anywhere, with the pattern's own flags.
   *
   * @example expect(message).toMatch(/saved/i)
   */
  readonly toMatch: [Actual] extends [string] ? (pattern: RegExp) => Result : RetestTypeError<'toMatch is for strings.'>
}

/** Matchers for a value. They check at once. */
export interface ValueAssertions<Actual> extends ValueMatchers<Actual, void> {
  readonly toBeVisible: RetestTypeError<Misplaced['toBeVisible']>
  readonly toBeHidden: RetestTypeError<Misplaced['toBeHidden']>
  readonly toHaveText: RetestTypeError<Misplaced['toHaveText']>
  readonly toHaveCount: RetestTypeError<Misplaced['toHaveCount']>
  readonly toHaveValue: RetestTypeError<Misplaced['toHaveValue']>
}

/** Matchers for `expect.poll`. Each calls the function again until its value passes, so await them. */
export interface PollAssertions<Value> extends ValueMatchers<Value, Promise<void>> {}

type IsAny<T> = 0 extends 1 & T ? true : false

/** The matchers `expect` offers for what it was given. */
export type Assertions<Actual> =
  IsAny<Actual> extends true
    ? RetestTypeError<'expect() received a value typed any. Write expect<T>(value) with its type.'>
    : [Actual] extends [Locator]
      ? LocatorAssertions
      : [Actual] extends [PromiseLike<unknown>]
        ? RetestTypeError<'Await the promise before expect().'>
        : [Actual] extends [Secret]
          ? RetestTypeError<'A secret cannot be compared or printed.'>
          : ValueAssertions<Actual>

/** The matchers `expect.poll` offers for the value its function returns. */
export type PollFor<Value> =
  IsAny<Value> extends true
    ? RetestTypeError<'expect.poll() read a value typed any. Give its function a return type.'>
    : [Value] extends [never]
      ? RetestTypeError<'expect.poll() needs a function that returns a value.'>
      : [Value] extends [Locator]
        ? RetestTypeError<'expect.poll() reads values. Pass the locator to expect() instead.'>
        : [Value] extends [Secret]
          ? RetestTypeError<'A secret cannot be compared or printed.'>
          : PollAssertions<Value>

/**
 * How `expect.poll` looks: `timeout` is its own budget in milliseconds, and `intervals` the waits between
 * looks in milliseconds, the last one repeating.
 */
export type PollOptions = { readonly timeout?: number | undefined; readonly intervals?: readonly number[] | undefined }

export interface Expect {
  /**
   * Checks something in a test. A locator gets matchers that wait and look again; any other value gets
   * matchers that check at once.
   *
   * @example
   * await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
   * expect(count).toBe(2)
   */
  <Actual>(actual: Actual): Assertions<Actual>
  /**
   * Like `expect`, but a check that does not pass lets the test go on. The test still fails at the end, with
   * every such failure.
   *
   * @example await expect.soft(page.getByTestId('task-count')).toHaveText('2')
   */
  soft<Actual>(actual: Actual): Assertions<Actual>
  /**
   * Calls `read` again until its value passes the matcher or time runs out. `read` may only read: an action
   * inside it fails the test, because it would run again on every look.
   *
   * @example await expect.poll(async () => (await fetch(url)).status).toBe(200)
   */
  poll<Read extends () => unknown>(read: Read, options?: PollOptions): PollFor<Awaited<ReturnType<Read>>>
}

function check<Actual>(actual: Actual): Assertions<Actual>
function check(actual: unknown): unknown {
  return expectation(actual, false)
}

function soft<Actual>(actual: Actual): Assertions<Actual>
function soft(actual: unknown): unknown {
  return expectation(actual, true)
}

function poll<Read extends () => unknown>(read: Read, options?: PollOptions): PollFor<Awaited<ReturnType<Read>>>
function poll(read: unknown, options?: unknown): unknown {
  const scope = requireScope('expect.poll()')
  if (!isReader(read)) throw misuse(`expect.poll() takes a function that reads a value, received ${formatValue(read)}.`, scope.run)
  const settings = readPollOptions(options)
  if (typeof settings === 'string') throw misuse(settings, scope.run)
  return new PollExpectation(scope, read, settings)
}

export const expect: Expect = Object.assign(check, { soft, poll })

function expectation(actual: unknown, soft: boolean): unknown {
  const scope = requireScope(soft ? 'expect.soft()' : 'expect()')
  const target = locatorTarget(actual)
  if (target !== undefined) return new LocatorExpectation(scope, target, soft)
  if (isThenable(actual)) throw misuse('Await the promise before expect().', scope.run)
  if (actual instanceof Secret) throw misuse('A secret cannot be compared or printed.', scope.run)
  return new ValueExpectation(scope, actual, soft)
}

class LocatorExpectation {
  readonly #scope: Scope
  readonly #target: LocatorTarget
  readonly #soft: boolean

  constructor(scope: Scope, target: LocatorTarget, soft: boolean) {
    this.#scope = scope
    this.#target = target
    this.#soft = soft
  }

  toBeVisible(): Promise<void> {
    return this.#assert(visibleCheck())
  }

  toBeHidden(): Promise<void> {
    return this.#assert(hiddenCheck())
  }

  toHaveText(expected: unknown): Promise<void> {
    if (typeof expected === 'string') return this.#assert(textCheck(expected))
    if (isTextList(expected)) return this.#assert(textsCheck(expected))
    throw misuse(`toHaveText() takes the expected text as a string, or a list of texts, received ${formatValue(expected)}.`, this.#scope.run)
  }

  toHaveCount(count: unknown): Promise<void> {
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) return this.#assert(countCheck(count))
    throw misuse(`toHaveCount() takes a whole number of elements, received ${formatValue(count)}.`, this.#scope.run)
  }

  toHaveValue(value: unknown): Promise<void> {
    if (typeof value === 'string') return this.#assert(valueCheck(value))
    throw misuse(`toHaveValue() takes the expected value as a string, received ${formatValue(value)}.`, this.#scope.run)
  }

  toBe(): never {
    throw misuse(misplaced.toBe, this.#scope.run)
  }

  toEqual(): never {
    throw misuse(misplaced.toEqual, this.#scope.run)
  }

  toContain(): never {
    throw misuse(misplaced.toContain, this.#scope.run)
  }

  toMatch(): never {
    throw misuse(misplaced.toMatch, this.#scope.run)
  }

  #assert(check: LocatorCheck): Promise<void> {
    const { run, stepId } = this.#scope
    const { app, recipe } = this.#target
    const location = run.location()
    if (this.#target.run !== run) throw misuse('This locator belongs to another test. Find it again with its page.', run)
    const label = `${this.#soft ? 'expect.soft' : 'expect'}(${describeLocator(recipe)}).${check.matcher}()`
    const soft = this.#soft
    return run.assertion(label, location, () => pollLocator({ run, stepId, app, recipe, check, location, soft }), app)
  }
}

class ValueExpectation {
  readonly #scope: Scope
  readonly #actual: unknown
  readonly #soft: boolean

  constructor(scope: Scope, actual: unknown, soft: boolean) {
    this.#scope = scope
    this.#actual = actual
    this.#soft = soft
  }

  toBe(expected: unknown): void {
    this.#assert(sameCheck(expected))
  }

  toEqual(expected: unknown): void {
    this.#assert(equalCheck(expected))
  }

  toContain(expected: unknown): void {
    const actual = this.#actual
    if (typeof actual === 'string' && typeof expected !== 'string') {
      throw misuse(`toContain() on a string takes the text to look for, received ${formatValue(expected)}.`, this.#scope.run)
    }
    if (typeof actual !== 'string' && !Array.isArray(actual)) {
      throw misuse(`toContain looks in a string or an array, received ${formatValue(actual)}.`, this.#scope.run)
    }
    this.#assert(containCheck(expected))
  }

  toMatch(pattern: unknown): void {
    if (typeof this.#actual !== 'string') throw misuse(`toMatch is for strings, received ${formatValue(this.#actual)}.`, this.#scope.run)
    if (!(pattern instanceof RegExp)) throw misuse(`toMatch() takes a RegExp such as /saved/i, received ${formatValue(pattern)}.`, this.#scope.run)
    this.#assert(matchCheck(pattern))
  }

  toBeVisible(): never {
    throw misuse(misplaced.toBeVisible, this.#scope.run)
  }

  toBeHidden(): never {
    throw misuse(misplaced.toBeHidden, this.#scope.run)
  }

  toHaveText(): never {
    throw misuse(misplaced.toHaveText, this.#scope.run)
  }

  toHaveCount(): never {
    throw misuse(misplaced.toHaveCount, this.#scope.run)
  }

  toHaveValue(): never {
    throw misuse(misplaced.toHaveValue, this.#scope.run)
  }

  #assert(check: ValueCheck): void {
    assertValue({ scope: this.#scope, check, actual: this.#actual, location: this.#scope.run.location(), soft: this.#soft })
  }
}

type PollSettings = { readonly timeoutMs?: number; readonly intervals?: readonly number[] }

class PollExpectation {
  readonly #scope: Scope
  readonly #read: () => unknown
  readonly #settings: PollSettings

  constructor(scope: Scope, read: () => unknown, settings: PollSettings) {
    this.#scope = scope
    this.#read = read
    this.#settings = settings
  }

  toBe(expected: unknown): Promise<void> {
    return this.#poll(sameCheck(expected))
  }

  toEqual(expected: unknown): Promise<void> {
    return this.#poll(equalCheck(expected))
  }

  toContain(expected: unknown): Promise<void> {
    return this.#poll(containCheck(expected))
  }

  toMatch(pattern: unknown): Promise<void> {
    if (!(pattern instanceof RegExp)) throw misuse(`toMatch() takes a RegExp such as /saved/i, received ${formatValue(pattern)}.`, this.#scope.run)
    return this.#poll(matchCheck(pattern))
  }

  #poll(check: ValueCheck): Promise<void> {
    const { run, stepId } = this.#scope
    const location = run.location()
    const { timeoutMs, intervals } = this.#settings
    const read = this.#read
    return run.assertion(`expect.poll().${check.matcher}()`, location, () =>
      pollValue({ run, stepId, read, check, location, timeoutMs, intervals }),
    )
  }
}

function readPollOptions(options: unknown): PollSettings | string {
  if (options === undefined) return {}
  const shape = `expect.poll() options take timeout and intervals, such as { timeout: 10000, intervals: [100, 500] }, received ${formatValue(options)}.`
  if (typeof options !== 'object' || options === null || Array.isArray(options)) return shape
  if (Object.keys(options).some((key) => key !== 'timeout' && key !== 'intervals')) return shape
  const timeout = 'timeout' in options ? options.timeout : undefined
  const intervals = 'intervals' in options ? options.intervals : undefined
  if (timeout !== undefined && !isWholeMilliseconds(timeout, 1)) {
    return `expect.poll() takes timeout as a whole number of milliseconds from 1 to ${maxTimeout}, received ${formatValue(timeout)}.`
  }
  if (intervals !== undefined && !isWaits(intervals)) {
    return `expect.poll() takes intervals as a list of waits in whole milliseconds, such as [100, 500], received ${formatValue(intervals)}.`
  }
  return { ...(timeout === undefined ? {} : { timeoutMs: timeout }), ...(intervals === undefined ? {} : { intervals }) }
}

function isWholeMilliseconds(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= maxTimeout
}

function isWaits(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.length > 0 && value.every((wait) => isWholeMilliseconds(wait, 0))
}

function isReader(value: unknown): value is () => unknown {
  return typeof value === 'function'
}

function isTextList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}
