import type { Failure, SourceLocation } from '../protocol/failures.ts'
import type { RegisteredTest } from '../protocol/messages.ts'
import type { Block } from './blocks.ts'
import type { RuntimeBody, TestHooks } from './test-body.ts'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { failure } from '../protocol/failures.ts'
import { testId, testTitle } from '../protocol/run-folder.ts'
import { describesOf, fileBlock, hooksOf } from './blocks.ts'
import { failureFrom, RetestError } from './failure.ts'

/** A test as collected: what the parent is told, its function, and its hooks in the order they run. */
export type TestEntry = RegisteredTest & { readonly body: RuntimeBody; readonly hooks: TestHooks }

export type Collected = { ok: true; tests: RegisteredTest[] } | { ok: false; failure: Failure }

type Pending = { readonly test: RegisteredTest; readonly title: string; readonly body: RuntimeBody; readonly block: Block }

const processKey = Symbol.for('@rehearsal-labs/retest')

claimProcess()

/** The tests, blocks and problems of the file that is loading, and its real root directory. */
export class Collection {
  readonly rootDir: string
  readonly problems: Failure[] = []
  readonly pending: Pending[] = []
  #block: Block = fileBlock()

  constructor(rootDir: string) {
    this.rootDir = rootDir
  }

  /** The block that declarations join now: the file's, or the innermost `test.describe` running. */
  get block(): Block {
    return this.#block
  }

  /** Runs a `test.describe` function with its block as the one declarations join. */
  within<T>(block: Block, body: () => T): T {
    const outer = this.#block
    this.#block = block
    try {
      return body()
    } finally {
      this.#block = outer
    }
  }

  /** Adds a test to `block`, unless one with the same full title is already there. */
  add(test: RegisteredTest, body: RuntimeBody, block: Block): void {
    const title = testTitle(test.name, describesOf(block).map((describe) => describe.name))
    const duplicate = this.pending.find((existing) => existing.title === title)
    if (duplicate === undefined) {
      this.pending.push({ test, title, body, block })
      return
    }
    const lines = `lines ${duplicate.test.location.line} and ${test.location.line}`
    this.problems.push(failure('collection_failed', `Two tests are named ${JSON.stringify(title)}, on ${lines}. Give each test its own name.`, test.location))
  }
}

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
  const collection = new Collection(realRoot)
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
  if (collection.pending.length === 0) {
    return { ok: false, failure: failure('collection_failed', `${file} has no tests. Call test() at the top level of the file.`) }
  }
  const entries = collection.pending.map(({ test, title, body, block }) => [testId(file, title), { ...test, body, hooks: hooksOf(block) }] as const)
  collected = { file, rootDir: realRoot, entries: new Map(entries) }
  return { ok: true, tests: collection.pending.map(({ test }) => test) }
}

/** The collected test with this id, and the file and real root directory it was collected from. */
export function findTest(id: string): { test: TestEntry; file: string; rootDir: string } | undefined {
  const test = collected?.entries.get(id)
  if (collected === undefined || test === undefined) return undefined
  return { test, file: collected.file, rootDir: collected.rootDir }
}

/**
 * The collection a declaration such as `test()` joins. Declaring anything after the file has loaded is a usage
 * error, thrown at once.
 */
export function joinCollection(call: string, location: SourceLocation | undefined): Collection {
  if (collecting !== undefined) return collecting
  throw new RetestError(failure('usage', `${call} registers tests while retest loads a test file. Run the file with retest run.`, location))
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
