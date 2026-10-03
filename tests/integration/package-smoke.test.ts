import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { openApp } from './browser-harness.ts'
import {
  assertSucceeded,
  compilers,
  exampleFile,
  installPacked,
  onlyTest,
  repositoryRoot,
  resultOf,
  runProgram,
  runRetest,
  typecheck,
  packRetest,
} from './cli-harness.ts'

const packageName = '@rehearsal-labs/retest'

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

describe('package smoke test', () => {
  let root = ''
  let consumer = ''
  let published: string[] = []

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'retest-package-'))
    consumer = join(root, 'consumer')
    await mkdir(join(consumer, 'tests'), { recursive: true })
    const packed = await packRetest(root)
    const listing = await runProgram('tar', ['-tzf', packed.tarball], root)
    assertSucceeded(listing, 'tar -tzf')
    published = listing.stdout.split('\n').filter((line) => line !== '').map((line) => line.replace(/^package\//, ''))

    await writeFile(join(consumer, 'package.json'), `${JSON.stringify({ name: 'retest-consumer', private: true, type: 'module' })}\n`)
    await installPacked(consumer, packed)
    await writeFile(join(consumer, 'tsconfig.json'), `${JSON.stringify(consumerConfig, null, 2)}\n`)
    await copyFile(join(repositoryRoot, exampleFile), join(consumer, 'tests/task.retest.ts'))
  })

  after(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true })
  })

  test('the tarball holds built JavaScript with declarations, the license and the readme, and no source', () => {
    assert.ok(!consumer.startsWith(repositoryRoot), 'the consumer lives outside the repository')
    const outside = published.filter((path) => !path.startsWith('dist/'))
    assert.deepEqual(outside.sort(), ['LICENSE', 'README.md', 'package.json'])
    assert.deepEqual(
      published.filter((path) => path.endsWith('.ts') && !path.endsWith('.d.ts')),
      [],
      'no TypeScript source is published',
    )
    for (const path of ['dist/index.js', 'dist/index.d.ts', 'dist/cli/main.js', 'dist/runner/child.js']) {
      assert.ok(published.includes(path), `${path} is published`)
    }
    for (const path of published.filter((file) => file.endsWith('.js'))) {
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
    for (const key of ['dependencies', 'optionalDependencies']) {
      assert.equal(Object.hasOwn(manifest, key), false, `the package declares no ${key}`)
    }
    // The AI SDK adapter's packages are peers a project installs only to use that adapter: each is optional, so
    // installing Retest installs none of them, as the listing above shows.
    const peers: unknown = Reflect.get(manifest, 'peerDependencies')
    const meta: unknown = Reflect.get(manifest, 'peerDependenciesMeta')
    assert.ok(typeof peers === 'object' && peers !== null && typeof meta === 'object' && meta !== null)
    assert.deepEqual(Object.keys(peers).sort(), ['@ai-sdk/anthropic', '@ai-sdk/openai', 'ai'])
    for (const name of Object.keys(peers)) assert.deepEqual(Reflect.get(meta, name), { optional: true }, `${name} is an optional peer`)
  })

  for (const [name, compiler] of Object.entries(compilers)) {
    test(`a test importing ${packageName} by name typechecks with ${name} against the installed declarations`, async () => {
      assertSucceeded(await typecheck(compiler, consumer), `${name} on the example`)
      const misuseFolder = join(consumer, 'misuse')
      await mkdir(misuseFolder, { recursive: true })
      await writeFile(join(misuseFolder, 'value-matcher.ts'), misuse)
      await writeFile(join(misuseFolder, 'tsconfig.json'), `${JSON.stringify({ extends: '../tsconfig.json', include: ['.'] })}\n`)
      const failed = await typecheck(compiler, consumer, 'misuse/tsconfig.json')
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
