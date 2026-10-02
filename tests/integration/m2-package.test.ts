import type { Packed } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { TASK_APP_PASSWORD } from '../../fixtures/task-app/sign-in.ts'
import { openApp } from './browser-harness.ts'
import {
  assertReleased,
  assertStdoutIsEvents,
  assertSucceeded,
  compilers,
  eventsOf,
  filesHolding,
  installPacked,
  linkNodeTypes,
  packRetest,
  readFinishedRun,
  repositoryRoot,
  resultOf,
  RetestProcess,
  runProgram,
  runRetest,
  testNamed,
  typecheck,
  writeFiles,
} from './cli-harness.ts'

// Acceptance checks 12 and 15, on the packed tarball installed offline into projects outside the repository:
// `retest init` writes a project that type-checks and runs, and a consumer with a registered config type-checks
// on TypeScript 6 and 7, runs from the command line, and runs from the runner and protocol subpaths.

const packageName = '@rehearsal-labs/retest'

/** Every file of a project but its installed packages, with its contents, to tell whether anything changed. */
function snapshot(root: string): Record<string, string> {
  const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
  const kept = files.map((entry) => relative(root, join(entry.parentPath, entry.name))).filter((path) => !path.startsWith('node_modules'))
  return Object.fromEntries(kept.sort().map((path) => [path, readFileSync(join(root, path), 'utf8')]))
}

const consumerConfig = `import { chrome, defineConfig, env } from '${packageName}'

const baseUrl = process.env['TASK_APP_URL'] ?? 'http://127.0.0.1:4173'

const config = defineConfig({
  apps: { web: chrome({ baseUrl }), admin: chrome({ baseUrl }) },
  defaultApp: 'web',
  secrets: { password: env('TASK_APP_PASSWORD') },
  tags: ['smoke'],
  states: ['signed-in'],
})

export default config

declare module '${packageName}' {
  interface Register {
    config: typeof config
  }
}
`

const signInTests = `import { expect, secret, test } from '${packageName}'

test.setup('signed-in', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('User name').fill('alice')
  await page.getByLabel('Password').fill(secret('password'))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByTestId('account')).toHaveText('Signed in as alice')
})

test('starts signed in', { state: 'signed-in', tags: ['smoke'] }, async ({ page }) => {
  await page.goto('/account')
  await expect(page.getByTestId('account')).toHaveText('Signed in as alice')
})
`

const roleTests = `import { expect, test } from '${packageName}'

test('keeps each role apart', { apps: ['web', 'admin'], state: { web: 'signed-in' } }, async ({ web, admin }) => {
  await web.goto('/account')
  await admin.goto('/account')
  await expect(web.getByTestId('account')).toHaveText('Signed in as alice')
  await expect(admin.getByTestId('account')).toHaveText('Signed out')
})
`

// A service such as Rehearsal runs tests with a config it holds in memory and secrets it reads itself.
const programmaticRun = `import type { Reporter, RunOptions } from '${packageName}/runner'
import type { RetestEvent } from '${packageName}/protocol'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chrome, defineConfig } from '${packageName}'
import { eventSchemaUrl, parse, resultSchemaUrl, retestEventSchema, runResultSchema } from '${packageName}/protocol'
import { runFiles, validateConfig } from '${packageName}/runner'

const [baseUrl = '', outputDir = ''] = process.argv.slice(2)
let reads = 0
const password = async (): Promise<string> => {
  reads += 1
  const value = process.env['VAULT_PASSWORD']
  if (value === undefined) throw new Error('the vault has no password')
  return value
}

const loaded = validateConfig(defineConfig({ apps: { web: chrome({ baseUrl }) }, secrets: { password } }), fileURLToPath(new URL('in-memory.config.ts', import.meta.url)))
if (!loaded.ok) throw new Error(loaded.failure.message)

const events: RetestEvent[] = []
const reporter: Reporter = {
  name: 'collector',
  onEvent: (event) => {
    events.push(event)
  },
  onRunEnd: () => undefined,
}
const options: RunOptions = {
  files: ['tests/sign-in.retest.ts'],
  rootDir: process.cwd(),
  apps: { kind: 'config', config: loaded.config, secrets: new Map([['password', { read: password }]]) },
  timeouts: { collection: 5000, setup: 15_000, action: 2000, navigation: 5000, assertion: 2000, test: 15_000, cleanup: 5000 },
  outputDir,
  headless: true,
  signal: new AbortController().signal,
}
const result = await runFiles(options, [reporter])
const summary = {
  status: result.status,
  exitCode: result.exitCode,
  reads,
  events: events.length,
  invalidEvents: events.filter((event) => !parse(retestEventSchema, event).ok).length,
  validResult: parse(runResultSchema, result).ok,
  schemaFiles: [eventSchemaUrl, resultSchemaUrl].map((url) => existsSync(fileURLToPath(url))),
}
process.stderr.write(\`summary \${JSON.stringify(summary)}\\n\`)
`

