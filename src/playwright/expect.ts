import { expect as retestExpect } from '../assertions/expect.ts'
import { notYet, unguarded } from './not-yet.ts'

/**
 * Playwright's `expect`, as far as Retest runs it: Retest's own matchers under the same names. A matcher Retest
 * does not have, `.not`, and an options argument such as `{ timeout }` fail by name where they are used.
 */
export interface PlaywrightExpect {
  (actual: unknown): PlaywrightMatchers
  soft(actual: unknown): PlaywrightMatchers
  poll(read: () => unknown, options?: { timeout?: number; intervals?: number[] }): PlaywrightMatchers
}

/** Retest's matchers under Playwright's names. Which of them a value has depends on the value, as in Retest. */
export interface PlaywrightMatchers {
  toBeVisible(): Promise<void>
  toBeHidden(): Promise<void>
  toHaveText(text: string | readonly string[]): Promise<void>
  toHaveCount(count: number): Promise<void>
  toHaveValue(value: string): Promise<void>
  toBe(expected: unknown): void
  toEqual(expected: unknown): void
  toContain(item: unknown): void
  toMatch(pattern: RegExp): void
}

// Retest's matchers take what they compare with and nothing more, so an argument beyond that is Playwright's
// options object, which is refused instead of dropped.
function matchersOf(matchers: unknown): PlaywrightMatchers {
  if (typeof matchers !== 'object' || matchers === null) throw new TypeError('expect() returned no matchers.')
  const shell: PlaywrightMatchers = Object.create(null)
  return new Proxy(
    shell,
    {
      get(_target, property) {
        if (typeof property === 'symbol' || property === 'then') return undefined
        const matcher: unknown = property in matchers ? Reflect.get(matchers, property, matchers) : undefined
        if (typeof matcher !== 'function') throw notYet(`expect().${property}`)
        return (...args: unknown[]): unknown => {
          if (args.length > matcher.length) throw notYet(`expect().${property}(…, options)`)
          return Reflect.apply(matcher, matchers, args.map(unguarded))
        }
      },
    },
  )
}

function check(actual: unknown, ...rest: unknown[]): PlaywrightMatchers {
  if (rest.length > 0) throw notYet('expect(value, message)')
  return matchersOf(Reflect.apply(retestExpect, undefined, [unguarded(actual)]))
}

function soft(actual: unknown, ...rest: unknown[]): PlaywrightMatchers {
  if (rest.length > 0) throw notYet('expect.soft(value, message)')
  return matchersOf(Reflect.apply(retestExpect.soft, undefined, [unguarded(actual)]))
}

function poll(read: () => unknown, options?: { timeout?: number; intervals?: number[] }): PlaywrightMatchers {
  return matchersOf(Reflect.apply(retestExpect.poll, undefined, options === undefined ? [read] : [read, options]))
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
