import type { Failure, SourceLocation } from '../protocol/failures.ts'
import type { RegisteredTest } from '../protocol/messages.ts'
import type { TestBody } from './test-body.ts'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { failure } from '../protocol/failures.ts'
import { testId } from '../protocol/run-folder.ts'
import { maxTimeout } from '../protocol/timeouts.ts'
import { failureFrom, RetestError } from './failure.ts'
import { formatValue } from './format-value.ts'

/** A test as collected, with its body. */
export type TestEntry = RegisteredTest & { body: TestBody }

export type Collected = { ok: true; tests: RegisteredTest[] } | { ok: false; failure: Failure }

type Collection = { file: string; rootDir: string; entries: TestEntry[]; problems: Failure[] }

const processKey = Symbol.for('@rehearsal-labs/retest')
const allowedOptions = ['timeout']

claimProcess()

let collecting: Collection | undefined
let collected: { file: string; rootDir: string; entries: ReadonlyMap<string, TestEntry> } | undefined

// Tests register with the module that runs them. A second copy would collect nothing, so it refuses to load.
function claimProcess(): void {
  const owner: unknown = Reflect.get(globalThis, processKey)
  if (typeof owner === 'string' && owner !== import.meta.url) {
    throw new Error(
      `Retest is loaded twice in this process, from ${owner} and ${import.meta.url}. ` +
        'Tests register with one copy only: import @rehearsal-labs/retest from the installation that runs them.',
    )
  }
  Reflect.set(globalThis, processKey, import.meta.url)
}

/**
 * Loads a test file and returns the tests it registered, or why it could not be collected.
 *
 * @example await collectFile('tests/tasks.retest.ts', '/work')
 */
export async function collectFile(file: string, rootDir: string): Promise<Collected> {
  const realRoot = realpathSync(rootDir)
  const collection: Collection = { file, rootDir: realRoot, entries: [], problems: [] }
  collecting = collection
  try {
    await import(pathToFileURL(resolve(rootDir, file)).href)
    await new Promise((settle) => setImmediate(settle))
  } catch (error) {
    const cause = failureFrom(error, realRoot)
    return { ok: false, failure: { ...cause, class: 'collection_failed', message: `Could not load ${file}. ${cause.message}` } }
  } finally {
    collecting = undefined
  }
  const [problem] = collection.problems
  if (problem !== undefined) return { ok: false, failure: problem }
  if (collection.entries.length === 0) {
    return { ok: false, failure: failure('collection_failed', `${file} has no tests. Call test() at the top level of the file.`) }
  }
  collected = { file, rootDir: realRoot, entries: new Map(collection.entries.map((entry) => [testId(file, entry.name), entry])) }
  return { ok: true, tests: collection.entries.map(registeredTest) }
}

/** The collected test with this id, and the file and real root directory it was collected from. */
export function findTest(id: string): { test: TestEntry; file: string; rootDir: string } | undefined {
  const test = collected?.entries.get(id)
  if (collected === undefined || test === undefined) return undefined
  return { test, file: collected.file, rootDir: collected.rootDir }
}

/** The real root directory while collecting, for locating a call made during collection. */
export function collectionRoot(): string | undefined {
  return collecting?.rootDir
}

/** The real root directory of the file this process loads or has loaded. */
export function sourceRoot(): string | undefined {
  return collecting?.rootDir ?? collected?.rootDir
}

/** Records something that went wrong while the file loaded, such as a rejection nobody handled. */
export function reportCollectionProblem(problem: Failure): boolean {
  if (collecting === undefined) return false
  collecting.problems.push(problem)
  return true
}

/** Registers a test while its file loads. Arguments are checked here because JavaScript callers have no types. */
export function registerTest(name: unknown, rest: readonly unknown[], location: SourceLocation | undefined): void {
  const collection = collecting
  if (collection === undefined) {
    throw new RetestError(
      failure('usage', 'test() registers tests while retest loads a test file. Run the file with retest run.', location),
    )
  }
  const entry = readRegistration(name, rest, location)
  if (!('body' in entry)) {
    collection.problems.push(entry)
    return
  }
  const duplicate = collection.entries.find((existing) => existing.name === entry.name)
  if (duplicate !== undefined) {
    const lines = `lines ${duplicate.location.line} and ${entry.location.line}`
    collection.problems.push(
      failure('collection_failed', `Two tests are named ${JSON.stringify(entry.name)}, on ${lines}. Give each test its own name.`, location),
    )
    return
  }
  collection.entries.push(entry)
}

function readRegistration(name: unknown, rest: readonly unknown[], location: SourceLocation | undefined): TestEntry | Failure {
  const usage = (message: string): Failure => failure('usage', message, location)
  if (typeof name !== 'string' || name.trim() === '') return usage(`A test needs a name, received ${formatValue(name)}.`)
  if (location === undefined) return usage(`Retest could not find where test ${JSON.stringify(name)} is declared.`)
  const [first, second, ...extra] = rest
  const body = rest.length === 1 ? first : second
  const options = rest.length === 1 ? {} : first
  if (extra.length > 0 || !isTestBody(body)) {
    return usage(`test(${JSON.stringify(name)}) takes a name, optional options and a function: test(name, options?, fn).`)
  }
  const timeout = readOptions(options, usage)
  if (typeof timeout === 'object') return timeout
  return timeout === undefined ? { name, location, body } : { name, location, timeout, body }
}

function readOptions(options: unknown, usage: (message: string) => Failure): number | undefined | Failure {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    return usage(`Test options must be an object, such as { timeout: 5000 }, received ${formatValue(options)}.`)
  }
  const unknown = Object.keys(options).find((key) => !allowedOptions.includes(key))
  if (unknown !== undefined) {
    return usage(`Unknown test option ${JSON.stringify(unknown)}. This version of Retest accepts only timeout.`)
  }
  if (!('timeout' in options) || options.timeout === undefined) return undefined
  const { timeout } = options
  if (typeof timeout === 'number' && Number.isInteger(timeout) && timeout >= 1 && timeout <= maxTimeout) return timeout
  return usage(`The timeout option must be a whole number of milliseconds from 1 to ${maxTimeout}, received ${formatValue(timeout)}.`)
}

function registeredTest({ name, location, timeout }: TestEntry): RegisteredTest {
  return timeout === undefined ? { name, location } : { name, location, timeout }
}

function isTestBody(value: unknown): value is TestBody {
  return typeof value === 'function'
}
