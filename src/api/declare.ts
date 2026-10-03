import type { FailureClass, SourceLocation } from '../protocol/failures.ts'
import type { RegisteredTest } from '../protocol/messages.ts'
import type { Collection } from './registry.ts'
import type { RuntimeBody } from './test-body.ts'
import type { Declared, OptionsKind } from './read-options.ts'
import { failure } from '../protocol/failures.ts'
import { listWords } from '../shared/list-words.ts'
import { describeBlock, describesOf, mergeDeclared } from './blocks.ts'
import { currentScope } from './context.ts'
import { formatValue } from './format-value.ts'
import { isThenable } from './operation.ts'
import { collectionRoot, joinCollection } from './registry.ts'
import { callerLocation } from './source-location.ts'
import { fillName, isRow } from './test-for.ts'
import { readOptions } from './read-options.ts'

// Declarations run while a file loads. Each checks what a JavaScript caller passed, since types do not reach
// it, and records what is wrong as a collection problem, so the file fails collection and nothing in it runs.

/** How `.skip` or `.only` marked a declaration, or neither. */
export type Mark = 'skip' | 'only' | undefined

type Callable = (...args: unknown[]) => unknown
type Call = { readonly name: string; readonly options: unknown; readonly fn: Callable; readonly location: SourceLocation }
type Settings = { readonly declared: Declared; readonly timeout?: number }
type NewTest = Settings & {
  readonly name: string
  readonly location: SourceLocation
  readonly body: RuntimeBody
  readonly setup?: true
  readonly row?: RegisteredTest['row']
  readonly mark?: Mark
}

/** `test(name, options?, fn)`, `test.skip(...)` and `test.only(...)`: a test in the block that is open. */
export function declareTest(name: unknown, rest: readonly unknown[], mark?: Mark): void {
  const called = mark === undefined ? 'test' : `test.${mark}`
  const { collection, location } = declaring(`${called}()`)
  const call = readCall(collection, { call: called, what: 'A test needs a name' }, name, rest, location)
  const settings = call && settingsOf(collection, 'test', call)
  if (!call || !settings) return
  addTest(collection, { ...settings, name: call.name, location: call.location, body: call.fn, mark })
}

/** `test.setup(state, options?, fn)`: a test that signs in with one app and saves the state it is named after. */
export function declareSetup(state: unknown, rest: readonly unknown[]): void {
  const { collection, location } = declaring('test.setup()')
  if (collection.block.parent !== undefined) {
    return problem(collection, 'test.setup() belongs at the top level of a file, outside test.describe().', location)
  }
  const call = readCall(collection, { call: 'test.setup', what: 'test.setup() needs the name of the state it saves' }, state, rest, location)
  const settings = call && settingsOf(collection, 'test.setup', call)
  if (!call || !settings) return
  addTest(collection, { ...settings, name: call.name, location: call.location, body: call.fn, setup: true })
}

/**
 * `test.describe(name, options?, fn)`, and `.skip` or `.only` on it: runs `fn` at once with a new block open, and
 * hands it `test`. Every test inside a skipped block is skipped; a block marked only singles out its tests.
 */
export function declareDescribe(name: unknown, rest: readonly unknown[], test: unknown, mark?: Mark): void {
  const called = mark === undefined ? 'test.describe' : `test.describe.${mark}`
  const { collection, location } = declaring(`${called}()`)
  const call = readCall(collection, { call: called, what: `${called}() needs a name` }, name, rest, location)
  const settings = call && settingsOf(collection, 'test.describe', call)
  if (!call || !settings) return
  const describe = { name: call.name, location: call.location, ...(mark === 'only' ? { only: true as const } : {}) }
  const block = describeBlock(collection.block, { describe, declared: settings.declared, skip: mark === 'skip' })
  const returned = collection.within(block, () => call.fn(test))
  if (isThenable(returned)) {
    const message = `${called}() runs its function once, while the file loads, and does not wait for it. Remove async from the function on line ${call.location.line}.`
    problem(collection, message, call.location)
  }
}

/** `test.beforeEach(fn)` and `test.afterEach(fn)`: a hook for every test in the block that is open. */
export function declareHook(kind: 'beforeEach' | 'afterEach', fn: unknown, extra: readonly unknown[]): void {
  const { collection, location } = declaring(`test.${kind}()`)
  if (!isCallable(fn) || extra.length > 0) {
    return problem(collection, `test.${kind}() takes one function, such as test.${kind}(async ({ page }) => {}).`, location)
  }
  if (location === undefined) return problem(collection, `Retest could not find where this test.${kind}() is declared.`, location)
  collection.block[kind].push({ body: fn, location })
}

