import type { Page } from './page.ts'
import { withPlaywrightRules } from '../api/app-page.ts'
import { declareDescribe, declareHook, declareTest } from '../api/declare.ts'
import { test as retestTest } from '../api/test.ts'
import { guard, notYet } from './not-yet.ts'

/** What a Playwright test function is handed. `page` is Retest's page for the run's app, under Playwright's names. */
export type PlaywrightFixtures = { readonly page: Page }

type TestBody = (fixtures: PlaywrightFixtures) => unknown

/**
 * Playwright's `test`, as far as Retest runs it: tests, `describe` blocks, `beforeEach` and `afterEach` hooks and
 * steps. Every other member fails where it is read, naming itself.
 */
export interface PlaywrightTest {
  (title: string, body: TestBody): void
  describe(title: string, body: () => void): void
  beforeEach(body: TestBody): void
  afterEach(body: TestBody): void
  step<T>(title: string, body: () => T | Promise<T>): Promise<T>
}

/**
 * Playwright hands a test its fixtures; Retest hands it a context with `page`, whose locators find by Playwright's
 * rules where Retest can follow them. Any other fixture a test takes, such as `context`, `browser` or `request`, fails
 * by name when the test reads it.
 *
 * @example fixturesOf(context).browser // throws: The browser fixture is not supported yet …
 */
export function fixturesOf(context: unknown): unknown {
  if (typeof context !== 'object' || context === null) return context
  let page: object | undefined
  // Retest's context is frozen, and a proxy must hand back a frozen property's own value, so the fixtures stand
  // on an empty object and read the context behind it.
  return new Proxy(
    {},
    {
      get(_fixtures, property) {
        if (typeof property === 'symbol') return Reflect.get(context, property, context)
        if (!(property in context)) throw notYet(`The ${property} fixture`)
        const value: unknown = Reflect.get(context, property, context)
        if (property !== 'page' || typeof value !== 'object' || value === null) return value
        page ??= guard(withPlaywrightRules(value), 'page')
        return page
      },
      has: (_fixtures, property) => property in context,
    },
  )
}

// A function is passed on as written when it is one; anything else goes to Retest's own checks, which say what a
// test or a hook needs.
function withFixtures(body: unknown): unknown {
  if (typeof body !== 'function') return body
  return (context: unknown, ...rest: unknown[]): unknown => Reflect.apply(body, undefined, [fixturesOf(context), ...rest])
}

function declare(title: unknown, ...rest: unknown[]): void {
  if (rest.length > 1) throw notYet('test(title, details, body)')
  declareTest(title, rest.map(withFixtures))
}

function describe(title: unknown, ...rest: unknown[]): void {
  if (rest.length > 1) throw notYet('test.describe(title, details, body)')
  declareDescribe(title, rest, test)
}

function beforeEach(body: unknown, ...extra: unknown[]): void {
  if (extra.length > 0) throw notYet('test.beforeEach(title, body)')
  declareHook('beforeEach', withFixtures(body), extra)
}

function afterEach(body: unknown, ...extra: unknown[]): void {
  if (extra.length > 0) throw notYet('test.afterEach(title, body)')
  declareHook('afterEach', withFixtures(body), extra)
}

function step<T>(title: string, body: () => T | Promise<T>, ...rest: unknown[]): Promise<T> {
  if (rest.length > 0) throw notYet('test.step(title, body, options)')
  return retestTest.step(title, body)
}

// Members of a function that Playwright has and Retest does not, such as test.skip or test.describe.serial, fail
// by name where they are read.
function guardFunction<T extends object>(target: T, label: string): T {
  return new Proxy(target, {
    get(object, property) {
      if (typeof property === 'symbol' || property in object) return Reflect.get(object, property, object)
      throw notYet(`${label}.${property}`)
    },
  })
}

/**
 * `test` as a Playwright test file imports it from `@playwright/test`.
 *
 * @example test('saves a task', async ({ page }) => { await page.goto('/') })
 */
export const test: PlaywrightTest = guardFunction(
  Object.assign(declare, { describe: guardFunction(describe, 'test.describe'), beforeEach, afterEach, step }),
  'test',
)