const mistakes = `import { secret, test } from '${packageName}'

test('uses an app the config does not have', { apps: ['desktop'] }, async () => {})

test('types a secret the config does not have', async ({ page }) => {
  await page.getByLabel('Password').fill(secret('pasword'))
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
  include: ['retest.config.ts', 'tests', 'run-programmatically.ts'],
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

describe('milestone 2 package: init and a registered consumer', () => {
  let root = ''
  let packed: Packed | undefined

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'retest-package-'))
    packed = await packRetest(root)
  })

  after(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true })
  })

  async function project(name: string, files: Record<string, string>): Promise<string> {
    assert.ok(packed !== undefined, 'the package was packed')
    const folder = join(root, name)
    await mkdir(folder)
    await writeFiles(folder, { 'package.json': json({ name: `retest-${name}`, private: true, type: 'module' }), ...files })
    await installPacked(folder, packed)
    await linkNodeTypes(folder)
    assert.ok(!folder.startsWith(repositoryRoot), 'the project lives outside the repository')
    return folder
  }

  test('the package exports its runner and protocol subpaths, each with its source, types and build', async () => {
    const consumer = await project('exports', {})
    const manifest: unknown = JSON.parse(await readFile(join(consumer, 'node_modules', packageName, 'package.json'), 'utf8'))
    assert.ok(typeof manifest === 'object' && manifest !== null && 'exports' in manifest)
    const { exports } = manifest
    assert.ok(typeof exports === 'object' && exports !== null)
    assert.deepEqual(Object.keys(exports), ['.', './runner', './protocol', './playwright', './package.json'])
    for (const subpath of ['.', './runner', './protocol', './playwright']) {
      const entries: unknown = Reflect.get(exports, subpath)
      assert.ok(typeof entries === 'object' && entries !== null, subpath)
      assert.deepEqual(Object.keys(entries), ['retest-source', 'types', 'default'], subpath)
    }
  })

  test('init --yes in an empty folder writes the config, an example, a tsconfig, package.json and .gitignore', async () => {
    const tools = await project('tools', {})
    const empty = join(root, 'empty')
    await mkdir(empty)
    const init = await runProgram(join(tools, 'node_modules/.bin/retest'), ['init', '--yes'], empty, { ...process.env, NO_COLOR: '1' })
    assertSucceeded(init, 'retest init --yes')
    assert.deepEqual(Object.keys(snapshot(empty)), ['.gitignore', 'package.json', 'retest.config.ts', 'tests/example.retest.ts', 'tsconfig.retest.json'])
    const written: unknown = JSON.parse(readFileSync(join(empty, 'package.json'), 'utf8'))
    assert.deepEqual(written, {
      private: true,
      type: 'module',
      scripts: { 'test:e2e': 'retest run', 'typecheck:e2e': 'tsc --noEmit -p tsconfig.retest.json' },
    })
    assert.equal(readFileSync(join(empty, '.gitignore'), 'utf8'), '.retest/\n')
    assert.match(readFileSync(join(empty, 'retest.config.ts'), 'utf8'), /declare module '@rehearsal-labs\/retest' \{\n {2}interface Register \{\n {4}config: typeof config/)
    assert.match(init.stdout, /npm i -D @rehearsal-labs\/retest typescript @types\/node/)
  })

  test('init --yes --ci github writes a project that type-checks on TypeScript 6 and 7 and runs its example, and a second init changes nothing', async (t) => {
    const app = await openApp(t)
    const initialized = await project('initialized', {})
    const bin = join(initialized, 'node_modules/.bin/retest')
    const first = await runProgram(bin, ['init', '--yes', '--ci', 'github'], initialized, { ...process.env, NO_COLOR: '1' })
    assertSucceeded(first, 'retest init --yes --ci github')
    for (const path of ['retest.config.ts', 'tests/example.retest.ts', 'tsconfig.retest.json', '.github/workflows/retest.yml', '.gitignore']) {
      assert.match(first.stdout, new RegExp(`created +${path.replaceAll('.', '\\.')}`), `init created ${path}:\n${first.stdout}`)
    }
    assert.match(first.stdout, /updated +package\.json +scripts: "test:e2e", "typecheck:e2e"/)
    const workflow = readFileSync(join(initialized, '.github/workflows/retest.yml'), 'utf8')
    assert.match(workflow, /run: npm run typecheck:e2e\n.*run: npm run test:e2e/s)
    const config = readFileSync(join(initialized, 'retest.config.ts'), 'utf8')
    assert.match(config, /web: chrome\(\{\n {6}baseUrl: 'http:\/\/localhost:3000',/, 'the default browser is the Chrome installed here')

    const written = snapshot(initialized)
    const second = await runProgram(bin, ['init', '--yes', '--ci', 'github'], initialized, { ...process.env, NO_COLOR: '1' })
    assertSucceeded(second, 'a second retest init')
    assert.deepEqual(snapshot(initialized), written, 'the second init changed no file')
    assert.doesNotMatch(second.stdout, /created|updated/)
    assert.equal(second.stdout.match(/left as is/g)?.length, 6, second.stdout)

    for (const [name, compiler] of Object.entries(compilers)) {
      assertSucceeded(await typecheck(compiler, initialized, 'tsconfig.retest.json'), `${name} on the project init wrote`)
    }
    const run = await runRetest(t, { files: [], cwd: initialized, browser: false, command: [bin], baseUrl: app.url })
    assert.equal(run.exit.code, 0, run.stderr)
    assertStdoutIsEvents(run)
    assert.equal(testNamed(run, 'shows the home page').status, 'passed')
  })

  test('a consumer with a registered config type-checks on TypeScript 6 and 7, and each mistake gives its message', async () => {
    const consumer = await project('consumer', {
      'retest.config.ts': consumerConfig,
      'tests/sign-in.retest.ts': signInTests,
      'tests/roles.retest.ts': roleTests,
      'run-programmatically.ts': programmaticRun,
      'tsconfig.json': json(consumerTsconfig),
      'mistakes/mistakes.ts': mistakes,
      'mistakes/tsconfig.json': json({ extends: '../tsconfig.json', include: ['../retest.config.ts', 'mistakes.ts'] }),
    })
    for (const [name, compiler] of Object.entries(compilers)) {
      assertSucceeded(await typecheck(compiler, consumer), `${name} on the consumer`)
      const failed = await typecheck(compiler, consumer, 'mistakes/tsconfig.json')
      assert.notEqual(failed.code, 0, `${name} accepted the mistakes`)
      const errors = failed.stdout.split('\n').filter((line) => line.includes('error TS'))
      assert.equal(errors.length, 2, `${name}:\n${failed.stdout}`)
      // The compilers may list a union in either order.
      assert.match(errors[0] ?? '', /mistakes\.ts\(3,\d+\): error TS2322: Type '"desktop"' is not assignable to type '("web" \| "admin"|"admin" \| "web")'/)
      assert.match(errors[1] ?? '', /mistakes\.ts\(6,\d+\): error TS2345: Argument of type '"pasword"' is not assignable to parameter of type '"password"'/)
    }
  })

  test('the consumer runs from its installed command line against the fixture', async (t) => {
    const app = await openApp(t)
    const consumer = join(root, 'consumer')
    const run = await runRetest(t, {
      files: [],
      cwd: consumer,
      browser: false,
      command: [join(consumer, 'node_modules/.bin/retest')],
      env: { TASK_APP_URL: app.url, TASK_APP_PASSWORD },
    })
    assert.equal(run.exit.code, 0, run.stderr)
    assertStdoutIsEvents(run)
    assert.deepEqual(
      resultOf(run).files.flatMap((file) => file.tests.map((each) => [each.name, each.status])),
      [
        ['keeps each role apart', 'passed'],
        ['signed-in', 'passed'],
        ['starts signed in', 'passed'],
      ],
    )
    assert.deepEqual(filesHolding(run.output, TASK_APP_PASSWORD), [])
  })

  test('runFiles from the runner subpath runs an in-memory config whose secret comes from a function', async (t) => {
    const app = await openApp(t)
    const consumer = join(root, 'consumer')
    const output = join(root, 'programmatic-run')
    const retest = await RetestProcess.start(t, {
      command: [process.execPath],
      args: ['run-programmatically.ts', app.url, output],
      cwd: consumer,
      env: { VAULT_PASSWORD: TASK_APP_PASSWORD },
    })
    const run = await readFinishedRun({ retest, output })
    await assertReleased(retest, run.events, output)
    assert.equal(run.exit.code, 0, run.stderr)
    const summary: unknown = JSON.parse(/^summary (.+)$/m.exec(run.stderr)?.[1] ?? 'null')
    assert.deepEqual(summary, {
      status: 'passed',
      exitCode: 0,
      reads: 1,
      events: run.events.length,
      invalidEvents: 0,
      validResult: true,
      schemaFiles: [true, true],
    })
    assert.deepEqual(
      resultOf(run).files.flatMap((file) => file.tests.map((each) => [each.name, each.status])),
      [
        ['signed-in', 'passed'],
        ['starts signed in', 'passed'],
      ],
    )
    const fill = eventsOf(run.events, 'action.completed').find((event) => event.secret === 'password')
    assert.ok(fill !== undefined && fill.valueLength === undefined, 'the fill names its secret')
    assert.deepEqual(filesHolding(output, TASK_APP_PASSWORD), [], 'the value is nowhere in the run folder')
  })
})
