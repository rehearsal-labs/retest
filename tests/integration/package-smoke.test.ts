import type { Packed } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { retestVersion } from '../../src/version.ts'
import { npmCommand } from '../support/npm-command.ts'
import { openApp } from './browser-harness.ts'
import {
  assertSucceeded,
  compilers,
  exampleFile,
  installedRetest,
  installPacked,
  onlyTest,
  repositoryRoot,
  resultOf,
  runProgram,
  runRetest,
  typecheck,
  packRetest,
} from './cli-harness.ts'

const packageName = 'retest'

// The name Retest was published under up to 0.5.2, as a registry address writes it, and as npm named its tarball.
const formerNames = ['@rehearsal-labs/retest', '@rehearsal-labs%2Fretest', 'rehearsal-labs-retest']

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

// The tar that reads the tarball. On Windows it is the system's own, which ends its lines with CRLF: a Git shell, as a CI
// step is, puts GNU tar first on PATH, and GNU tar reads the drive in a path such as D:\a as a remote host's name.
const tar = process.platform === 'win32' ? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'

/**
 * How npx starts: from PATH on macOS and Linux. On Windows npx is a batch file, as npm is, so npx's own script runs, the
 * one beside npm's.
 */
function npxCommand(env: NodeJS.ProcessEnv): [string, ...string[]] {
  const [npm, script] = npmCommand(env)
  return script === undefined ? ['npx'] : [npm, join(dirname(script), 'npx-cli.js')]
}

