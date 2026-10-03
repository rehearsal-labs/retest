import type { CollectedTest } from '../protocol/events.ts'
import type { Failure, FailureClass } from '../protocol/failures.ts'
import type { DescribeBlock, RegisteredTest } from '../protocol/messages.ts'
import type { Variant } from '../protocol/variant.ts'
import type { RunConfig } from './run-config.ts'
import type { SetupSearch } from './setup-search.ts'
import { failure, withAlso } from '../protocol/failures.ts'
import { formatLine } from '../protocol/location.ts'
import { testId, testTitle } from '../protocol/run-folder.ts'
import { testVariants } from './variants.ts'

/**
 * What a file's process collected, or why it could not. `borrowed` marks a file the run was not given, which
 * holds only the setups the run took from it.
 */
export type CollectedTests = { file: string; ok: true; tests: RegisteredTest[]; borrowed?: true } | { file: string; ok: false; failure: Failure }

/**
 * A collected test as a run plans it: its id, its apps, the state each app starts from and each run of it.
 * `apps` is what it declared, or the default app. `setupFor` lists, for a setup taken from a file the run was
 * not given, the files whose tests start from its state.
 */
export type PlannedTest = {
  file: string
  testId: string
  registered: RegisteredTest
  describePath: string[]
  apps: string[]
  states: ReadonlyMap<string, string>
  variants: Variant[]
  setupFor?: string[]
}

/**
 * A file whose tests passed every check, or the first problem found, with the others in `details.also`. A
 * `borrowed` file runs only for the tests that need its setups.
 */
export type PlannedFile = { file: string; ok: true; tests: PlannedTest[]; borrowed?: true } | { file: string; ok: false; failure: Failure }

/** Every setup a loaded file declares, by the state it saves, and whether its file passed its checks. */
export type Setups = ReadonlyMap<string, { test: PlannedTest; usable: boolean }>

export type Plan = { files: PlannedFile[]; setups: Setups }

/** A test and what is wrong with it: `usage` holds what the test asked for that the config does not allow. */
type Checked = { test: PlannedTest; problems: string[]; usage: string[] }
type CheckedFile = { file: string; tests: Checked[]; borrowed: boolean }

/**
 * Checks what each file collected against the config, then across files: every state a test needs is saved by
 * one setup for that app, and setups that start from a state form no cycle. A file with any problem fails
 * collection, and nothing in it runs. `search` holds the setups taken from the project's other files, when the
 * run looked there; the files it borrowed from follow the others.
 *
 * @example planTests(collected, config).files[0]?.ok
 */
export function planTests(collected: readonly CollectedTests[], config: RunConfig, search?: SetupSearch): Plan {
  const entries = [...collected, ...(search?.borrowed ?? [])]
  const checked = entries.map((entry): CheckedFile | Extract<CollectedTests, { ok: false }> => {
    if (!entry.ok) return entry
    const borrowed = entry.borrowed === true
    const tests = entry.tests.map((test) => checkTest(entry.file, test, config, borrowed ? dependentFiles(test, entries) : undefined))
    return { file: entry.file, tests, borrowed }
  })
  const loaded = checked.flatMap((entry) => ('tests' in entry ? entry.tests : []))
  const declared = declaredSetups(loaded)
  for (const entry of loaded) entry.problems.push(...stateProblems(entry.test, declared, search))
  for (const setup of setupsInCycles(declared)) declared.get(setup)?.problems.push('Its state and the states its setups start from depend on each other.')
  const files = checked.map((entry): PlannedFile => {
    if (!('tests' in entry)) return entry
    const problem = fileProblem(entry.tests)
    if (problem !== undefined) return { file: entry.file, ok: false, failure: problem }
    const tests = entry.tests.map(({ test }) => test)
    return entry.borrowed ? { file: entry.file, ok: true, tests, borrowed: true } : { file: entry.file, ok: true, tests }
  })
  const failed = new Set(files.flatMap((file) => (file.ok ? [] : [file.file])))
  const setups = new Map([...declared].map(([state, { test }]) => [state, { test, usable: !failed.has(test.file) }]))
  return { files, setups }
}

/** A test as `collection.completed` and `list` show it. Apps and variants belong to a run from a config. */
export function collectedTest(test: PlannedTest, config: RunConfig): CollectedTest {
  const { registered, describePath } = test
  return {
    testId: test.testId,
    name: registered.name,
    location: registered.location,
    ...(registered.row === undefined ? {} : { row: rowNumber(registered.row) }),
    ...(describePath.length === 0 ? {} : { describePath }),
    ...(registered.tags === undefined || registered.tags.length === 0 ? {} : { tags: registered.tags }),
    ...(config.variants ? { apps: test.apps } : {}),
    ...(registered.setup === true ? { setup: true } : {}),
    ...(config.variants && test.variants.length > 0 ? { variants: test.variants } : {}),
    ...(test.setupFor === undefined ? {} : { setupFor: test.setupFor }),
    ...(registered.skip === true ? { skip: true } : {}),
    ...(registered.only === true || (registered.describes ?? []).some((block) => block.only === true) ? { only: true } : {}),
    ...(registered.locks === undefined || registered.locks.length === 0 ? {} : { locks: registered.locks }),
  }
}

