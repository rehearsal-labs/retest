import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { testTsconfigFile, testTsconfigSource } from '../../src/cli/init/templates.ts'
import { transformTypeScript } from '../../src/loader/transform.ts'
import { browserPath, openApp } from './browser-harness.ts'
import {
  assertSucceeded,
  childLog,
  compilers,
  installPacked,
  linkNodeTypes,
  onlyEvent,
  packRetest,
  repositoryRoot,
  resultOf,
  runCli,
  runProject,
  runRetest,
  testNamed,
  typecheck,
} from './cli-harness.ts'

// The consumer projects in fixtures/consumers, each copied outside this checkout and given the packed package, run as
// a project that installed Retest runs them: from the config in its folder, in real Chrome. This checks loading at run
// time; whether the declarations type-check is tests/types' job and the package smoke test's.

const fixtures = join(repositoryRoot, 'fixtures/consumers')
const names = ['everyday', 'plain', 'unsupported'] as const
// Loading a file in a fresh install compiles every module once, so collection gets more than the harness's budget.
const timeouts = 'collection=15000'

describe('consumer projects load through the packed package', () => {
  let root = ''
  const projects: Record<(typeof names)[number], string> = { everyday: '', plain: '', unsupported: '' }

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'retest-consumers-'))
    const packed = await packRetest(root)
    for (const name of names) {
      const project = join(root, name)
      await cp(join(fixtures, name), project, { recursive: true })
      await installPacked(project, packed)
      projects[name] = project
    }
    await linkNodeTypes(projects.everyday)
  })

  after(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true })
  })

  // The installed command line, so nothing from this checkout's source runs.
  const retest = (project: string): string[] => [join(project, 'node_modules/.bin/retest')]

  // A copy of the everyday project whose base tsconfig declares paths without baseUrl, sharing its installed packages.
  const typeScript7Variant = async (name = 'everyday-typescript-7'): Promise<string> => {
    const project = join(root, name)
    await cp(join(fixtures, 'everyday'), project, { recursive: true })
    await cp(join(fixtures, 'everyday/typescript-7/tsconfig.base.json'), join(project, 'tsconfig.base.json'))
    await symlink(join(projects.everyday, 'node_modules'), join(project, 'node_modules'), 'dir')
    return project
  }

  test('a project with path aliases, extends, enums, parameter properties, a namespace and extensionless imports passes', async (t) => {
    assert.ok(!projects.everyday.startsWith(repositoryRoot), 'the project lives outside the repository')
    const app = await openApp(t)
    const run = await runProject(t, projects.everyday, { files: ['tests/tasks.retest.ts'], timeouts, command: retest(projects.everyday), env: { TASK_APP_URL: app.url } })
    assert.equal(run.exit.code, 0, `${run.stdout}\n${run.stderr}`)
    assert.equal(testNamed(run, 'saves a task through a page object').status, 'passed')
    assert.equal(app.submissions(), 1)
    // The config took its budgets from an enum it imports through an alias.
    const { timeouts: budgets } = onlyEvent(run.events, 'run.started').options
    assert.deepEqual([budgets.action, budgets.assertion, budgets.test], [5000, 3000, 30_000])
  })

  test("a failed check and a thrown error name the TypeScript line, column and stack of the file they happened in", async (t) => {
    const app = await openApp(t)
    const run = await runProject(t, projects.everyday, { files: ['tests/locations.retest.ts'], timeouts, command: retest(projects.everyday), env: { TASK_APP_URL: app.url } })
    assert.equal(run.exit.code, 1, `${run.stdout}\n${run.stderr}`)
    const check = testNamed(run, 'a failed check names its TypeScript line')
    assert.deepEqual([check.status, check.failure?.class], ['failed', 'check_failed'])
    assert.deepEqual(check.failure?.location, await locate(projects.everyday, 'support/task-page.ts', 'toHaveText(title)'))
    const thrown = testNamed(run, 'a thrown error names its TypeScript line')
    assert.deepEqual([thrown.status, thrown.failure?.class, thrown.failure?.message], ['failed', 'test_error', 'Error: failed on purpose: broken'])
    const throwSite = await locate(projects.everyday, 'support/failures.ts', 'new Error(')
    assert.deepEqual(thrown.failure?.location, throwSite)
    const stack = childLog(run, 'tests/locations.retest.ts')
    assert.match(stack, new RegExp(`at Thrower\\.fail \\(\\S*/support/failures\\.ts:${throwSite.line}:${throwSite.column}\\)`), stack)
    // Both lines sit elsewhere in what Node ran, so the locations above are the source map's work, not the transformer's.
    assert.notEqual(await transformedLine(projects.everyday, 'support/task-page.ts', 'toHaveText(title)'), check.failure?.location?.line)
    assert.notEqual(await transformedLine(projects.everyday, 'support/failures.ts', 'new Error('), throwSite.line)
  })

  test('the project, with baseUrl, type-checks with TypeScript 6, which still reads baseUrl: the loader runs it, tsc checks it', async () => {
    assertSucceeded(await typecheck(compiler('TypeScript 6'), projects.everyday), 'TypeScript 6 on fixtures/consumers/everyday')
  })

  test('the project with paths and no baseUrl passes in Chrome and type-checks with TypeScript 6 and 7', async (t) => {
    const project = await typeScript7Variant()
    const app = await openApp(t)
    const run = await runProject(t, project, { files: ['tests/tasks.retest.ts'], timeouts, command: retest(projects.everyday), env: { TASK_APP_URL: app.url } })
    assert.equal(run.exit.code, 0, `${run.stdout}\n${run.stderr}`)
    assert.equal(testNamed(run, 'saves a task through a page object').status, 'passed')
    for (const name of ['TypeScript 6', 'TypeScript 7']) assertSucceeded(await typecheck(compiler(name), project), `${name} on the paths-only variant`)
  })

  test("init's tests tsconfig passes the project's constructs on TypeScript 6 and 7, Retest reads it, and it refuses a JSX file", async (t) => {
    const project = await typeScript7Variant('init-tsconfig')
    await writeFile(join(project, testTsconfigFile), testTsconfigSource('../tsconfig.json'))
    for (const name of ['TypeScript 6', 'TypeScript 7']) assertSucceeded(await typecheck(compiler(name), project, testTsconfigFile), `${name} on ${testTsconfigFile}`)
    const listed = await runCli(t, ['list', 'tests/tasks.retest.ts', '--json'], { cwd: project, command: retest(projects.everyday) })
    assert.equal(listed.exit.code, 0, `the loader resolves the aliases through ${testTsconfigFile}: ${listed.stderr}`)
    await writeFile(join(project, 'tests/view.tsx'), 'export const view = <p>Release checklist</p>\n')
    for (const name of ['TypeScript 6', 'TypeScript 7']) {
      const refused = await typecheck(compiler(name), project, testTsconfigFile)
      assert.notEqual(refused.code, 0, `${name} accepted a JSX file`)
      assert.match(refused.stdout, /tests\/view\.tsx\(1,21\): error TS17004: Cannot use JSX unless the '--jsx' flag is provided\./)
    }
  })

  test('a plain project with no tsconfig, erasable TypeScript and a JavaScript helper passes', async (t) => {
    const app = await openApp(t)
    const run = await runProject(t, projects.plain, { timeouts, command: retest(projects.plain), env: { TASK_APP_URL: app.url } })
    assert.equal(run.exit.code, 0, `${run.stdout}\n${run.stderr}`)
    assert.equal(testNamed(run, 'saves a task').status, 'passed')
    assert.equal(app.submissions(), 1)
  })

  test('each unsupported module format and syntax fails to load, naming the construct and the file', async (t) => {
    const app = await openApp(t)
    const run = await runProject(t, projects.unsupported, { timeouts, command: retest(projects.unsupported), env: { TASK_APP_URL: app.url } })
    assert.equal(run.exit.code, 2, `${run.stdout}\n${run.stderr}`)
    const failures = new Map(resultOf(run).files.map((file) => [file.file, [file.collection, file.failure?.class, file.failure?.message ?? '']] as const))
    const expected: Record<string, RegExp> = {
      'commonjs/suite.retest.ts': /commonjs\/suite\.retest\.ts uses require\(\), so Node loads it as CommonJS\. Retest loads test files, the config and TypeScript as ES modules/,
      'tests/commonjs-helper.retest.ts': /support\/legacy\.cts uses the \.cts extension, so Node loads it as CommonJS\./,
      'tests/decorator.retest.ts': /SyntaxError: Invalid or unexpected token\. support\/decorated\.ts:6 has a decorator, which may be the cause: Node cannot run decorators, and Retest does not transform them\./,
      'tests/jsx-extensionless.retest.ts': /\.\.\/support\/view names support\/view\.tsx, a \.tsx file\. Retest does not load JSX\./,
      'tests/jsx-helper.retest.ts': /support\/view\.tsx is a \.tsx file\. Retest does not load JSX\./,
      'tests/markup-in-typescript.retest.ts': /SyntaxError: Node's TypeScript transformer cannot read support\/markup\.ts:2: Expression expected\./,
      'tests/type-import.retest.ts': /does not provide an export named 'Title'\. support\/types\.ts declares Title only as a type: import it with import type\./,
    }
    assert.deepEqual([...failures.keys()].sort(), Object.keys(expected).sort())
    for (const [file, pattern] of Object.entries(expected)) {
      const [collection, failureClass, message] = failures.get(file) ?? []
      assert.deepEqual([collection, failureClass], ['failed', 'collection_failed'], file)
      assert.match(message ?? '', pattern, file)
    }
    assert.equal(app.submissions(), 0)
  })

  test('a tsconfig.json that cannot be read stops the config, and a run without one, naming the file', async (t) => {
    const project = join(root, 'broken-tsconfig')
    await cp(join(fixtures, 'plain'), project, { recursive: true })
    await symlink(join(projects.plain, 'node_modules'), join(project, 'node_modules'), 'dir')
    await writeFile(join(project, 'tsconfig.json'), '{\n  "compilerOptions": {\n    "paths": { "@support/*": ["support/*"] \n}\n')
    const app = await openApp(t)
    const withConfig = await runRetest(t, { files: [], browser: false, cwd: project, timeouts, command: retest(projects.plain), env: { TASK_APP_URL: app.url } })
    assert.equal(withConfig.exit.code, 2, withConfig.stderr)
    assert.match(withConfig.stderr, tsconfigProblem(project))

    await rm(join(project, 'retest.config.ts'))
    const withoutConfig = await runRetest(t, { files: ['tests/tasks.retest.ts'], baseUrl: app.url, browser: browserPath(), cwd: project, timeouts, command: retest(projects.plain) })
    assert.equal(withoutConfig.exit.code, 2, withoutConfig.stderr)
    const [file] = resultOf(withoutConfig).files
    assert.deepEqual([file?.collection, file?.failure?.class], ['failed', 'usage'])
    assert.match(file?.failure?.message ?? '', tsconfigProblem(project))
    assert.equal(app.submissions(), 0)
  })
})

function compiler(name: string): string {
  const path = compilers[name]
  assert.ok(path !== undefined, `the harness knows ${name}`)
  return path
}

// The line the first match of `text` sits on in what Node runs, once the file's types are stripped or transformed.
async function transformedLine(project: string, file: string, text: string): Promise<number> {
  const source = await readFile(join(project, file), 'utf8')
  return transformTypeScript(source, `file:///${file}`, file).split('\n').findIndex((line) => line.includes(text)) + 1
}

// Where the first match of `text` sits in a fixture file, as Retest names a location: 1-based line and column.
async function locate(project: string, file: string, text: string): Promise<{ file: string; line: number; column: number }> {
  const lines = (await readFile(join(project, file), 'utf8')).split('\n')
  const index = lines.findIndex((line) => line.includes(text))
  assert.ok(index !== -1, `${file} holds ${text}`)
  return { file, line: index + 1, column: (lines[index] ?? '').indexOf(text) + 1 }
}

// Retest names the tsconfig by its real path, as Node names modules.
function tsconfigProblem(project: string): RegExp {
  return new RegExp(`${escape(join(realpathSync(project), 'tsconfig.json'))} is not valid JSON: `)
}

function escape(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
