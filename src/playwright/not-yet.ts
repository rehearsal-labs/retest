import { AppKeyboard, AppLocator } from '../api/app-page.ts'
import { currentScope } from '../api/context.ts'
import { RetestError } from '../api/failure.ts'
import { collectionRoot } from '../api/registry.ts'
import { callerLocation } from '../api/source-location.ts'
import { failure } from '../protocol/failures.ts'

// What to use where Playwright has a member Retest leaves out on purpose, or has under another name.
const hints: Readonly<Record<string, string>> = {
  'page.waitForTimeout': 'Wait for what the page shows instead, with an assertion such as toBeVisible().',
  'locator.first': 'A locator that matches several elements is ambiguous in Retest. Narrow it with getByRole, getByLabel, getByText or getByTestId.',
  'locator.nth': 'A locator that matches several elements is ambiguous in Retest. Narrow it with getByRole, getByLabel, getByText or getByTestId.',
  'locator.last': 'A locator that matches several elements is ambiguous in Retest. Narrow it with getByRole, getByLabel, getByText or getByTestId.',
  'locator.selectOption': 'Retest calls it select().',
  'locator.type': 'Use fill().',
  'locator.pressSequentially': 'Use fill().',
  'page.locator': 'Use getByRole, getByLabel, getByText or getByTestId.',
}

// A guard and the object it wraps, so the object itself can be handed back to Retest, whose own checks read its
// private fields.
const wrapped = new WeakMap<object, object>()

// Read by `await`, by printing and by JSON.stringify, which must find nothing rather than fail.
const passedThrough = new Set(['then', 'toJSON', 'constructor', 'inspect'])

/**
 * The failure for a member of Playwright's API that Retest's compatibility does not have yet. It names the member
 * as a test writes it, and what to use instead when Retest has an answer. Inside a test it is recorded against
 * that test, at the line that used the member; while a file loads, it is located at the caller.
 *
 * @example throw notYet('page.getByPlaceholder')
 */
export function notYet(member: string): RetestError {
  const hint = hints[member]
  const message = `${member} is not supported yet by Retest's Playwright compatibility.${hint === undefined ? '' : ` ${hint}`}`
  const run = currentScope()?.run
  if (run !== undefined) return run.fail(failure('unsupported', message, run.location()))
  const root = collectionRoot()
  return new RetestError(failure('unsupported', message, root === undefined ? undefined : callerLocation(root)))
}

/** The object a guard wraps, or the value itself when it is not a guard. */
export function unguarded(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? (wrapped.get(value) ?? value) : value
}

/**
 * Wraps an object of Retest's API so that a member Playwright has and Retest does not fails by name, where it is
 * read, instead of as "x is not a function". A locator or a keyboard a method returns is wrapped the same way.
 *
 * @example guard(page, 'page').getByPlaceholder // throws: page.getByPlaceholder is not supported yet …
 */
export function guard<T extends object>(target: T, label: string): T {
  // The proxy stands on an empty object of the same kind, not on the target: a proxy must hand back a frozen
  // property's own value, and a frozen page or context would then give its locators and keyboard out unguarded.
  const shell: T = Object.create(Reflect.getPrototypeOf(target))
  const proxy = new Proxy(shell, {
    get(_shell, property) {
      if (typeof property === 'symbol' || passedThrough.has(property)) return Reflect.get(target, property, target)
      if (!(property in target)) throw notYet(`${label}.${property}`)
      const value: unknown = Reflect.get(target, property, target)
      if (typeof value === 'function') return (...args: unknown[]): unknown => guardResult(Reflect.apply(value, target, args.map(unguarded)))
      return guardResult(value)
    },
    has: (_shell, property) => property in target,
  })
  wrapped.set(proxy, target)
  return proxy
}

function guardResult(value: unknown): unknown {
  if (value instanceof AppLocator) return guard(value, 'locator')
  if (value instanceof AppKeyboard) return guard(value, 'page.keyboard')
  return value
}
