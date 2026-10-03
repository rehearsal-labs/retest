import type { ChildOutput } from '../../src/runner/contract.ts'
import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { transformTypeScript } from '../../src/loader/transform.ts'
import { runFiles } from '../../src/runner/run.ts'
import { fakeLauncher } from '../support/fake-browser.ts'
import { newRunFolder, quickTimeouts } from '../support/run-harness.ts'
import { tempFolder } from '../support/temp-folder.ts'

// A test file's process, as a run starts it: Node transforms the project's TypeScript, and the project's resolve hook
// reads its tsconfig paths. The browser is a fake; consumer-loading.test.ts runs the same in Chrome.

const model = `// An enum and parameter properties, which type stripping alone cannot load.
export enum Control {
  Save = 'save-task',
}

export class Screen {
  constructor(
    readonly control: Control,
    private readonly label: string,
  ) {}

  describe(): string {
    return \`\${this.label} \${this.control}\`
  }

  fail(): never {
    throw new Error(\`failed on purpose: \${this.label}\`)
  }
}
`

const passing = `import { expect, test } from '@rehearsal-labs/retest'
import { Control, Screen } from '@model/screen'
import { label } from './label'

test('uses an alias, an enum, parameter properties and an extensionless helper', async ({ page }) => {
  const screen = new Screen(Control.Save, label())
  expect(screen.describe()).toBe('tasks save-task')
  await page.goto('/')
  await expect(page.getByTestId(screen.control)).toBeVisible()
})
`

const failing = `import { test } from '@rehearsal-labs/retest'
import { Control, Screen } from '@model/screen'

test('throws from a transformed helper', async () => {
  new Screen(Control.Save, 'thrown').fail()
})
`

