import type { Packed } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { tempFolder } from '../support/temp-folder.ts'
import { openApp } from './browser-harness.ts'
import {
  assertStdoutIsEvents,
  assertSucceeded,
  compilers,
  eventsOf,
  installPacked,
  linkNodeTypes,
  packRetest,
  repositoryRoot,
  runProgram,
  runRetest,
  testNamed,
  typecheck,
  writeFiles,
} from './cli-harness.ts'

// Acceptance check 8, the short list's part: the packed tarball, installed offline outside the repository, exports
// the short list's new names from the runner and protocol subpaths, a registered consumer that presses keys
// type-checks on TypeScript 6 and 7 with skipLibCheck off, the keys it refuses fail with their messages on both,
// and its installed command line runs the presses against the fixture.

const packageName = '@rehearsal-labs/retest'

// Every name the short list added to the root, runner and protocol entries, used as a consumer uses it.
const names = `import type { KeyArgument, Keyboard } from '${packageName}'
import type { HostCheckActual, HostCheckRecord, HostCheckResult, HostCheckStatus, ObservedRecord } from '${packageName}/protocol'
import type { HostCheck, PageReading, ProxyOptions, ResolvedSecrets, TextQuery } from '${packageName}/runner'
import { testId, testTitle } from '${packageName}/protocol'
import { resolveSecrets, validateConfig } from '${packageName}/runner'
import { chrome, defineConfig } from '${packageName}'

const record: HostCheckRecord = { kind: 'address', origin: 'https://app.example', path: { pattern: '^/done', flags: '' } }
const status: HostCheckStatus = 'not_run'
const shown: HostCheckResult = { check: record, app: 'web', status }
const actual: HostCheckActual = { url: 'https://app.example/done', found: true }
const observed: ObservedRecord = { count: 0, visible: null, text: null, value: null, items: [], itemsTruncated: false }
const reading: PageReading = { url: undefined, navigating: false, found: [] }
const proxy: ProxyOptions = { server: 'http://127.0.0.1:8080', bypass: ['<-loopback>'] }
const query: TextQuery = { text: 'Saved', ignoreCase: false }
const enter: KeyArgument<'Enter'> = 'Enter'
const pressTab = (keyboard: Keyboard): Promise<void> => keyboard.press('Tab')
const id = testId('tests/checkout.retest.ts', testTitle('places an order', ['checkout']))
const checks: Record<string, HostCheck[]> = { [id]: [{ kind: 'text', text: 'Order placed', ignoreCase: true }, { kind: 'address', origin: 'https://app.example', path: /^\\/thanks/ }] }

const loaded = validateConfig(defineConfig({ apps: { web: chrome({ baseUrl: 'https://app.example', proxy }) }, secrets: { code: () => '4417-2231' } }), '/work/host.config.ts')
if (!loaded.ok) throw new Error(loaded.failure.message)
const secrets: ResolvedSecrets = resolveSecrets(loaded.config, {})
const read = secrets.ok ? secrets.secrets.get('code') : undefined

process.stdout.write(\`\${JSON.stringify({ id, checks: Object.keys(checks), secret: read === undefined ? 'none' : 'read' in read ? 'function' : 'value', typed: [record, shown, actual, observed, reading, query, enter, typeof pressTab].length })}\\n\`)
`

const consumerConfig = `import { chrome, defineConfig } from '${packageName}'

const config = defineConfig({
  apps: { web: chrome({ baseUrl: process.env['TASK_APP_URL'] ?? 'http://127.0.0.1:4173' }) },
})

export default config

declare module '${packageName}' {
  interface Register {
    config: typeof config
  }
}
`

const pressTests = `import { expect, test } from '${packageName}'

test('submits a search with Enter, and moves the focus with Tab and back', async ({ page }) => {
  await page.goto('/actions')
  await page.getByLabel('Search').fill('release notes')
  await page.getByLabel('Search').press('Enter')
  await expect(page.getByTestId('submitted')).toHaveText('Searched for release notes')
  await page.goto('/actions')
  await page.getByLabel('First').press('Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(page.getByTestId('focus')).toHaveText('first')
})
`

