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

// Acceptance check 8: the packed tarball, installed offline outside the repository, exports every name wave 1 added
// to the root, runner and protocol entries; a registered consumer that presses keys, chooses, ticks and scrolls
// type-checks on TypeScript 6 and 7 with skipLibCheck off; the calls the types refuse fail with their messages on
// both; and its installed command line runs the presses, choices and scrolls against the fixture.

const packageName = '@rehearsal-labs/retest'

// Every name wave 1 added to the root, runner and protocol entries, used as a consumer uses it: the short list's,
// then the rest's.
const names = `import type { KeyArgument, Keyboard, OptionChoice, ScrollDelta, SecretContext } from '${packageName}'
import type { HostCheckActual, HostCheckRecord, HostCheckResult, HostCheckStatus, NavigationCause, NavigationDocument, ObservedRecord, OptionChoiceRecord, PageFacts } from '${packageName}/protocol'
import type { HostCheck, PageNavigation, PageReading, ProxyOptions, ResolvedSecrets, RunFolder, StopReason, TextQuery } from '${packageName}/runner'
import { join } from 'node:path'
import { eventsFile, logsFolder, resultFile, testId, testTitle } from '${packageName}/protocol'
import { readRunFolder, resolveSecrets, RunFolderReadError, validateConfig } from '${packageName}/runner'
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

const readCode = ({ signal }: SecretContext): string => (signal.aborted ? '' : '4417-2231')
const loaded = validateConfig(defineConfig({ apps: { web: chrome({ baseUrl: 'https://app.example', proxy }) }, secrets: { code: readCode } }), '/work/host.config.ts')
if (!loaded.ok) throw new Error(loaded.failure.message)
const secrets: ResolvedSecrets = resolveSecrets(loaded.config, {})
const read = secrets.ok ? secrets.secrets.get('code') : undefined

const choices: OptionChoice[] = ['Canada', { value: 'mx' }]
const delta: ScrollDelta = { y: 600 }
const recorded: OptionChoiceRecord[] = [{ label: 'Canada' }, { value: 'mx' }]
const cause: NavigationCause = 'action'
const facts: PageFacts = { url: 'https://app.example/done', title: 'Done' }
const opened: NavigationDocument = 'new'
const navigation: PageNavigation = { url: facts.url, title: Promise.resolve(facts.title), cause, document: opened, commandToken: 1 }
const reason: StopReason = { class: 'interrupted', message: 'The host is shutting down, so it stopped the run.' }
let missing = 'read'
try {
  const folder: RunFolder = readRunFolder(join(process.cwd(), 'no-run-here'))
  missing = folder.source
} catch (error) {
  missing = error instanceof RunFolderReadError ? error.message : 'another error'
}

process.stdout.write(\`\${JSON.stringify({
  id,
  checks: Object.keys(checks),
  secret: read === undefined ? 'none' : 'read' in read ? 'function' : 'value',
  folder: [eventsFile, resultFile, logsFolder],
  missing: missing.replace(process.cwd(), '<project>'),
  typed: [record, shown, actual, observed, reading, query, enter, typeof pressTab, choices, delta, recorded, navigation, reason].length,
})}\\n\`)
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

const choicesTests = `import { expect, test } from '${packageName}'

test('chooses, ticks and scrolls', async ({ page }) => {
  await page.goto('/actions/choices')
  await page.getByLabel('Country').select('Canada')
  await page.getByLabel('Toppings').select(['Basil', { value: 'olives' }])
  await page.getByRole('checkbox', { name: 'Remember me' }).check()
  await page.getByLabel('Newsletter').check()
  await page.getByLabel('I agree').check()
  await page.getByLabel('I agree').uncheck()
  await expect(page.getByTestId('country-shown')).toHaveText('ca')
  await expect(page.getByTestId('toppings-shown')).toHaveText('olives,basil')
  await page.goto('/actions/scroll')
  await page.getByTestId('terms').scroll({ y: 2000 })
  await expect(page.getByTestId('accept-state')).toHaveText('enabled')
  await page.scroll({ y: 5000 })
  await expect(page.getByTestId('items-count')).toHaveText('30')
})
`

const mistakes = `import { test } from '${packageName}'

