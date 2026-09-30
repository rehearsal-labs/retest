import type { Scope } from '../api/context.ts'
import type { LocatorTarget, Locator } from '../api/page.ts'
import type { LocatorCheck } from './poll-locator.ts'
import { requireScope } from '../api/context.ts'
import { locatorTarget } from '../api/page.ts'
import { failure } from '../protocol/failures.ts'
import { describeLocator } from '../protocol/locator.ts'
import { textCheck, visibleCheck } from './locator-checks.ts'
import { pollLocator } from './poll-locator.ts'
import { assertSame } from './value.ts'

declare const retestTypeError: unique symbol

/** A type that stands in for a mistake. Its message says what to write instead. */
export interface RetestTypeError<Message extends string> {
  readonly [retestTypeError]: Message
}

/** Matchers for a locator. They look at the page again until they pass or time runs out, so await them. */
export interface LocatorAssertions {
  /**
   * Waits until exactly one element matches and it is visible.
   *
   * @example await expect(page.getByTestId('saved-task')).toBeVisible()
   */
  toBeVisible(): Promise<void>
  /**
   * Waits until exactly one element matches and its whole text equals `expected`. Both ends are trimmed
   * and each run of spaces or line breaks reads as one space; nothing else is loosened.
   *
   * @example await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
   */
  toHaveText(expected: string): Promise<void>
  readonly toBe: RetestTypeError<'toBe is for values. Use toHaveText or toBeVisible on a locator.'>
}

/** Matchers for a value. They check at once. */
export interface ValueAssertions<Actual> {
  /**
   * Checks that the value is `expected`, compared with `Object.is`. `expected` must have the value's type.
   *
   * @example expect(count).toBe(2)
   */
  toBe(expected: NoInfer<Actual>): void
  readonly toBeVisible: RetestTypeError<'toBeVisible is for locators. Use toBe on a value.'>
  readonly toHaveText: RetestTypeError<'toHaveText is for locators. Use toBe on a value.'>
}

type IsAny<T> = 0 extends 1 & T ? true : false

/** The matchers `expect` offers for what it was given. */
export type Assertions<Actual> =
  IsAny<Actual> extends true
    ? RetestTypeError<'expect() received a value typed any. Write expect<T>(value) with its type.'>
    : [Actual] extends [Locator]
      ? LocatorAssertions
      : [Actual] extends [PromiseLike<unknown>]
        ? RetestTypeError<'Await the promise before expect().'>
        : ValueAssertions<Actual>

/**
 * Checks something in a test. A locator gets matchers that wait and look again; any other value gets
 * matchers that check at once.
 *
 * @example
 * await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
 * expect(count).toBe(2)
 */
export function expect<Actual>(actual: Actual): Assertions<Actual>
export function expect(actual: unknown): unknown {
  const scope = requireScope('expect()')
  const target = locatorTarget(actual)
  if (target !== undefined) return new LocatorExpectation(scope, target)
  if (isThenable(actual)) throw misuse(scope, 'Await the promise before expect().')
  return new ValueExpectation(scope, actual)
}

class LocatorExpectation {
  readonly #scope: Scope
  readonly #target: LocatorTarget

  constructor(scope: Scope, target: LocatorTarget) {
    this.#scope = scope
    this.#target = target
  }

  toBeVisible(): Promise<void> {
    return this.#assert(visibleCheck())
  }

  toHaveText(expected: string): Promise<void> {
    if (typeof expected !== 'string') throw misuse(this.#scope, 'toHaveText() takes the expected text as a string.')
    return this.#assert(textCheck(expected))
  }

  toBe(): never {
    throw misuse(this.#scope, 'toBe is for values. Use toHaveText or toBeVisible on a locator.')
  }

  #assert(check: LocatorCheck): Promise<void> {
    const { run, stepId } = this.#scope
    const { recipe } = this.#target
    const location = run.location()
    if (this.#target.run !== run) throw misuse(this.#scope, 'This locator belongs to another test. Find it again with page.')
    const label = `expect(${describeLocator(recipe)}).${check.matcher}()`
    return run.assertion(label, location, () => pollLocator({ run, stepId, recipe, check, location }))
  }
}

class ValueExpectation {
  readonly #scope: Scope
  readonly #actual: unknown

  constructor(scope: Scope, actual: unknown) {
    this.#scope = scope
    this.#actual = actual
  }

  toBe(expected: unknown): void {
    assertSame(this.#scope, this.#actual, expected, this.#scope.run.location())
  }

  toBeVisible(): never {
    throw misuse(this.#scope, 'toBeVisible is for locators. Use toBe on a value.')
  }

  toHaveText(): never {
    throw misuse(this.#scope, 'toHaveText is for locators. Use toBe on a value.')
  }
}

function misuse({ run }: Scope, message: string): Error {
  return run.fail(failure('usage', message, run.location()))
}

function isThenable(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function'
}
