import type { ResolveFnOutput, ResolveHookContext } from 'node:module'
import type { ProjectPaths, TsconfigRead } from '../../src/loader/tsconfig.ts'
import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { matchAlias, projectResolver } from '../../src/loader/resolve.ts'
import { tempFolder } from '../support/temp-folder.ts'

const own = 'file:///opt/retest/dist/loader/project.js'
const ownFolderUrl = 'file:///opt/retest/dist/'
const paths: ProjectPaths = {
  file: '/work/tsconfig.json',
  folder: '/work',
  aliases: [
    { pattern: '@support/*', targets: ['/work/support/*', '/work/generated/*'] },
    { pattern: '@support/models/*', targets: ['/work/models/*'] },
    { pattern: 'config', targets: ['/work/config/index.ts'] },
    { pattern: '*', targets: ['/work/types/*'] },
  ],
}

// The tsconfig above governs every file under /work, as the nearest one up from each importing file would.
function tsconfigFor(folder: string): TsconfigRead | undefined {
  return folder === '/work' || folder.startsWith('/work/') ? { ok: true, paths } : undefined
}

function from(parentURL: string | undefined): ResolveHookContext {
  return { conditions: ['node', 'import'], importAttributes: {}, parentURL }
}

/** A resolver that knows `known` specifiers and answers the rest as Node does a missing module. */
function resolving(known: readonly string[]) {
  const asked: string[] = []
  const next = (specifier: string): ResolveFnOutput => {
    asked.push(specifier)
    if (known.includes(specifier)) return { url: specifier.startsWith('file:') ? specifier : `file:///resolved/${specifier}` }
    throw Object.assign(new Error(`Cannot find module ${specifier}`), { code: 'ERR_MODULE_NOT_FOUND' })
  }
  return { asked, next }
}

describe('matchAlias', () => {
  test('an exact pattern wins, then the wildcard pattern with the longest part before its star', () => {
    assert.deepEqual(matchAlias(paths.aliases, 'config'), { pattern: 'config', paths: ['/work/config/index.ts'] })
    assert.deepEqual(matchAlias(paths.aliases, '@support/models/task'), { pattern: '@support/models/*', paths: ['/work/models/task'] })
    assert.deepEqual(matchAlias(paths.aliases, '@support/task-page'), { pattern: '@support/*', paths: ['/work/support/task-page', '/work/generated/task-page'] })
    assert.deepEqual(matchAlias(paths.aliases, 'left-pad'), { pattern: '*', paths: ['/work/types/left-pad'] })
    assert.equal(matchAlias(paths.aliases.slice(0, 3), 'left-pad'), undefined)
  })

  test('a pattern with text after its star matches only imports that end with it', () => {
    const aliases = [{ pattern: '#data/*.json', targets: ['/work/data/*.json'] }]
    assert.deepEqual(matchAlias(aliases, '#data/users.json'), { pattern: '#data/*.json', paths: ['/work/data/users.json'] })
    assert.equal(matchAlias(aliases, '#data/users'), undefined)
  })
})