describe('package smoke test', () => {
  let root = ''
  let consumer = ''
  let published: string[] = []
  let packed: Packed | undefined

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'retest-package-'))
    consumer = join(root, 'consumer')
    await mkdir(join(consumer, 'tests'), { recursive: true })
    packed = await packRetest(root)
    const listing = await runProgram(tar, ['-tzf', packed.tarball], root)
    assertSucceeded(listing, 'tar -tzf')
    published = listing.stdout.split(/\r?\n/).filter((line) => line !== '').map((line) => line.replace(/^package\//, ''))

    await writeFile(join(consumer, 'package.json'), `${JSON.stringify({ name: 'retest-consumer', private: true, type: 'module' })}\n`)
    await installPacked(consumer, packed)
    await writeFile(join(consumer, 'tsconfig.json'), `${JSON.stringify(consumerConfig, null, 2)}\n`)
    await copyFile(join(repositoryRoot, exampleFile), join(consumer, 'tests/task.retest.ts'))
  })

  after(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true })
  })

  test('the tarball holds built JavaScript, declarations, the media crate and notices, and no TypeScript source', () => {
    assert.ok(!consumer.startsWith(repositoryRoot), 'the consumer lives outside the repository')
    const outside = published.filter((path) => !path.startsWith('dist/'))
    assert.deepEqual(outside.sort(), [
      'LICENSE',
      'README.md',
      'media/Cargo.lock',
      'media/Cargo.toml',
      'media/build.rs',
      'media/src/allocations.rs',
      'media/src/encoder.rs',
      'media/src/frame.rs',
      'media/src/jobs.rs',
      'media/src/ledger.rs',
      'media/src/live.rs',
      'media/src/main.rs',
      'media/src/place.rs',
      'media/src/process_ownership.rs',
      'media/src/process_ownership_windows.rs',
      'media/src/protocol.rs',
      'media/src/queue.rs',
      'media/src/recording.rs',
      'media/src/replies.rs',
      'media/src/server.rs',
      'media/src/store.rs',
      'media/src/timeline.rs',
      'package.json',
      'src/cli/install/licences/webkit/ANGLE-LICENSE.txt',
      'src/cli/install/licences/webkit/BoringSSL-LICENSE.txt',
      'src/cli/install/licences/webkit/SOURCE.txt',
      'src/cli/install/licences/webkit/WebKit-BSD-2-Clause.txt',
      'src/cli/install/licences/webkit/WebKit-LGPL-2.1.txt',
      'src/cli/install/licences/webkit/WebRTC-LICENSE.txt',
      'src/cli/install/licences/webkit/abseil-cpp-LICENSE.txt',
      'src/cli/install/licences/webkit/libvpx-LICENSE.txt',
      'src/cli/install/licences/webkit/swiftCompatibilitySpan-LICENSE.txt',
      'src/cli/install/media-notices.txt',
      'supervisor/Cargo.lock',
      'supervisor/Cargo.toml',
      'supervisor/NOTICES',
      'supervisor/build.rs',
      'supervisor/src/command.rs',
      'supervisor/src/jobs.rs',
      'supervisor/src/main.rs',
      'supervisor/src/reply.rs',
    ])
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

  test('npm pack names the tarball retest with its version, and the manifest in it names retest', async () => {
    assert.ok(packed !== undefined, 'the package was packed')
    assert.equal(basename(packed.tarball), `retest-${retestVersion}.tgz`)
    const manifest = await runProgram(tar, ['-xzOf', packed.tarball, 'package/package.json'], root)
    assertSucceeded(manifest, 'tar -xzOf package/package.json')
    const read: unknown = JSON.parse(manifest.stdout)
    assert.ok(typeof read === 'object' && read !== null && 'name' in read, manifest.stdout)
    assert.equal(read.name, 'retest')
  })

  test('no file of the package holds the name it had before', () => {
    const installed = join(consumer, 'node_modules', packageName)
    assert.ok(published.includes('dist/index.js') && published.includes('package.json'), 'the listing names the files to read')
    const holding = published.filter((path) => {
      const bytes = readFileSync(join(installed, path))
      return formerNames.some((name) => bytes.includes(name))
    })
    assert.deepEqual(holding, [])
  })

  test('in an empty project, npx retest --version answers with the packed version', async () => {
    assert.ok(packed !== undefined, 'the package was packed')
    const empty = join(root, 'empty')
    await mkdir(empty)
    await writeFile(join(empty, 'package.json'), `${JSON.stringify({ name: 'retest-empty', private: true })}\n`)
    await installPacked(empty, packed)
    const [npx, ...before] = npxCommand(packed.npmEnv)
    // Offline, so npx runs the copy the project installed and could never fetch a package of the same name instead.
    const version = await runProgram(npx, [...before, 'retest', '--version'], empty, { ...packed.npmEnv, npm_config_offline: 'true' })
    assertSucceeded(version, 'npx retest --version')
    assert.equal(version.stdout, `${retestVersion}\n`)
  })

  test('installing it adds no other package', async () => {
    const installed = readdirSync(join(consumer, 'node_modules')).filter((name) => !name.startsWith('.'))
    assert.deepEqual(installed, [packageName])
    const manifest: unknown = JSON.parse(await readFile(join(consumer, 'node_modules', packageName, 'package.json'), 'utf8'))
    assert.ok(typeof manifest === 'object' && manifest !== null)
    for (const key of ['dependencies', 'optionalDependencies']) {
      assert.equal(Object.hasOwn(manifest, key), false, `the package declares no ${key}`)
    }
    // The AI SDK adapter's packages, and agent-device for phones driven through it, are peers a project installs only to
    // use them: each is optional, so installing Retest installs none of them, as the listing above shows.
    const peers: unknown = Reflect.get(manifest, 'peerDependencies')
    const meta: unknown = Reflect.get(manifest, 'peerDependenciesMeta')
    assert.ok(typeof peers === 'object' && peers !== null && typeof meta === 'object' && meta !== null)
    assert.deepEqual(Object.keys(peers).sort(), ['@ai-sdk/anthropic', '@ai-sdk/azure', '@ai-sdk/openai', 'agent-device', 'ai'])
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
      command: installedRetest(consumer),
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
      command: installedRetest(consumer),
    })
    assert.equal(run.exit.code, 1, run.stderr)
    const failed = onlyTest(run)
    assert.deepEqual([failed.status, failed.failure?.class], ['failed', 'check_failed'])
    assert.equal(failed.evidence.length, 1)
  })
})
