import { AppKeyboard, AppLocator } from '../api/app-page.ts'
import { currentScope } from '../api/context.ts'
import { RetestError } from '../api/failure.ts'
import { collectionRoot } from '../api/registry.ts'
import { callerLocation } from '../api/source-location.ts'
import { failure } from '../protocol/failures.ts'
import { isPlainObject } from '../protocol/schema.ts'

const rowNameHint =
  "Chrome's accessibility tree gives a table row no name from its cells, where Playwright names it from them. Take the row by position with nth(), or find a cell by name."

// What to use where Playwright has a member Retest leaves out on purpose, or has under another name.
const hints: Readonly<Record<string, string>> = {
  'page.waitForTimeout': 'Wait for what the page shows instead, with an assertion such as toBeVisible().',
  'page.waitForURL': 'Check the address with expect(page).toHaveURL(), which looks again until it passes.',
  'page.url': 'Playwright reads it at once, and Retest has to ask the page. Check it with expect(page).toHaveURL().',
  'locator.filter': 'Find inside a locator with getByRole, getByText or locator(), or keep one match with first(), last() or nth().',
  'locator.type': 'Use fill().',
  'locator.pressSequentially': 'Use fill().',
  'locator.selectOption(text)':
    "Playwright matches the text against each option's value and its label at once, and Retest has to know which. Name the option with { label } or { value }.",
  'page.getByRole(row, { name })': rowNameHint,
  'locator.getByRole(row, { name })': rowNameHint,
}

// Members Retest has under a name Playwright gives to something else, refused rather than mistaken for it.
const refused: ReadonlySet<string> = new Set(['page.url'])

/** Where a member takes Playwright's options, which of them Retest takes, and how messages write the call. */
type OptionsAt = { readonly index: number; readonly keys: readonly string[]; readonly call: string }

// A goto, a reload and every action take Retest's own `{ timeout }`; finders take the options Retest's finders take.
const timeout = ['timeout']
const finders: Readonly<Record<string, OptionsAt>> = {
  getByRole: { index: 1, keys: ['name', 'exact'], call: 'getByRole(role, options)' },
  getByText: { index: 1, keys: ['exact'], call: 'getByText(text, options)' },
  getByLabel: { index: 1, keys: ['exact'], call: 'getByLabel(text, options)' },
  getByPlaceholder: { index: 1, keys: ['exact'], call: 'getByPlaceholder(text, options)' },
  getByTestId: { index: 1, keys: [], call: 'getByTestId(testId, options)' },
  locator: { index: 1, keys: [], call: 'locator(selector, options)' },
}
const optionsOf: Readonly<Record<string, Readonly<Record<string, OptionsAt>>>> = {
  page: {
    ...finders,
    goto: { index: 1, keys: timeout, call: 'goto(url, options)' },
    reload: { index: 0, keys: timeout, call: 'reload(options)' },
    goBack: { index: 0, keys: timeout, call: 'goBack(options)' },
    goForward: { index: 0, keys: timeout, call: 'goForward(options)' },
    title: { index: 0, keys: [], call: 'title(options)' },
  },
  locator: {
    ...finders,
    click: { index: 0, keys: timeout, call: 'click(options)' },
    hover: { index: 0, keys: timeout, call: 'hover(options)' },
    tap: { index: 0, keys: timeout, call: 'tap(options)' },
    check: { index: 0, keys: timeout, call: 'check(options)' },
    uncheck: { index: 0, keys: timeout, call: 'uncheck(options)' },
    fill: { index: 1, keys: timeout, call: 'fill(value, options)' },
    press: { index: 1, keys: timeout, call: 'press(key, options)' },
    selectOption: { index: 1, keys: timeout, call: 'selectOption(values, options)' },
    first: { index: 0, keys: [], call: 'first(options)' },
    last: { index: 0, keys: [], call: 'last(options)' },
    nth: { index: 1, keys: [], call: 'nth(index, options)' },
  },
  // Playwright's keyboard takes a delay, and Retest presses each key at once.
  'page.keyboard': { press: { index: 1, keys: [], call: 'press(key, options)' } },
}

/** A member Playwright names otherwise: Retest's name for it, and Playwright's arguments read in Retest's terms. */
type Renamed = { readonly to: string; readonly translate: (args: readonly unknown[]) => unknown[] }

const renamed: Readonly<Record<string, Renamed>> = {
  'locator.selectOption': { to: 'select', translate: ([values, ...rest]) => [selectChoice(values), ...rest] },
}

