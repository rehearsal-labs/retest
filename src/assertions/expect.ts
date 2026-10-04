import type { LocatorTarget, PageTarget } from '../api/app-page.ts'
import type { Scope } from '../api/context.ts'
import type { ElectronPage, Locator, NativeLocator, Page } from '../api/page.ts'
import type { RetestTypeError } from '../config/register.ts'
import type { ExpectedText, LocatorCheckRecord, PageCheckRecord } from '../protocol/locator-checks.ts'
import type { ValueCheck } from './value-checks.ts'
import { locatorTarget, pageTarget } from '../api/app-page.ts'
import { requireScope } from '../api/context.ts'
import { formatValue } from '../api/format-value.ts'
import { misuse } from '../api/misuse.ts'
import { isThenable } from '../api/operation.ts'
import { Secret } from '../api/secret.ts'
import { describeLocator, textPatternOf } from '../protocol/locator.ts'
import { maxTimeout } from '../protocol/timeouts.ts'
import { pollLocator } from './poll-locator.ts'
import { pollPage } from './poll-page.ts'
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
  toBeSelected: 'toBeSelected is for native locators. Use toBe on a value.',
  toBeChecked: 'toBeChecked is for locators. Use toBe on a value.',
  toBeEnabled: 'toBeEnabled is for locators. Use toBe on a value.',
  toBeDisabled: 'toBeDisabled is for locators. Use toBe on a value.',
  toHaveText: 'toHaveText is for locators. Use toBe on a value.',
  toContainText: 'toContainText is for locators. Use toContain on a value.',
  toHaveCount: 'toHaveCount is for locators. Use toBe on a value.',
  toHaveValue: 'toHaveValue is for locators. Use toBe on a value.',
  toHaveURL: 'toHaveURL is for a page. Use toBe on a value.',
  toHaveTitle: 'toHaveTitle is for a page. Use toBe on a value.',
  not: '.not is for locator and page matchers. Write the value matcher that says what you expect.',
  twice: '.not is written once.',
} as const

type Misplaced = typeof misplaced

/**
 * A matcher's own options: `timeout`, in milliseconds, shortens the assertion budget for that call and never
 * lengthens it.
 */
export type AssertionOptions = { readonly timeout?: number | undefined }

/** A locator's matchers, as they are and after `.not`. Each looks at the page again until it passes or time runs out. */
export interface LocatorMatchers {
  /**
   * Waits until exactly one element matches and it is visible. Negated, it passes once that one element is hidden,
   * or nothing matches.
   *
   * @example await expect(page.getByTestId('saved-task')).toBeVisible()
   */
  toBeVisible(options?: AssertionOptions): Promise<void>
  /**
   * Waits until no element matches, or none that matches is visible. Negated, it passes once a match is visible.
   *
   * @example await expect(page.getByRole('dialog')).toBeHidden()
   */
  toBeHidden(options?: AssertionOptions): Promise<void>
  /**
   * Waits until exactly one element matches, it is a checkbox, a radio button or has a checkable role, and it is
   * checked. Negated, it passes once that element is unchecked.
   *
   * @example await expect(page.getByLabel('I agree')).toBeChecked()
   */
  toBeChecked(options?: AssertionOptions): Promise<void>
  /**
   * Waits until exactly one element matches and it is enabled.
   *
   * @example await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled()
   */
  toBeEnabled(options?: AssertionOptions): Promise<void>
  /**
   * Waits until exactly one element matches and it is disabled: a native control that is disabled, on its own or in
   * a disabled fieldset, or one whose nearest `aria-disabled`, on it or an ancestor, is true.
   *
   * @example await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
   */
  toBeDisabled(options?: AssertionOptions): Promise<void>
  /**
   * Waits until exactly one element matches and its whole text equals `expected`, or matches a `RegExp`, or, given a
   * list, until the matches have exactly those texts in order. Both ends are trimmed and each run of spaces or line
   * breaks reads as one space; nothing else is loosened.
   *
   * @example
   * await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
   * await expect(page.getByRole('listitem')).toHaveText(['One', /^Two/])
   */
  toHaveText(expected: string | RegExp | readonly (string | RegExp)[], options?: AssertionOptions): Promise<void>
  /**
   * Waits until exactly one element matches and its text holds `expected`, case-sensitive, or matches a `RegExp`.
   *
   * @example await expect(page.getByRole('status')).toContainText('saved')
   */
  toContainText(expected: string | RegExp, options?: AssertionOptions): Promise<void>
  /**
   * Waits until exactly `count` elements match, visible or not.
   *
   * @example await expect(page.getByRole('listitem')).toHaveCount(2)
   */
  toHaveCount(count: number, options?: AssertionOptions): Promise<void>
  /**
   * Waits until exactly one field matches and its value is exactly `value`, or matches a `RegExp`.
   *
   * @example await expect(page.getByLabel('Title')).toHaveValue('Release checklist')
   */
  toHaveValue(value: string | RegExp, options?: AssertionOptions): Promise<void>
  readonly toBe: RetestTypeError<Misplaced['toBe']>
  readonly toEqual: RetestTypeError<Misplaced['toEqual']>
  readonly toContain: RetestTypeError<Misplaced['toContain']>
  readonly toMatch: RetestTypeError<Misplaced['toMatch']>
}