const mistakes = `import { test } from '${packageName}'

test('presses keys Retest does not send', async ({ page }) => {
  await page.getByLabel('Search').press('Entr')
  await page.keyboard.press('Control+a')
})
`

const consumerTsconfig = {
  compilerOptions: {
    target: 'es2024',
    lib: ['es2024'],
    module: 'nodenext',
    types: ['node'],
    strict: true,
    noEmit: true,
    erasableSyntaxOnly: true,
    verbatimModuleSyntax: true,
    allowImportingTsExtensions: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    skipLibCheck: false,
  },
  include: ['retest.config.ts', 'tests', 'names.ts'],
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

describe('milestone 3 package: the short list', () => {
  let root = ''
  let packed: Packed | undefined

  before(async () => {
    root = tempFolder('package-m3-')
    packed = await packRetest(root)
  })

  after(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true })
  })

  async function consumer(): Promise<string> {
    assert.ok(packed !== undefined, 'the package was packed')
    const folder = join(root, 'consumer')
    await mkdir(folder, { recursive: true })
    await writeFiles(folder, {
      'package.json': json({ name: 'retest-m3-consumer', private: true, type: 'module' }),
      'retest.config.ts': consumerConfig,
      'tests/press.retest.ts': pressTests,
      'names.ts': names,
      'tsconfig.json': json(consumerTsconfig),
      'mistakes/mistakes.ts': mistakes,
      'mistakes/tsconfig.json': json({ extends: '../tsconfig.json', include: ['../retest.config.ts', 'mistakes.ts'] }),
    })
    await installPacked(folder, packed)
    await linkNodeTypes(folder)
    assert.ok(!folder.startsWith(repositoryRoot), 'the consumer lives outside the repository')
    return folder
  }

  test('a consumer uses every new name, type-checks on TypeScript 6 and 7, and the keys press() refuses fail with their messages on both', async () => {
    const folder = await consumer()
    for (const [name, compiler] of Object.entries(compilers)) {
      assertSucceeded(await typecheck(compiler, folder), `${name} on the consumer`)
      const failed = await typecheck(compiler, folder, 'mistakes/tsconfig.json')
      assert.notEqual(failed.code, 0, `${name} accepted the mistakes`)
      const errors = failed.stdout.split('\n').filter((line) => line.includes('error TS'))
      assert.equal(errors.length, 2, `${name}:\n${failed.stdout}`)
      assert.match(errors[0] ?? '', /mistakes\.ts\(4,\d+\): error TS2345: .*RetestTypeError<"press\(\) takes a named key such as Enter or ArrowDown, Shift\+ and a named key, or one character\.">/)
      assert.match(errors[1] ?? '', /mistakes\.ts\(5,\d+\): error TS2345: .*RetestTypeError<"press\(\) does not send Control, Alt or Meta\. An editing shortcut needs the platform's own command\.">/)
    }
    const ran = await runProgram(process.execPath, ['names.ts'], folder)
    assertSucceeded(ran, 'node names.ts')
    assert.deepEqual(JSON.parse(ran.stdout), {
      id: 'tests/checkout.retest.ts > checkout > places an order',
      checks: ['tests/checkout.retest.ts > checkout > places an order'],
      secret: 'function',
      typed: 8,
    })
  })

  test('its installed command line presses keys in the fixture', async (t) => {
    const app = await openApp(t)
    const folder = join(root, 'consumer')
    const run = await runRetest(t, { files: [], cwd: folder, browser: false, command: [join(folder, 'node_modules/.bin/retest')], env: { TASK_APP_URL: app.url } })
    assert.equal(run.exit.code, 0, run.stderr)
    assertStdoutIsEvents(run)
    assert.equal(testNamed(run, 'submits a search with Enter, and moves the focus with Tab and back').status, 'passed')
    assert.deepEqual(
      eventsOf(run.events, 'action.completed').filter((event) => event.command === 'press').map((event) => event.key),
      ['Enter', 'Tab', 'Shift+Tab'],
    )
    assert.equal(app.searches(), 1)
  })
})
