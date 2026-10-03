import type { Failure, SourceLocation } from '../protocol/failures.ts'
import type { Narrowed } from '../protocol/result.ts'
import type { Plan, PlannedTest } from './plan.ts'
import { failure } from '../protocol/failures.ts'
import { formatLine } from '../protocol/location.ts'

/**
 * What `test.only` and `test.describe.only` do to a run: where each one is, which tests they keep, and how many of
 * the files' tests that leaves.
 */
export type Focus = { readonly narrowed: Narrowed; keeps(test: PlannedTest): boolean }

type Node = { readonly key: string; readonly focused: boolean }

const root: Node = { key: '', focused: false }

/**
 * The focus of a run's files, or undefined when none marks a test or block `only`. Within each block, and within the
 * run as a whole, the entries that are marked only, or hold one that is, are kept and their siblings left out; inside
 * a block marked only, every test is kept unless a block or test within it is marked only too. Borrowed files hold
 * only setups, which a focused test still gets when it needs them.
 *
 * @example focusOf(plan)?.keeps(test)
 */
export function focusOf(plan: Plan): Focus | undefined {
  const tests = plan.files.flatMap((file) => (file.ok && file.borrowed !== true ? file.tests : []))
  const paths = new Map(tests.map((test) => [test, pathOf(test)]))
  const holdsFocus = new Set<string>()
  for (const path of paths.values()) {
    for (const [index, node] of path.entries()) {
      if (node.focused) for (const outer of path.slice(0, index)) holdsFocus.add(outer.key)
    }
  }
  if (holdsFocus.size === 0) return undefined
  const keeps = (test: PlannedTest): boolean => {
    const path = paths.get(test) ?? pathOf(test)
    return path.slice(1).every((node, index) => {
      const parent = path[index]
      return parent === undefined || !holdsFocus.has(parent.key) || node.focused || holdsFocus.has(node.key)
    })
  }
  const counted = tests.filter((test) => test.registered.setup !== true)
  const narrowed = { only: onlyLocations(tests), kept: counted.filter(keeps).length, collected: counted.length }
  return { narrowed, keeps }
}

/**
 * The usage failure for a run that refuses `test.only`, naming every place one is. `reason` says why the run
 * refuses it, and ends the message.
 *
 * @example onlyRefusal(focus.narrowed, 'CI is set. Pass --allow-only to run them anyway.').message
 */
export function onlyRefusal(narrowed: Narrowed, reason: string): Failure {
  const places = narrowed.only.map((location) => formatLine(location)).join(', ')
  const message = `test.only leaves out the rest of the suite, and this run refuses it: ${places}. ${reason}`
  const [first] = narrowed.only
  return first === undefined ? failure('usage', message) : failure('usage', message, first)
}

// The file, each block around the test and the test itself, outermost first, under the run. A block's key is its
// name path, which collection keeps unique under each parent.
function pathOf(test: PlannedTest): Node[] {
  const blocks = test.registered.describes ?? []
  const file: Node = { key: JSON.stringify([test.file]), focused: false }
  const nested = blocks.map((block, index): Node => ({
    key: JSON.stringify([test.file, ...blocks.slice(0, index + 1).map((each) => each.name)]),
    focused: block.only === true,
  }))
  return [root, file, ...nested, { key: JSON.stringify([test.testId]), focused: test.registered.only === true }]
}

// Each place once, in plan order: a block's location stands for all the tests inside it.
function onlyLocations(tests: readonly PlannedTest[]): SourceLocation[] {
  const places = new Map<string, SourceLocation>()
  for (const { registered } of tests) {
    const marked = [...(registered.describes ?? []).filter((block) => block.only === true).map((block) => block.location)]
    if (registered.only === true) marked.push(registered.location)
    for (const location of marked) places.set(`${location.file}:${location.line}:${location.column}`, location)
  }
  return [...places.values()]
}