/** Matchers for a locator. They look at the page again until they pass or time runs out, so await them. */
export interface LocatorAssertions extends LocatorMatchers {
  /**
   * The same matchers, each passing only on a look that shows the opposite. A missing element passes only
   * `.not.toBeVisible()`, `.not.toHaveCount()` and `.not.toHaveText([...])`.
   *
   * @example await expect(page.getByRole('dialog')).not.toBeVisible()
   */
  readonly not: NegatedLocatorAssertions
}

/** A locator's matchers after `.not`. */
export interface NativeLocatorAssertions extends LocatorMatchers {
  toBeSelected(options?: AssertionOptions): Promise<void>
  readonly not: NativeNegatedLocatorAssertions
}
export interface NativeNegatedLocatorAssertions extends LocatorMatchers {
  toBeSelected(options?: AssertionOptions): Promise<void>
  readonly not: RetestTypeError<Misplaced['twice']>
}

export interface NegatedLocatorAssertions extends LocatorMatchers {
  readonly not: RetestTypeError<Misplaced['twice']>
}

/** A page's matchers, as they are and after `.not`. Each looks at the page again until it passes or time runs out. */
export interface PageMatchers {
  /**
   * Waits until the page's whole address, query and fragment included, equals `url`, or matches a `RegExp` anywhere.
   * A relative URL resolves against the app's base URL.
   *
   * @example await expect(page).toHaveURL('/tasks?filter=open')
   */
  toHaveURL(url: string | RegExp, options?: AssertionOptions): Promise<void>
  /**
   * Waits until the page's title equals `title`, or matches a `RegExp`, with both ends trimmed and each run of spaces
   * read as one.
   *
   * @example await expect(page).toHaveTitle('Tasks')
   */
  toHaveTitle(title: string | RegExp, options?: AssertionOptions): Promise<void>
  readonly toBe: RetestTypeError<Misplaced['toBe']>
  readonly toEqual: RetestTypeError<Misplaced['toEqual']>
}

/** Matchers for an app's page. They look again until they pass or time runs out, so await them. */
export interface PageAssertions extends PageMatchers {
  /**
   * The same matchers, each passing only on a look that shows the opposite.
   *
   * @example await expect(page).not.toHaveURL('/login')
   */
  readonly not: NegatedPageAssertions
}

/** A page's matchers after `.not`. */
export interface NegatedPageAssertions extends PageMatchers {
  readonly not: RetestTypeError<Misplaced['twice']>
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
  readonly toBeChecked: RetestTypeError<Misplaced['toBeChecked']>
  readonly toBeEnabled: RetestTypeError<Misplaced['toBeEnabled']>
  readonly toBeDisabled: RetestTypeError<Misplaced['toBeDisabled']>
  readonly toHaveText: RetestTypeError<Misplaced['toHaveText']>
  readonly toContainText: RetestTypeError<Misplaced['toContainText']>
  readonly toHaveCount: RetestTypeError<Misplaced['toHaveCount']>
  readonly toHaveValue: RetestTypeError<Misplaced['toHaveValue']>
  readonly toHaveURL: RetestTypeError<Misplaced['toHaveURL']>
  readonly toHaveTitle: RetestTypeError<Misplaced['toHaveTitle']>
  readonly not: RetestTypeError<Misplaced['not']>
}

/** Matchers for `expect.poll`. Each calls the function again until its value passes, so await them. */
export interface PollAssertions<Value> extends ValueMatchers<Value, Promise<void>> {}

type IsAny<T> = 0 extends 1 & T ? true : false

/** The matchers `expect` offers for what it was given. */
export type Assertions<Actual> =
  IsAny<Actual> extends true
    ? RetestTypeError<'expect() received a value typed any. Write expect<T>(value) with its type.'>
    : [Actual] extends [NativeLocator]
      ? NativeLocatorAssertions
      : [Actual] extends [Locator]
      ? LocatorAssertions
      : [Actual] extends [Page | ElectronPage]
        ? PageAssertions
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
  if (target !== undefined) return new LocatorExpectation(scope, target, { soft, negated: false })
  const page = pageTarget(actual)
  if (page !== undefined) return new PageExpectation(scope, page, { soft, negated: false })
  if (isThenable(actual)) throw misuse('Await the promise before expect().', scope.run)
  if (actual instanceof Secret) throw misuse('A secret cannot be compared or printed.', scope.run)
  return new ValueExpectation(scope, actual, soft)
}

