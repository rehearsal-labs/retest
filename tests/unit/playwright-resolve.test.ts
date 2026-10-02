import type { ResolveFnOutput, ResolveHookContext } from 'node:module'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { playwrightResolver, playwrightSpecifiers } from '../../src/runner/playwright-resolve.ts'

const own = 'file:///opt/retest/dist/runner/playwright-resolve.js'
const compatibility = '@rehearsal-labs/retest/playwright'
const context: ResolveHookContext = { conditions: ['node', 'import'], importAttributes: {}, parentURL: 'file:///work/tests/tasks.spec.ts' }

/** A resolver that knows `known` specifiers and answers the rest as Node does a missing module. */
function resolving(known: readonly string[], code = 'ERR_MODULE_NOT_FOUND') {
  const asked: [string, Partial<ResolveHookContext> | undefined][] = []
  const next = (specifier: string, given?: Partial<ResolveHookContext>): ResolveFnOutput => {
    asked.push([specifier, given])
    if (known.includes(specifier)) return { url: `file:///resolved/${specifier}` }
    throw Object.assign(new Error(`Cannot find module ${specifier}`), { code })
  }
  return { asked, next }
}

describe('playwrightResolver', () => {
  test("Playwright's specifiers resolve to Retest's own subpath, as a module of this copy imports it", () => {
    const hook = playwrightResolver(compatibility, own)
    const { asked, next } = resolving([compatibility, 'node:fs'])
    assert.deepEqual([...playwrightSpecifiers], ['@playwright/test', 'playwright/test'])
    for (const specifier of playwrightSpecifiers) assert.equal(hook(specifier, context, next).url, `file:///resolved/${compatibility}`)
    hook('node:fs', context, next)
    assert.deepEqual(asked, [
      [compatibility, { ...context, parentURL: own }],
      [compatibility, { ...context, parentURL: own }],
      ['node:fs', context],
    ])
  })

  test('a relative import without its extension resolves to the file, then to the folder index, in that order', () => {
    const hook = playwrightResolver(compatibility, own)
    const file = resolving(['./helper.ts'])
    assert.equal(hook('./helper', context, file.next).url, 'file:///resolved/./helper.ts')
    assert.deepEqual(file.asked.map(([specifier]) => specifier), ['./helper', './helper.ts'])
    const folder = resolving(['../pages/index.ts'], 'ERR_UNSUPPORTED_DIR_IMPORT')
    assert.equal(hook('../pages', context, folder.next).url, 'file:///resolved/../pages/index.ts')
    assert.deepEqual(folder.asked.map(([specifier]) => specifier), ['../pages', '../pages.ts', '../pages.js', '../pages.mts', '../pages.mjs', '../pages/index.ts'])
  })

  test('an import that names its file is asked for once, and one nothing answers fails as it first did', () => {
    const hook = playwrightResolver(compatibility, own)
    const named = resolving(['./helper.ts'])
    hook('./helper.ts', context, named.next)
    assert.equal(named.asked.length, 1)
    const missing = resolving([])
    assert.throws(() => hook('./nowhere', context, missing.next), /Cannot find module \.\/nowhere$/)
    assert.equal(missing.asked.length, 7)
  })

  test('a package that is not there, and an error that is not about a missing file, are not retried', () => {
    const hook = playwrightResolver(compatibility, own)
    const bare = resolving([])
    assert.throws(() => hook('left-pad', context, bare.next), /Cannot find module left-pad/)
    assert.equal(bare.asked.length, 1)
    const broken = resolving([], 'ERR_INVALID_MODULE_SPECIFIER')
    assert.throws(() => hook('./helper', context, broken.next), /Cannot find module \.\/helper/)
    assert.equal(broken.asked.length, 1)
  })
})