test('presses keys Retest does not send', async ({ page }) => {
  await page.getByLabel('Search').press('Entr')
  await page.keyboard.press('Ctrl+a')
})

test('chooses a number, and scrolls by nothing', async ({ page }) => {
  await page.getByLabel('Country').select(1)
  await page.scroll()
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

describe('milestone 3 package: wave 1', () => {
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
      'tests/choices.retest.ts': choicesTests,
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

  test('a consumer uses every new name, type-checks on TypeScript 6 and 7, and the calls the types refuse fail with their messages on both', async () => {
    const folder = await consumer()
    for (const [name, compiler] of Object.entries(compilers)) {
      assertSucceeded(await typecheck(compiler, folder), `${name} on the consumer`)
      const failed = await typecheck(compiler, folder, 'mistakes/tsconfig.json')
      assert.notEqual(failed.code, 0, `${name} accepted the mistakes`)
      const errors = failed.stdout.split('\n').filter((line) => line.includes('error TS'))
      assert.equal(errors.length, 4, `${name}:\n${failed.stdout}`)
      assert.match(errors[0] ?? '', /mistakes\.ts\(4,\d+\): error TS2345: .*RetestTypeError<"press\(\) takes a named key such as Enter or ArrowDown, one character, or modifiers and a key, such as Control\+A\.">/)
      assert.match(errors[1] ?? '', /mistakes\.ts\(5,\d+\): error TS2345: .*RetestTypeError<"press\(\) takes the modifiers Shift, Control, Alt, Meta or ControlOrMeta before a key\.">/)
      assert.match(errors[2] ?? '', /mistakes\.ts\(9,\d+\): error TS2345: Argument of type 'number' is not assignable to parameter of type '(OptionChoice \| readonly OptionChoice\[\]|readonly OptionChoice\[\] \| OptionChoice)'\./)
      assert.match(errors[3] ?? '', /mistakes\.ts\(10,\d+\): error TS2554: Expected 1-2 arguments, but got 0\./)
    }
    const ran = await runProgram(process.execPath, ['names.ts'], folder)
    assertSucceeded(ran, 'node names.ts')
    assert.deepEqual(JSON.parse(ran.stdout), {
      id: 'tests/checkout.retest.ts > checkout > places an order',
      checks: ['tests/checkout.retest.ts > checkout > places an order'],
      secret: 'function',
      folder: ['events.jsonl', 'result.json', 'logs'],
      missing: 'No run folder at <project>/no-run-here.',
      typed: 13,
    })
  })

  test('its installed command line presses keys, chooses, ticks and scrolls in the fixture', async (t) => {
    const app = await openApp(t)
    const folder = join(root, 'consumer')
    const run = await runRetest(t, { files: [], cwd: folder, browser: false, command: [join(folder, 'node_modules/.bin/retest')], env: { TASK_APP_URL: app.url } })
    assert.equal(run.exit.code, 0, run.stderr)
    assertStdoutIsEvents(run)
    assert.equal(testNamed(run, 'submits a search with Enter, and moves the focus with Tab and back').status, 'passed')
    assert.equal(testNamed(run, 'chooses, ticks and scrolls').status, 'passed')
    const completed = eventsOf(run.events, 'action.completed')
    assert.deepEqual(completed.filter((event) => event.command === 'press').map((event) => event.key), ['Enter', 'Tab', 'Shift+Tab'])
    assert.deepEqual(
      completed.filter((event) => ['select', 'check', 'uncheck', 'scroll'].includes(event.command)).map((event) => [event.command, event.input ?? event.via ?? event.scroll?.y ?? null]),
      [
        ['select', null],
        ['select', null],
        ['check', null],
        ['check', 'label'],
        ['check', null],
        ['uncheck', null],
        ['scroll', 2000],
        ['scroll', 5000],
      ],
    )
    assert.equal(app.searches(), 1)
    assert.equal(app.loads(), 1)
  })
})