// What a Playwright call answers where Retest's answers nothing, named as a test would read it.
const unanswered: Readonly<Record<string, string>> = {
  'page.goto': 'The response page.goto() returns',
  'page.reload': 'The response page.reload() returns',
  'page.goBack': 'The response page.goBack() returns',
  'page.goForward': 'The response page.goForward() returns',
  'locator.selectOption': 'The values locator.selectOption() returns',
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
 * @example throw notYet('page.getByAltText')
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
 * read, instead of as "x is not a function". A locator or a keyboard a method returns is wrapped the same way. An
 * argument Retest does not take, such as an option of Playwright's it has no answer for, fails by name too.
 *
 * @example guard(page, 'page').getByAltText // throws: page.getByAltText is not supported yet …
 */
export function guard<T extends object>(target: T, label: string): T {
  // The proxy stands on an empty object of the same kind, not on the target: a proxy must hand back a frozen
  // property's own value, and a frozen page or context would then give its locators and keyboard out unguarded.
  const shell: T = Object.create(Reflect.getPrototypeOf(target))
  const proxy = new Proxy(shell, {
    get(_shell, property) {
      if (typeof property === 'symbol' || passedThrough.has(property)) return Reflect.get(target, property, target)
      const member = `${label}.${property}`
      const alias = renamed[member]
      const name = alias?.to ?? property
      if (!(name in target) || refused.has(member)) throw notYet(member)
      const value: unknown = Reflect.get(target, name, target)
      if (typeof value !== 'function') return guardResult(value)
      return (...args: unknown[]): unknown => {
        const given = playwrightArguments(label, property, value.length, args)
        const passed = alias === undefined ? given : alias.translate(given)
        return answering(member, guardResult(Reflect.apply(value, target, passed.map(unguarded))))
      }
    },
    has: (_shell, property) => property in target || (typeof property === 'string' && renamed[`${label}.${property}`] !== undefined),
  })
  wrapped.set(proxy, target)
  return proxy
}

/**
 * The option a `selectOption` call names, as Retest's `select` takes it: `{ label }` as the label itself and
 * `{ value }` as it is. A bare string is refused, since Playwright matches it against each option's value and its
 * label at once; so are a list, `{ index }`, `null` and an option named two ways, which Retest has no answer for.
 * Anything else goes to Retest's own check, which says what `select` takes.
 */
function selectChoice(values: unknown): unknown {
  if (typeof values === 'string') throw notYet('locator.selectOption(text)')
  if (Array.isArray(values)) throw notYet('locator.selectOption([…])')
  if (values === null) throw notYet('locator.selectOption(null)')
  if (!isPlainObject(values)) return values
  const keys = Object.entries(values).flatMap(([key, value]) => (value === undefined ? [] : [key]))
  const [only] = keys
  const named = only === undefined ? undefined : values[only]
  if (keys.length === 1 && only === 'label' && typeof named === 'string') return named
  if (keys.length === 1 && only === 'value' && typeof named === 'string') return { value: named }
  if (keys.length === 0) return values
  throw notYet(`locator.selectOption({ ${keys.join(', ')} })`)
}

/**
 * The call's own promise, or, for a call whose answer Playwright gives and Retest does not, the same promise answering
 * a value that fails by name when anything reads it. The promise's own `then` still runs only when the test awaits it,
 * so Retest still sees a call nothing awaited.
 */
function answering(member: string, result: unknown): unknown {
  const name = unanswered[member]
  if (name === undefined || !(result instanceof Promise)) return result
  const unread = unreadable(name)
  return new Proxy(result, {
    get(promise, property) {
      const value: unknown = Reflect.get(promise, property, promise)
      if (property !== 'then' || typeof value !== 'function') return value
      return (onFulfilled?: unknown, onRejected?: unknown): unknown =>
        Reflect.apply(value, promise, [() => (typeof onFulfilled === 'function' ? Reflect.apply(onFulfilled, undefined, [unread]) : unread), onRejected])
    },
  })
}

// Awaiting, printing and JSON.stringify find nothing on it; anything else a test reads fails by name.
function unreadable(name: string): object {
  const empty: object = Object.create(null)
  return new Proxy(empty, {
    get(_empty, property) {
      if (typeof property === 'symbol' || passedThrough.has(property)) return undefined
      throw notYet(name)
    },
  })
}

/**
 * The arguments a Playwright call passes on to Retest, or the failure that names what Retest does not take: an
 * argument past those Retest's method has, or an option it has no answer for. A finder's text says `exact` as
 * Playwright means it.
 */
function playwrightArguments(label: string, property: string, arity: number, args: readonly unknown[]): unknown[] {
  const at = optionsOf[label]?.[property]
  if (at === undefined) {
    if (args.length > arity) throw notYet(`${label}.${property}() with ${args.length} arguments`)
    return [...args]
  }
  if (args.length > at.index + 1) throw notYet(`${label}.${at.call.replace(/\)$/, ', …)')}`)
  const options = args[at.index]
  if (options !== undefined && !isPlainObject(options)) return [...args]
  const given: Readonly<Record<string, unknown>> = isPlainObject(options) ? options : {}
  const unknown = Object.entries(given).find(([key, value]) => value !== undefined && !at.keys.includes(key))
  if (unknown !== undefined) throw notYet(`${label}.${at.call.replace('options', `{ ${unknown[0]} }`)}`)
  if (property === 'getByRole' && args[0] === 'row' && given['name'] !== undefined) throw notYet(`${label}.getByRole(row, { name })`)
  if (!textFinders.has(property)) return [...args]
  const text = property === 'getByRole' ? given['name'] : args[0]
  return [...args.slice(0, at.index), finderOptions(text, given)]
}

// The finders whose text Playwright and Retest compare differently.
const textFinders: ReadonlySet<string> = new Set(['getByRole', 'getByText', 'getByLabel', 'getByPlaceholder'])

// Playwright's finders match any part of a text, in any case, unless `exact` is true, where Retest's match the whole
// text, case and all, unless it is false; both trim it and read each run of spaces as one. Playwright ignores `exact`
// beside a `RegExp` and without a name, where Retest refuses it, so it is left out there.
function finderOptions(text: unknown, options: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { exact, ...kept } = options
  return typeof text === 'string' ? { ...kept, exact: exact === true } : kept
}

function guardResult(value: unknown): unknown {
  if (value instanceof AppLocator) return guard(value, 'locator')
  if (value instanceof AppKeyboard) return guard(value, 'page.keyboard')
  return value
}
