import { locatorTarget, pageTarget } from '../api/app-page.ts'
import { expect as retestExpect } from '../assertions/expect.ts'
import { isPlainObject } from '../protocol/schema.ts'
import { notYet, unguarded } from './not-yet.ts'

/**
 * Playwright's `expect`, as far as Retest runs it: Retest's own matchers under the same names. A matcher Retest
 * does not have, `.not` on a value, and an option other than `timeout` fail by name where they are used.
 */
export interface PlaywrightExpect {
  (actual: unknown): PlaywrightMatchers
  soft(actual: unknown): PlaywrightMatchers
  poll(read: () => unknown, options?: { timeout?: number; intervals?: number[] }): PlaywrightMatchers
}

/** Options Playwright's locator and page matchers take that Retest takes too. */
export type PlaywrightMatcherOptions = { timeout?: number }

/** Retest's matchers under Playwright's names. Which of them a value has depends on the value, as in Retest. */
export interface PlaywrightMatchers {
  toBeVisible(options?: PlaywrightMatcherOptions): Promise<void>
  toBeHidden(options?: PlaywrightMatcherOptions): Promise<void>
  toBeChecked(options?: PlaywrightMatcherOptions): Promise<void>
  toBeEnabled(options?: PlaywrightMatcherOptions): Promise<void>
  toBeDisabled(options?: PlaywrightMatcherOptions): Promise<void>
  toHaveText(text: string | RegExp | readonly (string | RegExp)[], options?: PlaywrightMatcherOptions): Promise<void>
  toContainText(text: string | RegExp, options?: PlaywrightMatcherOptions): Promise<void>
  toHaveCount(count: number, options?: PlaywrightMatcherOptions): Promise<void>
  toHaveValue(value: string | RegExp, options?: PlaywrightMatcherOptions): Promise<void>
  toHaveURL(url: string | RegExp, options?: PlaywrightMatcherOptions): Promise<void>
  toHaveTitle(title: string | RegExp, options?: PlaywrightMatcherOptions): Promise<void>
  toBe(expected: unknown): void
  toEqual(expected: unknown): void
  toContain(item: unknown): void
  toMatch(pattern: RegExp): void
  /** The locator or page matchers, each passing only on a look that shows the opposite. */
  readonly not: PlaywrightMatchers
}

// Retest's locator and page matchers take what they compare with and `{ timeout }`; any other option of Playwright's
// is refused by name instead of dropped. A value's matchers take no options at all.
function matchersOf(matchers: unknown, looks: boolean): PlaywrightMatchers {
  if (typeof matchers !== 'object' || matchers === null) throw new TypeError('expect() returned no matchers.')
  const shell: PlaywrightMatchers = Object.create(null)
  return new Proxy(shell, {
    get(_target, property) {
      if (typeof property === 'symbol' || property === 'then') return undefined
      if (property === 'not') {
        if (!looks) throw notYet('expect(value).not')
        return matchersOf(Reflect.get(matchers, 'not', matchers), looks)
      }
      const matcher: unknown = property in matchers ? Reflect.get(matchers, property, matchers) : undefined
      if (typeof matcher !== 'function') throw notYet(`expect().${property}`)
      return (...args: unknown[]): unknown => Reflect.apply(matcher, matchers, matcherArguments(property, matcher.length, looks, args).map(unguarded))
    },
  })
}

function matcherArguments(property: string, arity: number, looks: boolean, args: readonly unknown[]): unknown[] {
  if (args.length > arity) throw notYet(`expect().${property}(…, options)`)
  if (property === 'toContainText' && Array.isArray(args[0])) throw notYet('expect().toContainText([…])')
  const options = looks && args.length === arity ? args[arity - 1] : undefined
  if (!isPlainObject(options)) return [...args]
  const unknown = Object.entries(options).find(([key, value]) => value !== undefined && key !== 'timeout')
  if (unknown !== undefined) throw notYet(`expect().${property}(…, { ${unknown[0]} })`)
  return [...args]
}

function looksAt(actual: unknown): boolean {
  return locatorTarget(actual) !== undefined || pageTarget(actual) !== undefined
}

function check(actual: unknown, ...rest: unknown[]): PlaywrightMatchers {
  if (rest.length > 0) throw notYet('expect(value, message)')
  const value = unguarded(actual)
  return matchersOf(Reflect.apply(retestExpect, undefined, [value]), looksAt(value))
}

function soft(actual: unknown, ...rest: unknown[]): PlaywrightMatchers {
  if (rest.length > 0) throw notYet('expect.soft(value, message)')
  const value = unguarded(actual)
  return matchersOf(Reflect.apply(retestExpect.soft, undefined, [value]), looksAt(value))
}

function poll(read: () => unknown, options?: { timeout?: number; intervals?: number[] }): PlaywrightMatchers {
  return matchersOf(Reflect.apply(retestExpect.poll, undefined, options === undefined ? [read] : [read, options]), false)
}

/**
 * `expect` as a Playwright test file imports it from `@playwright/test`.
 *
 * @example await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
 */
export const expect: PlaywrightExpect = new Proxy(Object.assign(check, { soft, poll }), {
  get(object, property) {
    if (typeof property === 'symbol' || property in object) return Reflect.get(object, property, object)
    throw notYet(`expect.${property}`)
  },
})