describe('projectResolver', () => {
  const hook = projectResolver({ ownUrl: own, ownFolderUrl, tsconfigFor })
  const fromTestFile = from('file:///work/tests/tasks.retest.ts')

  test("an alias resolves to its first target that is a file, trying each target's extensions and index", () => {
    const first = resolving(['file:///work/support/task-page.ts'])
    assert.equal(hook('@support/task-page', fromTestFile, first.next).url, 'file:///work/support/task-page.ts')
    assert.deepEqual(first.asked, ['file:///work/support/task-page', 'file:///work/support/task-page.ts'])
    const second = resolving(['file:///work/generated/client/index.ts'])
    assert.equal(hook('@support/client', fromTestFile, second.next).url, 'file:///work/generated/client/index.ts')
    assert.equal(second.asked.at(-1), 'file:///work/generated/client/index.ts')
  })

  test('an alias none of whose targets is a file resolves as Node resolves the import, such as a package of that name', () => {
    const packaged = resolving(['@support/sdk'])
    assert.equal(hook('@support/sdk', fromTestFile, packaged.next).url, 'file:///resolved/@support/sdk')
    assert.equal(packaged.asked.at(-1), '@support/sdk')
    const nowhere = resolving([])
    assert.throws(
      () => hook('@support/nowhere', fromTestFile, nowhere.next),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'ERR_MODULE_NOT_FOUND' &&
        error.message === 'Cannot find @support/nowhere imported from /work/tests/tasks.retest.ts. @support/* in the paths of /work/tsconfig.json maps it to /work/support/nowhere, /work/generated/nowhere, and none of them is a file.',
    )
  })

  test('an import of a .js file resolves to the .ts source beside it when there is one, as tsc reads it, and to the .js otherwise', () => {
    const both = resolving(['./labels.ts', './labels.js'])
    assert.equal(hook('./labels.js', fromTestFile, both.next).url, 'file:///resolved/./labels.ts')
    assert.deepEqual(both.asked, ['./labels.ts'], 'the .ts wins over a .js beside it')
    const javascript = resolving(['./legacy.js'])
    assert.equal(hook('./legacy.js', fromTestFile, javascript.next).url, 'file:///resolved/./legacy.js')
    assert.deepEqual(javascript.asked, ['./legacy.ts', './legacy.js'])
    const mjs = resolving(['../lib/clock.mts', '../lib/clock.mjs'])
    assert.equal(hook('../lib/clock.mjs', fromTestFile, mjs.next).url, 'file:///resolved/../lib/clock.mts')
    assert.deepEqual(mjs.asked, ['../lib/clock.mts'])
  })

  test('. and .. are relative imports of a folder, resolved to its index, and never matched against an alias', () => {
    const parent = resolving(['../index.ts'])
    assert.equal(hook('..', fromTestFile, parent.next).url, 'file:///resolved/../index.ts')
    assert.deepEqual(parent.asked, ['..', '../index.ts'], 'the * alias is never tried')
    const here = resolving(['./index.js'])
    assert.equal(hook('.', fromTestFile, here.next).url, 'file:///resolved/./index.js')
    assert.deepEqual(here.asked, ['.', './index.ts', './index.js'])
  })

  test('a folder import resolves to its index, after a file of the same name, as tsc reads it', () => {
    const slash = resolving(['./pages/index.ts'])
    assert.equal(hook('./pages/', fromTestFile, slash.next).url, 'file:///resolved/./pages/index.ts')
    assert.deepEqual(slash.asked, ['./pages/', './pages/index.ts'])
    const file = resolving(['./pages.ts', './pages/index.ts'])
    assert.equal(hook('./pages', fromTestFile, file.next).url, 'file:///resolved/./pages.ts')
  })

  test('an import that cannot be found from a file a tsconfig governs names that tsconfig', () => {
    assert.throws(() => hook('./nowhere', fromTestFile, resolving([]).next), {
      message: 'Cannot find module ./nowhere. Imports from that file follow /work/tsconfig.json.',
      code: 'ERR_MODULE_NOT_FOUND',
    })
    assert.throws(() => hook('left-pad', fromTestFile, resolving([]).next), {
      message: 'Cannot find left-pad imported from /work/tests/tasks.retest.ts. * in the paths of /work/tsconfig.json maps it to /work/types/left-pad, and none of them is a file.',
    })
    const noAlias = projectResolver({ ownUrl: own, ownFolderUrl, tsconfigFor: () => ({ ok: true, paths: { ...paths, aliases: [] } }) })
    assert.throws(() => noAlias('left-pad', fromTestFile, resolving([]).next), { message: 'Cannot find module left-pad. Imports from that file follow /work/tsconfig.json.' })
  })

  test('a tsconfig that cannot be read fails each import from the files it governs, with its own message', () => {
    const unreadable = projectResolver({ ownUrl: own, ownFolderUrl, tsconfigFor: () => ({ ok: false, failure: { class: 'usage', message: '/work/tsconfig.json is not valid JSON: Unexpected end of JSON input' } }) })
    assert.throws(() => unreadable('./helper.ts', fromTestFile, resolving(['./helper.ts']).next), { message: '/work/tsconfig.json is not valid JSON: Unexpected end of JSON input' })
  })

  test('imports from node_modules, from Retest itself and from outside the tsconfig folder keep Node resolution', () => {
    for (const parent of ['file:///work/node_modules/sdk/index.js', 'file:///opt/retest/dist/runner/child.js', undefined]) {
      const untouched = resolving([])
      assert.throws(() => hook('./helper', from(parent), untouched.next), /Cannot find module \.\/helper$/)
      assert.throws(() => hook('@support/task-page', from(parent), untouched.next), /Cannot find module @support\/task-page$/)
      assert.deepEqual(untouched.asked, ['./helper', '@support/task-page'], `${parent ?? 'no parent'} resolves as Node resolves`)
    }
    const outside = resolving(['@support/task-page'])
    assert.equal(hook('@support/task-page', from('file:///elsewhere/a.ts'), outside.next).url, 'file:///resolved/@support/task-page')
    assert.deepEqual(outside.asked, ['@support/task-page'], 'the aliases apply in the tsconfig folder only')
  })

  test('without paths, a bare import resolves as Node resolves it, once', () => {
    const plain = projectResolver({ ownUrl: own, ownFolderUrl })
    const bare = resolving(['@rehearsal-labs/retest'])
    plain('@rehearsal-labs/retest', fromTestFile, bare.next)
    assert.deepEqual(bare.asked, ['@rehearsal-labs/retest'])
  })

  test('a relative import without an extension that names a JSX file fails saying so', () => {
    const root = realpathSync(tempFolder('jsx-'))
    mkdirSync(join(root, 'tests'))
    writeFileSync(join(root, 'view.tsx'), 'export const view = <p />\n')
    const parent = pathToFileURL(join(root, 'tests/a.retest.ts')).href
    const named = projectResolver({ ownUrl: own, ownFolderUrl, rootFolder: root })
    assert.throws(() => named('../view', from(parent), resolving([]).next), { message: '../view names view.tsx, a .tsx file. Retest does not load JSX.', code: 'ERR_MODULE_NOT_FOUND' })
    const unnamed = projectResolver({ ownUrl: own, ownFolderUrl })
    assert.throws(() => unnamed('../view', from(parent), resolving([]).next), { message: `../view names ${join(root, 'view.tsx')}, a .tsx file. Retest does not load JSX.` })
  })
})
