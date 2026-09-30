import type { ExecFileException } from 'node:child_process'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { openApp } from './browser-harness.ts'
import { exampleFile, onlyTest, repositoryRoot, resultOf, runRetest } from './cli-harness.ts'

type Command = { code: number; stdout: string; stderr: string }

const packageName = '@rehearsal-labs/retest'
const compilers = {
  'TypeScript 6': join(repositoryRoot, 'node_modules/typescript/bin/tsc'),
  'TypeScript 7': join(repositoryRoot, 'node_modules/typescript-7/bin/tsc'),
}

const consumerConfig = {
  compilerOptions: {
    target: 'es2024',
    lib: ['es2024'],
    module: 'nodenext',
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    types: [],
  },
  include: ['tests'],
}

// Calling a value matcher on a locator must stay a compile error in the published declarations.
const misuse = `import { expect, test } from '${packageName}'

test('checks a locator like a value', async ({ page }) => {
  expect(page.getByTestId('saved-task')).toBe('Release checklist')
})
`

function command(file: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<Command> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (error: ExecFileException | null, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
      resolve({ code, stdout, stderr })
    })
  })
}

function assertSucceeded(result: Command, what: string): void {
  assert.equal(result.code, 0, `${what} failed:\n${result.stdout}\n${result.stderr}`)
}

describe('package smoke test', () => {
  let root = ''
  let consumer = ''
  let packed: string[] = []

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'retest-package-'))
    consumer = join(root, 'consumer')
    const pack = join(root, 'pack')
    await Promise.all([mkdir(join(consumer, 'tests'), { recursive: true }), mkdir(pack)])
    // A cache of its own keeps the offline install away from the person's npm cache.
    const npmEnv = { ...process.env, npm_config_cache: join(root, 'npm-cache'), npm_config_update_notifier: 'false' }

    assertSucceeded(await command('npm', ['run', 'build'], repositoryRoot, npmEnv), 'npm run build')
    assertSucceeded(await command('npm', ['pack', '--pack-destination', pack], repositoryRoot, npmEnv), 'npm pack')
    const [tarball, ...others] = readdirSync(pack)
    assert.ok(tarball !== undefined && others.length === 0, 'npm pack made one tarball')
    const listing = await command('tar', ['-tzf', join(pack, tarball)], root)
    assertSucceeded(listing, 'tar -tzf')
    packed = listing.stdout.split('\n').filter((line) => line !== '').map((line) => line.replace(/^package\//, ''))

    await writeFile(join(consumer, 'package.json'), `${JSON.stringify({ name: 'retest-consumer', private: true, type: 'module' })}\n`)
    const install = ['install', '--offline', '--no-audit', '--no-fund', join(pack, tarball)]
    assertSucceeded(await command('npm', install, consumer, npmEnv), 'npm install --offline')
    await writeFile(join(consumer, 'tsconfig.json'), `${JSON.stringify(consumerConfig, null, 2)}\n`)
    await copyFile(join(repositoryRoot, exampleFile), join(consumer, 'tests/task.retest.ts'))
  })

  after(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true })
  })

  test('the tarball holds built JavaScript with declarations, the license and the readme, and no source', () => {
    assert.ok(!consumer.startsWith(repositoryRoot), 'the consumer lives outside the repository')
    const outside = packed.filter((path) => !path.startsWith('dist/'))
    assert.deepEqual(outside.sort(), ['LICENSE', 'README.md', 'package.json'])
    assert.deepEqual(
      packed.filter((path) => path.endsWith('.ts') && !path.endsWith('.d.ts')),
      [],
      'no TypeScript source is published',
    )
    for (const path of ['dist/index.js', 'dist/index.d.ts', 'dist/cli/main.js', 'dist/runner/child.js']) {
      assert.ok(packed.includes(path), `${path} is published`)
    }
    for (const path of packed.filter((file) => file.endsWith('.js'))) {
      const source = join(repositoryRoot, 'src', path.slice('dist/'.length).replace(/\.js$/, '.ts'))
      assert.ok(existsSync(source), `${path} is built from a source file that still exists`)
    }
  })

  test('installing it adds no other package', async () => {
    assert.deepEqual(readdirSync(join(consumer, 'node_modules/@rehearsal-labs')), ['retest'])
    const installed = readdirSync(join(consumer, 'node_modules')).filter((name) => !name.startsWith('.'))
    assert.deepEqual(installed, ['@rehearsal-labs'])
    const manifest: unknown = JSON.parse(await readFile(join(consumer, 'node_modules', packageName, 'package.json'), 'utf8'))
    assert.ok(typeof manifest === 'object' && manifest !== null)
    for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      assert.equal(Object.hasOwn(manifest, key), false, `the package declares no ${key}`)
    }
  })

  for (const [name, compiler] of Object.entries(compilers)) {
    test(`a test importing ${packageName} by name typechecks with ${name} against the installed declarations`, async () => {
      assertSucceeded(await command(process.execPath, [compiler, '-p', 'tsconfig.json'], consumer), `${name} on the example`)
      const misuseFolder = join(consumer, 'misuse')
      await mkdir(misuseFolder, { recursive: true })
      await writeFile(join(misuseFolder, 'value-matcher.ts'), misuse)
      await writeFile(join(misuseFolder, 'tsconfig.json'), `${JSON.stringify({ extends: '../tsconfig.json', include: ['.'] })}\n`)
      const failed = await command(process.execPath, [compiler, '-p', 'misuse/tsconfig.json'], consumer)
      assert.notEqual(failed.code, 0, `${name} accepted a value matcher on a locator`)
      assert.match(failed.stdout, /toBe is for values\. Use toHaveText or toBeVisible on a locator\./)
    })
  }

  test('the installed retest runs the example against the working app and exits 0', async (t) => {
    const app = await openApp(t)
    const run = await runRetest(t, {
      files: ['tests/task.retest.ts'],
      baseUrl: app.url,
      cwd: consumer,
      command: [join(consumer, 'node_modules/.bin/retest')],
    })
    assert.equal(run.exit.code, 0, run.stderr)
    assert.equal(onlyTest(run).status, 'passed')
    assert.equal(resultOf(run).files[0]?.file, 'tests/task.retest.ts')
    assert.equal(app.submissions(), 1)
  })

  test('the installed retest fails the example against the broken app and exits 1', async (t) => {
    const app = await openApp(t, { mode: 'broken' })
    const run = await runRetest(t, {
      files: ['tests/task.retest.ts'],
      baseUrl: app.url,
      cwd: consumer,
      command: [join(consumer, 'node_modules/.bin/retest')],
    })
    assert.equal(run.exit.code, 1, run.stderr)
    const failed = onlyTest(run)
    assert.deepEqual([failed.status, failed.failure?.class], ['failed', 'check_failed'])
    assert.equal(failed.evidence.length, 1)
  })
})
