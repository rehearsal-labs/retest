import type { ResolveFnOutput, ResolveHookContext } from 'node:module'
import type { ChildOutput } from '../../src/runner/contract.ts'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { exportedSpecifiers, ownPackageResolver } from '../../src/runner/own-package.ts'
import { runFiles } from '../../src/runner/run.ts'
import { fakeLauncher } from '../support/fake-browser.ts'
import { newRunFolder, quickTimeouts, rootDir } from '../support/run-harness.ts'
import { tempFolder } from '../support/temp-folder.ts'

const name = '@rehearsal-labs/retest'

// Imports the package by name and by one of its subpaths, as a host's generated test does.
const testFile = `import { expect, test } from '${name}'
import { testId } from '${name}/protocol'

test('loads the running copy', async ({ page }) => {
  await page.goto('/')
  expect(testId('a.retest.ts', 'x')).toBe('a.retest.ts > x')
  await expect(page.getByTestId('save-task')).toBeVisible()
})
`

// A copy of Retest that is not the one running: it registers nothing, and says so if a test file uses it.
const otherCopy = {
  'package.json': JSON.stringify({ name, type: 'module', exports: { '.': './index.js' } }),
  'index.js': `export function test() { throw new Error('This is another copy of Retest.') }\nexport const expect = test\n`,
}

function write(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
}

async function runIn(root: string) {
  const { launch } = fakeLauncher()
  const output: ChildOutput[] = []
  const result = await runFiles(
    {
      files: ['a.retest.ts'],
      rootDir: root,
      apps: { kind: 'browser', browserPath: '/fake/chromium', baseUrl: 'http://127.0.0.1:4173' },
      timeouts: quickTimeouts,
      outputDir: newRunFolder(),
      headless: true,
      signal: new AbortController().signal,
      lastRunFile: false,
      onOutput: (chunk) => void output.push(chunk),
    },
    [],
    launch,
  )
  return { result, output }
}

// Whether any folder from `folder` up holds a node_modules, where Node would look for the package.
function nodeModulesAbove(folder: string): boolean {
  for (let current = folder; ; current = dirname(current)) {
    if (existsSync(join(current, 'node_modules'))) return true
    if (dirname(current) === current) return false
  }
}

describe('the test process resolves Retest to the copy that runs it', () => {
  test('a test file in a folder with no node_modules collects and runs, and its process prints nothing of its own', async () => {
    const root = tempFolder('no-modules-')
    write(root, { 'a.retest.ts': testFile })
    assert.equal(nodeModulesAbove(root), false, 'nothing up the tree could give the package')
    const { result, output } = await runIn(root)
    assert.deepEqual([result.exitCode, result.files[0]?.collection, result.files[0]?.tests.map((entry) => entry.status)], [0, 'ok', ['passed']])
    assert.deepEqual(output, [], 'no warning or anything else on stdout or stderr')
  })

  test('a test file beside another copy gets the running copy, by name and by subpath', async () => {
    const root = tempFolder('other-copy-')
    write(root, { 'a.retest.ts': testFile, ...Object.fromEntries(Object.entries(otherCopy).map(([path, text]) => [`node_modules/${name}/${path}`, text])) })
    const { result } = await runIn(root)
    assert.deepEqual([result.exitCode, result.files[0]?.collection, result.files[0]?.failure], [0, 'ok', undefined])
  })
})

describe('exportedSpecifiers', () => {
  test("names this package and each subpath its exports allow, and nothing else", () => {
    const manifest: unknown = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
    assert.deepEqual(exportedSpecifiers(manifest), new Set([name, `${name}/runner`, `${name}/protocol`, `${name}/playwright`, `${name}/package.json`]))
  })

  test('an exports map of conditions alone exports the name only, and a manifest without a name or exports is refused', () => {
    assert.deepEqual(exportedSpecifiers({ name: 'pkg', exports: { import: './index.js', default: './index.cjs' } }), new Set(['pkg']))
    for (const manifest of [{ name: 'pkg' }, { exports: { '.': './index.js' } }, { name: 'pkg', exports: './index.js' }, null]) {
      assert.throws(() => exportedSpecifiers(manifest), /The Retest package\.json has no name or no exports map\./)
    }
  })
})

describe('ownPackageResolver', () => {
  test("resolves the package's own specifiers from its own module, keeping the conditions, and leaves the rest as they came", () => {
    const own = 'file:///opt/retest/dist/runner/own-package.js'
    const hook = ownPackageResolver(new Set([name, `${name}/runner`]), own)
    const asked: [string, Partial<ResolveHookContext> | undefined][] = []
    const next = (specifier: string, context?: Partial<ResolveHookContext>): ResolveFnOutput => {
      asked.push([specifier, context])
      return { url: `file:///resolved/${specifier}` }
    }
    const context: ResolveHookContext = { conditions: ['node', 'import', 'retest-source'], importAttributes: {}, parentURL: 'file:///work/tests/a.retest.ts' }
    for (const specifier of [name, `${name}/runner`, `${name}/src/index.ts`, `${name}-other`, './helpers.ts']) hook(specifier, context, next)
    assert.deepEqual(asked, [
      [name, { ...context, parentURL: own }],
      [`${name}/runner`, { ...context, parentURL: own }],
      [`${name}/src/index.ts`, context],
      [`${name}-other`, context],
      ['./helpers.ts', context],
    ])
  })
})