/** `test.for(rows)(name, options?, fn)`: one test per row, each named by filling `$key` from its row. */
export function declareRows(rows: unknown, template: unknown, rest: readonly unknown[]): void {
  const { collection, location } = declaring('test.for()')
  if (!Array.isArray(rows) || !rows.every(isRow)) {
    const message = `test.for() takes a list of rows, each an object such as { title: 'Release checklist' }, received ${formatValue(rows)}.`
    return problem(collection, message, location)
  }
  const call = readCall(collection, { call: 'test.for(rows)', what: 'test.for() needs a name for its tests' }, template, rest, location)
  const settings = call && settingsOf(collection, 'test', call)
  if (!call || !settings) return
  const named = namedRows(collection, call, rows)
  if (named === undefined) return
  for (const [index, { name, row }] of named.entries()) {
    const body: RuntimeBody = (context) => call.fn(context, row)
    addTest(collection, { ...settings, name, location: call.location, body, row: { template: call.name, index } })
  }
}

// The collection a declaration joins and where it was called from. A declaration inside a running test fails it.
function declaring(call: string): { collection: Collection; location: SourceLocation | undefined } {
  const scope = currentScope()
  if (scope !== undefined) {
    const message = `${call} cannot run inside a test. Declare tests, hooks and test.describe() at the top level of a file.`
    throw scope.run.fail(failure('usage', message, scope.run.location()))
  }
  const root = collectionRoot()
  const location = root === undefined ? undefined : callerLocation(root)
  return { collection: joinCollection(call, location), location }
}

function readCall(
  collection: Collection,
  names: { call: string; what: string },
  name: unknown,
  rest: readonly unknown[],
  location: SourceLocation | undefined,
): Call | undefined {
  if (typeof name !== 'string' || name.trim() === '') return problem(collection, `${names.what}, received ${formatValue(name)}.`, location)
  if (location === undefined) return problem(collection, `Retest could not find where ${names.call} ${JSON.stringify(name)} is declared.`, location)
  const [first, second, ...extra] = rest
  const fn = rest.length === 1 ? first : second
  if (extra.length > 0 || !isCallable(fn)) {
    const message = `${names.call}(${JSON.stringify(name)}) takes a name, optional options and a function: ${names.call}(name, options?, fn).`
    return problem(collection, message, location)
  }
  return { name, options: rest.length === 1 ? {} : first, fn, location }
}

function settingsOf(collection: Collection, kind: OptionsKind, call: Call): Settings | undefined {
  const read = readOptions(kind, call.options)
  if ('problem' in read) return problem(collection, read.problem, call.location)
  return read
}

function addTest(collection: Collection, test: NewTest): void {
  const { block } = collection
  const declared = mergeDeclared(block.declared, test.declared)
  const stateProblem = checkStateApps(declared)
  if (stateProblem !== undefined) return problem(collection, stateProblem, test.location)
  const describes = describesOf(block)
  const registered: RegisteredTest = {
    name: test.name,
    location: test.location,
    ...(test.timeout === undefined ? {} : { timeout: test.timeout }),
    ...(describes.length === 0 ? {} : { describes }),
    ...declared,
    ...(test.setup === undefined ? {} : { setup: test.setup }),
    ...(test.row === undefined ? {} : { row: test.row }),
    ...(test.mark === 'skip' || block.skipped ? { skip: true as const } : {}),
    ...(test.mark === 'only' ? { only: true as const } : {}),
  }
  collection.add(registered, test.body, block)
}

function checkStateApps({ apps = [], state }: Declared): string | undefined {
  if (state === undefined || typeof state === 'string') return undefined
  const stray = Object.keys(state).find((app) => !apps.includes(app))
  if (stray === undefined) return undefined
  if (apps.length === 0) return `state gives a state for each app, but this test declares no apps. Name one state, such as state: 'signed-in'.`
  return `state names the app ${JSON.stringify(stray)}, which this test does not use. Its apps are ${listWords(apps, 'and')}.`
}

function namedRows(collection: Collection, call: Call, rows: readonly object[]): { name: string; row: object }[] | undefined {
  const named: { name: string; row: object }[] = []
  for (const [index, row] of rows.entries()) {
    const filled = fillName(call.name, row)
    if ('missing' in filled) {
      const message = `Row ${index + 1} of test.for() has no ${JSON.stringify(filled.missing)} for $${filled.missing} in ${JSON.stringify(call.name)}.`
      return problem(collection, message, call.location)
    }
    const earlier = named.findIndex((each) => each.name === filled.name)
    if (earlier !== -1) {
      const message = `Rows ${earlier + 1} and ${index + 1} of test.for() are both named ${JSON.stringify(filled.name)}. Put a $key whose value differs between them in the name.`
      return problem(collection, message, call.location, 'collection_failed')
    }
    named.push({ name: filled.name, row })
  }
  return named
}

function problem(collection: Collection, message: string, location: SourceLocation | undefined, kind: FailureClass = 'usage'): undefined {
  collection.problems.push(failure(kind, message, location))
  return undefined
}

// A function a JavaScript caller passed: Retest calls it with a context, and for a row with the row too.
function isCallable(value: unknown): value is Callable {
  return typeof value === 'function'
}