/**
 * Why a tag or state name is refused: the config lists its names, and not this one.
 *
 * @example notInConfig('tag', 'smok', ['smoke']) // 'The tag "smok" is not in the config\'s tags: smoke.'
 */
export function notInConfig(kind: 'tag' | 'state', name: string, known: readonly string[]): string {
  return `The ${kind} ${JSON.stringify(name)} is not in the config's ${kind}s: ${listed(known)}.`
}

/**
 * A `test.for` row's number in its list, from 1, as `file:line#row` names it.
 *
 * @example rowNumber({ template: 'opens $title', index: 0 }) // 1
 */
export function rowNumber(row: NonNullable<RegisteredTest['row']>): number {
  return row.index + 1
}

/**
 * The states a test starts from, whichever apps they are for.
 *
 * @example startStates({ name: 'archives', location, state: { owner: 'signed-in' } }) // ['signed-in']
 */
export function startStates({ state }: RegisteredTest): string[] {
  if (state === undefined) return []
  return typeof state === 'string' ? [state] : Object.values(state)
}

function checkTest(file: string, registered: RegisteredTest, config: RunConfig, setupFor?: string[]): Checked {
  const describePath = (registered.describes ?? []).map((block) => block.name)
  const problems: string[] = []
  const apps = testApps(registered, config, problems)
  const states = testStates(registered, apps, problems)
  for (const tag of registered.tags ?? []) {
    if (config.tags !== undefined && !config.tags.includes(tag)) problems.push(notInConfig('tag', tag, config.tags))
  }
  for (const state of new Set([...states.values(), ...(registered.setup === true ? [registered.name] : [])])) {
    if (config.states !== undefined && !config.states.includes(state)) problems.push(notInConfig('state', state, config.states))
  }
  const planned = testVariants(apps, config)
  if (!planned.ok) problems.push(planned.message)
  const variants = planned.ok ? planned.variants : []
  const id = testId(file, testTitle(registered.name, describePath))
  const usage = lockProblems(registered.locks ?? [], config.locks)
  return { test: { file, testId: id, registered, describePath, apps, states, variants, ...(setupFor === undefined ? {} : { setupFor }) }, problems, usage }
}

// A run from a config holds only the locks it declares, so a misspelt name cannot leave two tests unguarded.
// Milestone 1's mode has no config to declare them in, so any name holds.
function lockProblems(locks: readonly string[], declared: readonly string[] | undefined): string[] {
  if (declared === undefined) return []
  return locks.flatMap((lock) => {
    if (declared.includes(lock)) return []
    if (declared.length === 0) return [`It holds the lock ${JSON.stringify(lock)}, and the config declares no locks. Add locks: [${JSON.stringify(lock)}] to the config.`]
    return [`It holds the lock ${JSON.stringify(lock)}, which the config does not declare. The config's locks are ${listed(declared)}.`]
  })
}

function testApps(registered: RegisteredTest, config: RunConfig, problems: string[]): string[] {
  const declared = registered.apps ?? []
  if (declared.length === 0) {
    if (config.defaultApp !== undefined) return [config.defaultApp]
    problems.push(`It declares no apps, and the config has several with no defaultApp. Name its apps, or set defaultApp.`)
    return []
  }
  const known = [...config.apps.keys()]
  for (const [index, app] of declared.entries()) {
    if (!config.apps.has(app)) problems.push(`It uses the app ${JSON.stringify(app)}, which the config does not have. The config's apps are ${listed(known)}.`)
    else if (declared.indexOf(app) !== index) problems.push(`It lists the app ${JSON.stringify(app)} twice.`)
  }
  if (registered.setup === true && declared.length > 1) problems.push('A setup uses exactly one app.')
  return declared.filter((app, index) => config.apps.has(app) && declared.indexOf(app) === index)
}

function testStates(registered: RegisteredTest, apps: readonly string[], problems: string[]): Map<string, string> {
  const { state } = registered
  if (state === undefined) return new Map()
  if (typeof state === 'string') return new Map(apps.map((app) => [app, state]))
  const states = new Map<string, string>()
  for (const [app, name] of Object.entries(state)) {
    if (apps.includes(app)) states.set(app, name)
    else problems.push(`Its state names the app ${JSON.stringify(app)}, which it does not use.`)
  }
  return states
}

function declaredSetups(loaded: readonly Checked[]): Map<string, Checked> {
  const setups = new Map<string, Checked>()
  for (const entry of loaded) {
    if (entry.test.registered.setup !== true) continue
    const state = entry.test.registered.name
    const first = setups.get(state)
    if (first === undefined) setups.set(state, entry)
    else entry.problems.push(`The state ${JSON.stringify(state)} is also saved by the setup at ${describeLocation(first.test)}. Give each setup its own name.`)
  }
  return setups
}

