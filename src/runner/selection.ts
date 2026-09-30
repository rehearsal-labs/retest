import type { Failure } from '../protocol/failures.ts'
import type { Variant } from '../protocol/variant.ts'
import type { FileLine, Selection, TagExpression } from './contract.ts'
import type { PlannedTest } from './plan.ts'
import type { RunConfig } from './run-config.ts'
import { failure } from '../protocol/failures.ts'
import { formatLine } from '../protocol/location.ts'
import { testTitle } from '../protocol/run-folder.ts'
import { matchesTargets, variantKey, variantPairs } from '../protocol/variant.ts'
import { notInConfig, rowNumber } from './plan.ts'

/**
 * Whether a test passes the selection's filters on the test itself: `grep`, `tags` and `locations`. A file
 * named with lines keeps the tests, `test.for` rows and `test.describe` blocks declared on those lines; a line
 * with a row keeps that one row of the `test.for` declared there.
 */
export function testSelected(test: PlannedTest, selection: Selection): boolean {
  const { grep, tags, locations } = selection
  if (grep !== undefined && !matchesGrep(grep, testTitle(test.registered.name, test.describePath))) return false
  if (tags !== undefined && !matchesTags(tags, test.registered.tags ?? [])) return false
  const inFile = locations?.filter((location) => location.file === test.file) ?? []
  return inFile.length === 0 || inFile.some((location) => declaredAt(test, location))
}

/**
 * Whether one run of a test passes `lastFailed` and `targets`. Without a variant, as in milestone 1's mode, a
 * `lastFailed` entry matches by test id alone; an entry without a variant key matches every run of its test.
 */
export function variantSelected(testId: string, variant: Readonly<Variant> | undefined, selection: Selection): boolean {
  const { lastFailed, targets } = selection
  if (targets !== undefined && !matchesTargets(variant, targets)) return false
  if (lastFailed === undefined) return true
  const key = variant === undefined ? undefined : variantKey(variant)
  return lastFailed.some((entry) => entry.testId === testId && (entry.variantKey === undefined || entry.variantKey === key))
}

/**
 * What in a selection this run cannot honour: a tag the config does not list, a target it does not have, or a
 * line in a file the run does not include. Each is a usage failure.
 */
export function selectionProblem(selection: Selection, files: readonly string[], config: RunConfig): Failure | undefined {
  const problems = [...tagProblems(selection.tags, config.tags), ...targetProblems(selection.targets, config)]
  for (const location of selection.locations ?? []) {
    if (!files.includes(location.file)) problems.push(`${formatLine(location)} names a file this run does not include.`)
  }
  const [first, ...rest] = problems
  if (first === undefined) return undefined
  return failure('usage', [first, ...rest].join(' '))
}

/** Why a selection kept no test, naming each filter it applied. */
export function emptySelectionFailure(selection: Selection): Failure {
  return failure('usage', `No test matches ${describeSelection(selection)}.`)
}

/**
 * Whether a set of tags satisfies an expression.
 *
 * @example matchesTags({ kind: 'not', operand: { kind: 'tag', tag: 'slow' } }, ['smoke']) // true
 */
export function matchesTags(expression: TagExpression, tags: readonly string[]): boolean {
  switch (expression.kind) {
    case 'tag':
      return tags.includes(expression.tag)
    case 'not':
      return !matchesTags(expression.operand, tags)
    case 'and':
      return matchesTags(expression.left, tags) && matchesTags(expression.right, tags)
    case 'or':
      return matchesTags(expression.left, tags) || matchesTags(expression.right, tags)
  }
}

/**
 * An expression written back out, with parentheses wherever a looser operator sits inside a tighter one.
 *
 * @example describeTags({ kind: 'and', left: tag('smoke'), right: { kind: 'not', operand: tag('slow') } }) // 'smoke and not slow'
 */
export function describeTags(expression: TagExpression): string {
  switch (expression.kind) {
    case 'tag':
      return expression.tag
    case 'not':
      return `not ${grouped(expression.operand, 'not')}`
    case 'and':
    case 'or':
      return `${grouped(expression.left, expression.kind)} ${expression.kind} ${grouped(expression.right, expression.kind)}`
  }
}

// `search` starts at the beginning whatever the pattern's `lastIndex`, so a global pattern matches every title alike.
function matchesGrep(grep: string | RegExp, title: string): boolean {
  return typeof grep === 'string' ? title.includes(grep) : title.search(grep) !== -1
}

// Every row of a test.for carries its line, so only a row number tells one row from another.
function declaredAt({ registered }: PlannedTest, { line, row }: FileLine): boolean {
  if (row !== undefined) return registered.location.line === line && registered.row !== undefined && rowNumber(registered.row) === row
  return [registered.location, ...(registered.describes ?? []).map((block) => block.location)].some((location) => location.line === line)
}

function tagProblems(expression: TagExpression | undefined, known: readonly string[] | undefined): string[] {
  if (expression === undefined || known === undefined) return []
  const unknown = [...new Set(tagsIn(expression))].filter((tag) => !known.includes(tag))
  return unknown.map((tag) => notInConfig('tag', tag, known))
}

function targetProblems(targets: Readonly<Variant> | undefined, config: RunConfig): string[] {
  return Object.entries(targets ?? {}).flatMap(([name, target]) => {
    const app = config.apps.get(name)
    if (app === undefined) return [`--target names the app ${JSON.stringify(name)}, which the config does not have.`]
    if (app.targets.has(target)) return []
    return [`The app ${JSON.stringify(name)} has no target ${JSON.stringify(target)}. Its targets are ${[...app.targets.keys()].join(', ')}.`]
  })
}

function tagsIn(expression: TagExpression): string[] {
  switch (expression.kind) {
    case 'tag':
      return [expression.tag]
    case 'not':
      return tagsIn(expression.operand)
    case 'and':
    case 'or':
      return [...tagsIn(expression.left), ...tagsIn(expression.right)]
  }
}

const precedence = { or: 0, and: 1, not: 2, tag: 3 } as const

function grouped(expression: TagExpression, parent: 'and' | 'or' | 'not'): string {
  const text = describeTags(expression)
  return precedence[expression.kind] < precedence[parent] ? `(${text})` : text
}

function describeSelection(selection: Selection): string {
  const parts: string[] = []
  const { grep, tags, locations, lastFailed, targets } = selection
  if (grep !== undefined) parts.push(`--grep ${typeof grep === 'string' ? JSON.stringify(grep) : String(grep)}`)
  if (tags !== undefined) parts.push(`--tag ${JSON.stringify(describeTags(tags))}`)
  for (const location of locations ?? []) parts.push(formatLine(location))
  if (lastFailed !== undefined) parts.push(lastFailed.length === 0 ? '--last-failed (the last run left no failed test)' : '--last-failed')
  parts.push(...variantPairs(targets).map((pair) => `--target ${pair}`))
  const last = parts.pop()
  if (last === undefined) return 'the files given'
  return parts.length === 0 ? last : `${parts.join(', ')} and ${last}`
}