/** How an expectation reports: soft lets the test go on, and negated passes only on the opposite. */
type Sense = { readonly soft: boolean; readonly negated: boolean }

class LocatorExpectation {
  readonly #scope: Scope
  readonly #target: LocatorTarget
  readonly #sense: Sense

  constructor(scope: Scope, target: LocatorTarget, sense: Sense) {
    this.#scope = scope
    this.#target = target
    this.#sense = sense
  }

  get not(): LocatorExpectation {
    if (this.#sense.negated) throw misuse(misplaced.twice, this.#scope.run)
    return new LocatorExpectation(this.#scope, this.#target, { ...this.#sense, negated: true })
  }

  toBeVisible(options?: unknown): Promise<void> {
    return this.#assert({ matcher: 'toBeVisible' }, options)
  }

  toBeHidden(options?: unknown): Promise<void> {
    return this.#assert({ matcher: 'toBeHidden' }, options)
  }

  toBeSelected(options?: unknown): Promise<void> { return this.#assert({ matcher: 'toBeSelected' }, options) }

  toBeChecked(options?: unknown): Promise<void> {
    return this.#assert({ matcher: 'toBeChecked' }, options)
  }

  toBeEnabled(options?: unknown): Promise<void> {
    return this.#assert({ matcher: 'toBeEnabled' }, options)
  }

  toBeDisabled(options?: unknown): Promise<void> {
    return this.#assert({ matcher: 'toBeDisabled' }, options)
  }

  toHaveText(expected: unknown, options?: unknown): Promise<void> {
    if (typeof expected === 'string') return this.#assert({ matcher: 'toHaveText', text: expected }, options)
    if (expected instanceof RegExp) return this.#assert({ matcher: 'toHaveText', pattern: textPatternOf(expected) }, options)
    // A copy, so the list the event sends is the one the assertion compared, whatever the test does to its own.
    if (isTextList(expected)) return this.#assert({ matcher: 'toHaveText', texts: expected.map(expectedText) }, options)
    throw misuse(`toHaveText() takes the expected text as a string or a RegExp, or a list of them, received ${formatValue(expected)}.`, this.#scope.run)
  }

  toContainText(expected: unknown, options?: unknown): Promise<void> {
    if (typeof expected === 'string') return this.#assert({ matcher: 'toContainText', text: expected }, options)
    if (expected instanceof RegExp) return this.#assert({ matcher: 'toContainText', pattern: textPatternOf(expected) }, options)
    throw misuse(`toContainText() takes the text to look for as a string or a RegExp, received ${formatValue(expected)}.`, this.#scope.run)
  }

  toHaveCount(count: unknown, options?: unknown): Promise<void> {
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) return this.#assert({ matcher: 'toHaveCount', count }, options)
    throw misuse(`toHaveCount() takes a whole number of elements, received ${formatValue(count)}.`, this.#scope.run)
  }

  toHaveValue(value: unknown, options?: unknown): Promise<void> {
    if (typeof value === 'string') return this.#assert({ matcher: 'toHaveValue', value }, options)
    if (value instanceof RegExp) return this.#assert({ matcher: 'toHaveValue', pattern: textPatternOf(value) }, options)
    throw misuse(`toHaveValue() takes the expected value as a string or a RegExp, received ${formatValue(value)}.`, this.#scope.run)
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

  #assert(matched: LocatorCheckRecord, options: unknown): Promise<void> {
    const { run, stepId } = this.#scope
    const { app, recipe } = this.#target
    const { soft, negated } = this.#sense
    const location = run.location()
    if (this.#target.run !== run) throw misuse('This locator belongs to another test. Find it again with its page.', run)
    const timeoutMs = readAssertionOptions(matched.matcher, options, this.#scope)
    const record: LocatorCheckRecord = negated ? { ...matched, not: true } : matched
    const label = `${soft ? 'expect.soft' : 'expect'}(${describeLocator(recipe)})${negated ? '.not' : ''}.${matched.matcher}()`
    return run.assertion(label, location, () => pollLocator({ run, stepId, app, recipe, record, location, soft, timeoutMs }), app)
  }
}

class PageExpectation {
  readonly #scope: Scope
  readonly #target: PageTarget
  readonly #sense: Sense

  constructor(scope: Scope, target: PageTarget, sense: Sense) {
    this.#scope = scope
    this.#target = target
    this.#sense = sense
  }

  get not(): PageExpectation {
    if (this.#sense.negated) throw misuse(misplaced.twice, this.#scope.run)
    return new PageExpectation(this.#scope, this.#target, { ...this.#sense, negated: true })
  }

  toHaveURL(url: unknown, options?: unknown): Promise<void> {
    if (url instanceof RegExp) return this.#assert({ matcher: 'toHaveURL', pattern: textPatternOf(url) }, options)
    if (typeof url !== 'string' || url.trim() === '') {
      throw misuse(`toHaveURL() takes the address as a string, such as '/tasks', or a RegExp, received ${formatValue(url)}.`, this.#scope.run)
    }
    return this.#assert({ matcher: 'toHaveURL', url }, options)
  }

  toHaveTitle(title: unknown, options?: unknown): Promise<void> {
    if (typeof title === 'string') return this.#assert({ matcher: 'toHaveTitle', title }, options)
    if (title instanceof RegExp) return this.#assert({ matcher: 'toHaveTitle', pattern: textPatternOf(title) }, options)
    throw misuse(`toHaveTitle() takes the title as a string or a RegExp, received ${formatValue(title)}.`, this.#scope.run)
  }

  toBe(): never {
    throw misuse(misplaced.toBe, this.#scope.run)
  }

  toEqual(): never {
    throw misuse(misplaced.toEqual, this.#scope.run)
  }

  #assert(matched: PageCheckRecord, options: unknown): Promise<void> {
    const { run, stepId } = this.#scope
    const { app } = this.#target
    const { soft, negated } = this.#sense
    const location = run.location()
    if (this.#target.run !== run) throw misuse('This page belongs to another test. Use the page this test was given.', run)
    const timeoutMs = readAssertionOptions(matched.matcher, options, this.#scope)
    const record: PageCheckRecord = negated ? { ...matched, not: true } : matched
    const label = `${soft ? 'expect.soft' : 'expect'}(page)${negated ? '.not' : ''}.${matched.matcher}()`
    return run.assertion(label, location, () => pollPage({ run, stepId, app, record, location, soft, timeoutMs }), app)
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

  toBeSelected(): never { throw misuse(misplaced.toBeSelected, this.#scope.run) }

  toBeChecked(): never {
    throw misuse(misplaced.toBeChecked, this.#scope.run)
  }

  toBeEnabled(): never {
    throw misuse(misplaced.toBeEnabled, this.#scope.run)
  }

  toBeDisabled(): never {
    throw misuse(misplaced.toBeDisabled, this.#scope.run)
  }

  toHaveText(): never {
    throw misuse(misplaced.toHaveText, this.#scope.run)
  }

  toContainText(): never {
    throw misuse(misplaced.toContainText, this.#scope.run)
  }

  toHaveCount(): never {
    throw misuse(misplaced.toHaveCount, this.#scope.run)
  }

  toHaveValue(): never {
    throw misuse(misplaced.toHaveValue, this.#scope.run)
  }

  toHaveURL(): never {
    throw misuse(misplaced.toHaveURL, this.#scope.run)
  }

  toHaveTitle(): never {
    throw misuse(misplaced.toHaveTitle, this.#scope.run)
  }

  get not(): never {
    throw misuse(misplaced.not, this.#scope.run)
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

function isTextList(value: unknown): value is readonly (string | RegExp)[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' || item instanceof RegExp)
}

function expectedText(item: string | RegExp): ExpectedText {
  return typeof item === 'string' ? item : textPatternOf(item)
}

/**
 * Reads a locator or page matcher's options: none, or `{ timeout }` in whole milliseconds. The timeout is returned
 * as given; the poll cuts it to the assertion budget.
 */
function readAssertionOptions(matcher: string, options: unknown, scope: Scope): number | undefined {
  if (options === undefined) return undefined
  const shape = `${matcher}() takes options such as { timeout: 2000 }, in milliseconds, received ${formatValue(options)}.`
  if (typeof options !== 'object' || options === null || Array.isArray(options)) throw misuse(shape, scope.run)
  const given = Object.entries(options).filter(([, value]) => value !== undefined)
  if (given.some(([key]) => key !== 'timeout')) throw misuse(`${shape} Its only option is timeout.`, scope.run)
  const timeout = 'timeout' in options ? options.timeout : undefined
  if (timeout === undefined) return undefined
  if (isWholeMilliseconds(timeout, 1)) return timeout
  throw misuse(`The timeout option of ${matcher}() must be a whole number of milliseconds from 1 to ${maxTimeout}, received ${formatValue(timeout)}.`, scope.run)
}