function stateProblems(test: PlannedTest, setups: ReadonlyMap<string, Checked>, search: SetupSearch | undefined): string[] {
  return [...test.states].flatMap(([app, state]) => {
    const setup = setups.get(state)?.test
    if (setup === undefined) return [missingSetup(state, search)]
    const [setupApp] = setup.apps
    if (setupApp === app || setupApp === undefined) return []
    return [`The setup that saves ${JSON.stringify(state)} uses the app ${JSON.stringify(setupApp)}, not ${JSON.stringify(app)}.`]
  })
}

// Without a search, only the files given were looked in; with one, every test file under the root was.
function missingSetup(state: string, search: SetupSearch | undefined): string {
  const declare = `Declare test.setup(${JSON.stringify(state)}, ...)`
  if (search === undefined) return `No setup in this run saves the state ${JSON.stringify(state)}. ${declare} in a file this run includes.`
  const unread = search.unreadable.length === 0 ? '' : ` Retest could not load ${search.unreadable.join(', ')} to look there.`
  return `No test file saves the state ${JSON.stringify(state)}. ${declare} in one.${unread}`
}

// The files whose tests start from a borrowed setup's state, in plan order.
function dependentFiles(setup: RegisteredTest, entries: readonly CollectedTests[]): string[] {
  const needing = entries.filter((entry) => entry.ok && entry.tests.some((test) => test !== setup && startStates(test).includes(setup.name)))
  return needing.map((entry) => entry.file)
}

// Setups that start from a state whose setup, in turn, needs theirs.
function setupsInCycles(setups: ReadonlyMap<string, Checked>): string[] {
  const inCycle = new Set<string>()
  const needs = (state: string): string[] => [...new Set(setups.get(state)?.test.states.values() ?? [])]
  for (const start of setups.keys()) {
    const seen = new Set<string>()
    const pending = needs(start)
    for (let state = pending.pop(); state !== undefined; state = pending.pop()) {
      if (state === start) inCycle.add(start)
      if (seen.has(state)) continue
      seen.add(state)
      pending.push(...needs(state))
    }
  }
  return [...inCycle]
}

function fileProblem(tests: readonly Checked[]): Failure | undefined {
  const problems = [...duplicateProblems(tests), ...tests.flatMap(testProblems)]
  const [first, ...rest] = problems
  return first === undefined ? undefined : withAlso(first, rest)
}

function testProblems({ test, problems, usage }: Checked): Failure[] {
  const title = JSON.stringify(testTitle(test.registered.name, test.describePath))
  const located = (kind: FailureClass, problem: string): Failure => failure(kind, `${title}: ${problem}`, test.registered.location)
  return [...problems.map((problem) => located('collection_failed', problem)), ...usage.map((problem) => located('usage', problem))]
}

function duplicateProblems(tests: readonly Checked[]): Failure[] {
  const problems = duplicateBlocks(tests.map(({ test }) => test.registered.describes ?? []))
  const byId = new Map<string, PlannedTest>()
  for (const { test } of tests) {
    const first = byId.get(test.testId)
    if (first === undefined) byId.set(test.testId, test)
    else problems.push(failure('collection_failed', duplicateName(first, test), test.registered.location))
  }
  return problems
}

function duplicateName(first: PlannedTest, second: PlannedTest): string {
  const name = JSON.stringify(testTitle(second.registered.name, second.describePath))
  const lines = `lines ${first.registered.location.line} and ${second.registered.location.line}`
  const [one, other] = [first.registered.row, second.registered.row]
  if (one !== undefined && other !== undefined && first.registered.location.line === second.registered.location.line) {
    return `test.for rows ${rowNumber(one)} and ${rowNumber(other)} both make the name ${name}. Give each row its own name.`
  }
  return `Two tests are named ${name}, on ${lines}. Give each test its own name.`
}

// Two blocks with one name under the same parent would give their tests one id prefix.
function duplicateBlocks(chains: readonly (readonly DescribeBlock[])[]): Failure[] {
  const blocks = new Map<string, DescribeBlock>()
  const reported = new Set<string>()
  const problems: Failure[] = []
  for (const chain of chains) {
    for (const [depth, block] of chain.entries()) {
      const key = JSON.stringify(chain.slice(0, depth + 1).map((each) => each.name))
      const first = blocks.get(key)
      const place = `${block.location.line}:${block.location.column}`
      if (first === undefined) blocks.set(key, block)
      else if (place !== `${first.location.line}:${first.location.column}` && !reported.has(place)) {
        reported.add(place)
        const lines = `lines ${first.location.line} and ${block.location.line}`
        problems.push(failure('collection_failed', `Two test.describe blocks are named ${JSON.stringify(block.name)}, on ${lines}. Give each its own name.`, block.location))
      }
    }
  }
  return problems
}

function describeLocation(test: PlannedTest): string {
  return formatLine(test.registered.location)
}

function listed(names: readonly string[]): string {
  return names.length === 0 ? 'none' : names.join(', ')
}
