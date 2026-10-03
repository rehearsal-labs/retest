import type { DescribeBlock } from '../protocol/messages.ts'
import type { Hook, TestHooks } from './test-body.ts'
import type { Declared } from './read-options.ts'

/**
 * The file, or a `test.describe` block inside it: what it passes down to its tests, and its hooks. `skipped` is true
 * inside a `test.describe.skip`, however deep.
 */
export type Block = {
  readonly parent: Block | undefined
  readonly describe: DescribeBlock | undefined
  readonly declared: Declared
  readonly skipped: boolean
  readonly beforeEach: Hook[]
  readonly afterEach: Hook[]
}

/** What a `test.describe` block is: how it names itself, what it passes down, and whether `.skip` declared it. */
export type NewBlock = { readonly describe: DescribeBlock; readonly declared: Declared; readonly skip: boolean }

/** The block a file's top-level tests and hooks belong to. */
export function fileBlock(): Block {
  return { parent: undefined, describe: undefined, declared: {}, skipped: false, beforeEach: [], afterEach: [] }
}

/** A `test.describe` block inside `parent`, passing down its own options merged with what it inherits. */
export function describeBlock(parent: Block, { describe, declared, skip }: NewBlock): Block {
  return { parent, describe, declared: mergeDeclared(parent.declared, declared), skipped: parent.skipped || skip, beforeEach: [], afterEach: [] }
}

/**
 * What a test takes from its blocks and adds itself. Tags, apps and locks add up, the block's first; a test's own
 * state replaces a state name, and a state per app is merged app by app.
 *
 * @example mergeDeclared({ tags: ['smoke'] }, { tags: ['slow'] }) // { tags: ['smoke', 'slow'] }
 */
export function mergeDeclared(inherited: Declared, own: Declared): Declared {
  const tags = union(inherited.tags, own.tags)
  const apps = union(inherited.apps, own.apps)
  const state = mergeState(inherited.state, own.state)
  const locks = union(inherited.locks, own.locks)
  return {
    ...(tags === undefined ? {} : { tags }),
    ...(apps === undefined ? {} : { apps }),
    ...(state === undefined ? {} : { state }),
    ...(locks === undefined ? {} : { locks }),
  }
}

/** The `test.describe` blocks around a block, outermost first. */
export function describesOf(block: Block): DescribeBlock[] {
  return chain(block).flatMap((each) => (each.describe === undefined ? [] : [each.describe]))
}

/** The hooks a test in `block` runs: `beforeEach` from the outermost block in, `afterEach` from the innermost out. */
export function hooksOf(block: Block): TestHooks {
  const blocks = chain(block)
  return {
    beforeEach: blocks.flatMap((each) => each.beforeEach),
    afterEach: blocks.toReversed().flatMap((each) => each.afterEach),
  }
}

function chain(block: Block): Block[] {
  return block.parent === undefined ? [block] : [...chain(block.parent), block]
}

function union(first: readonly string[] | undefined, second: readonly string[] | undefined): string[] | undefined {
  if (first === undefined && second === undefined) return undefined
  return [...new Set([...(first ?? []), ...(second ?? [])])]
}

function mergeState(inherited: Declared['state'], own: Declared['state']): Declared['state'] {
  if (own === undefined) return inherited
  if (typeof own === 'string' || inherited === undefined || typeof inherited === 'string') return own
  return { ...inherited, ...own }
}