function project(files: Readonly<Record<string, string>>): string {
  const root = realpathSync(tempFolder('typescript-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

async function run(root: string, files: string[]) {
  const { launch } = fakeLauncher()
  const output: ChildOutput[] = []
  const result = await runFiles(
    {
      files,
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

const everyday = {
  'package.json': JSON.stringify({ type: 'module' }),
  'tsconfig.json': JSON.stringify({ extends: './tsconfig.base.json' }),
  'tsconfig.base.json': '{\n  "compilerOptions": {\n    "baseUrl": ".",\n    // read through extends\n    "paths": { "@model/*": ["support/*"] },\n  },\n}\n',
  'support/screen.ts': model,
  'tests/label.ts': `export function label(): string {\n  return 'tasks'\n}\n`,
  'tests/passing.retest.ts': passing,
  'tests/failing.retest.ts': failing,
}

describe('a test file loads with the project TypeScript contract', () => {
  test('a test file with an alias, an enum, parameter properties and an extensionless helper collects and passes, printing nothing', async () => {
    const { result, output } = await run(project(everyday), ['tests/passing.retest.ts'])
    assert.deepEqual([result.exitCode, result.files[0]?.collection, result.files[0]?.tests.map((entry) => entry.status)], [0, 'ok', ['passed']])
    assert.deepEqual(output, [], "no warning from Node's transformer reaches the output")
  })

  test('an error thrown in a transformed helper is located on its TypeScript line', async () => {
    const { result } = await run(project(everyday), ['tests/failing.retest.ts'])
    const [failed] = result.files[0]?.tests ?? []
    assert.deepEqual([failed?.status, failed?.failure?.class, failed?.failure?.message], ['failed', 'test_error', 'Error: failed on purpose: thrown'])
    const line = model.split('\n').findIndex((text) => text.includes('throw new Error')) + 1
    assert.deepEqual(failed?.failure?.location, { file: 'support/screen.ts', line, column: 11 })
  })

  test('a failed check in a transformed file names its TypeScript line, which the transformer moved, and its column', async () => {
    const source = `import { expect, test } from '@rehearsal-labs/retest'

// Written on one line each, and printed on several by Node's transformer.
enum Shade { Light = 'light', Dark = 'dark' }
class Theme { constructor(readonly shade: Shade, private readonly name: string) {} }

test('checks a transformed value', async () => {
  expect(new Theme(Shade.Dark, 'night').shade).toBe('light')
})
`
    const { result } = await run(project({ 'package.json': JSON.stringify({ type: 'module' }), 'tests/shade.retest.ts': source }), ['tests/shade.retest.ts'])
    const [failed] = result.files[0]?.tests ?? []
    assert.deepEqual([failed?.status, failed?.failure?.class], ['failed', 'check_failed'])
    const lines = source.split('\n')
    const line = lines.findIndex((text) => text.includes(".toBe('light')")) + 1
    assert.deepEqual(failed?.failure?.location, { file: 'tests/shade.retest.ts', line, column: (lines[line - 1] ?? '').indexOf("toBe('light')") + 1 })
    const ran = transformTypeScript(source, 'file:///shade.retest.ts', 'shade.retest.ts').split('\n')
    assert.notEqual(ran.findIndex((text) => text.includes(".toBe('light')")) + 1, line, 'the line moved in what Node ran, so only the source map names it')
  })

  test("the tsconfig nearest the test file governs its imports, and an import it cannot find names that tsconfig", async () => {
    const root = project({
      'package.json': JSON.stringify({ type: 'module' }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
      'tests/tsconfig.json': JSON.stringify({ extends: '../tsconfig.json', compilerOptions: { paths: { '@local/*': ['./local/*'] } } }),
      'tests/local/greet.ts': `export function greet(): string {\n  return 'hello'\n}\n`,
      'tests/alias.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'\nimport { greet } from '@local/greet'\n\ntest('uses the alias of the nearer tsconfig', async () => {\n  expect(greet()).toBe('hello')\n})\n`,
      'tests/missing.retest.ts': `import { test } from '@rehearsal-labs/retest'\nimport { gone } from './gone'\n\ntest('never loads', async () => {\n  gone()\n})\n`,
    })
    const { result } = await run(root, ['tests/alias.retest.ts', 'tests/missing.retest.ts'])
    const [alias, missing] = result.files
    assert.deepEqual(alias?.tests.map((entry) => entry.status), ['passed'])
    assert.equal(missing?.collection, 'failed')
    assert.match(missing?.failure?.message ?? '', new RegExp(`Imports from that file follow ${join(root, 'tests/tsconfig.json')}\\.$`))
  })

  test('a CommonJS JavaScript helper loads as Node loads it, and a CommonJS test file fails naming the construct', async () => {
    const helper = await run(project({ ...everyday, 'support/data.cjs': `module.exports = { heading: 'Tasks' }\n`, 'tests/helper.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'\nimport data from '../support/data.cjs'\n\ntest('reads a CommonJS helper', async () => {\n  expect(data.heading).toBe('Tasks')\n})\n` }), ['tests/helper.retest.ts'])
    assert.deepEqual([helper.result.exitCode, helper.result.files[0]?.tests.map((entry) => entry.status)], [0, ['passed']])
    const suite = await run(project({ 'package.json': '{}', 'tests/suite.retest.ts': `const { expect, test } = require('@rehearsal-labs/retest')\n\ntest('is CommonJS', async () => {\n  expect(1).toBe(1)\n})\n` }), ['tests/suite.retest.ts'])
    const [file] = suite.result.files
    assert.deepEqual([suite.result.exitCode, file?.collection, file?.failure?.class], [2, 'failed', 'collection_failed'])
    assert.match(file?.failure?.message ?? '', /^Could not load tests\/suite\.retest\.ts\. Error: tests\/suite\.retest\.ts uses require\(\), so Node loads it as CommonJS\./)
  })

  test('a tsconfig that cannot be read fails each file as a usage problem naming it, and no test runs', async () => {
    const root = project({ ...everyday, 'tsconfig.base.json': '{ "compilerOptions": ' })
    const { result } = await run(root, ['tests/passing.retest.ts'])
    assert.equal(result.exitCode, 2)
    const [file] = result.files
    assert.deepEqual([file?.collection, file?.failure?.class, file?.tests], ['failed', 'usage', []])
    assert.match(file?.failure?.message ?? '', new RegExp(`^${join(root, 'tsconfig.base.json')} is not valid JSON: `))
  })
})
