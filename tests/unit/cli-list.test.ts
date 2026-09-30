import type { Failure } from '../../src/protocol/failures.ts'
import type { CollectResult } from '../../src/runner/contract.ts'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { app, chromium } from '../../src/config/define.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { collecting, fakeCli, loadedConfig, type FakeOptions } from './cli-fixtures.ts'
import { file, projectFolder, savesTask, showsCount } from './reporters-fixtures.ts'

const root = projectFolder()
writeFileSync(join(root, 'examples', 'empty.retest.ts'), '')

const twoTests: CollectResult = {
  files: [
    {
      file,
      collection: 'ok',
      tests: [
        { testId: savesTask, name: 'saves a task', location: { file, line: 3, column: 1 } },
        { testId: showsCount, name: 'shows the count', location: { file, line: 10, column: 1 } },
      ],
    },
  ],
}

async function list(args: string[], options: Partial<FakeOptions> = {}) {
  const fake = fakeCli({ cwd: root, collectFiles: collecting(twoTests), ...options })
  const code = await fake.cli(['list', ...args])
  return { code, stdout: fake.stdout.text, stderr: fake.stderr.text, collects: fake.collects }
}

describe('list', () => {
  test('prints each file, its tests and their source lines', async () => {
    const { code, stdout, stderr, collects } = await list([file])
    assert.equal(code, 0)
    assert.equal(stderr, '')
    assert.equal(
      stdout,
      [
        'examples/task.retest.ts',
        '  saves a task     examples/task.retest.ts:3:1',
        '  shows the count  examples/task.retest.ts:10:1',
        '',
        '2 tests in 1 file',
        '',
      ].join('\n'),
    )
    assert.deepEqual(collects, [{ files: [file], rootDir: root, timeouts: { collection: defaultTimeouts.collection } }])
  })

  test('--json prints exactly one JSON document', async () => {
    const { code, stdout } = await list([file, '--json'])
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(stdout), { schemaVersion: 1, ...twoTests })
  })

  test('a file that fails collection exits 2 with the reason on stderr', async () => {
    const failed: CollectResult = {
      files: [
        twoTests.files[0] ?? assert.fail(),
        {
          file: 'examples/broken.retest.ts',
          collection: 'failed',
          failure: {
            class: 'collection_failed',
            message: 'SyntaxError: Unexpected token',
            location: { file: 'examples/broken.retest.ts', line: 4, column: 7 },
          },
          tests: [],
        },
      ],
    }
    const { code, stdout, stderr } = await list([file], { collectFiles: collecting(failed) })
    assert.equal(code, 2)
    assert.match(stdout, /saves a task/)
    assert.equal(
      stderr,
      'error: examples/broken.retest.ts could not be collected (examples/broken.retest.ts:4:7): SyntaxError: Unexpected token\n',
    )
    const json = await list([file, '--json'], { collectFiles: collecting(failed) })
    assert.equal(json.code, 2)
    assert.equal(JSON.parse(json.stdout).files[1].collection, 'failed')
  })

  test('a file that fails after its tests were collected lists them, and exits 2 with the reason on stderr', async () => {
    const [collected] = twoTests.files
    const thrown: Failure = {
      class: 'test_error',
      message: `${file} threw an error while no test was running: Error: late`,
      location: { file, line: 12, column: 5 },
    }
    const lateError: CollectResult = { files: [{ ...(collected ?? assert.fail()), failure: thrown }] }
    const { code, stdout, stderr } = await list([file], { collectFiles: collecting(lateError) })
    assert.equal(code, 2)
    assert.match(stdout, /saves a task/)
    assert.equal(stderr, `error: ${file} failed outside its tests (${file}:12:5): ${thrown.message}\n`)
    const json = await list([file, '--json'], { collectFiles: collecting(lateError) })
    assert.equal(json.code, 2)
    assert.deepEqual(JSON.parse(json.stdout), { schemaVersion: 1, ...lateError })
  })

  test('no tests at all exits 2', async () => {
    const empty: CollectResult = { files: [{ file: 'examples/empty.retest.ts', collection: 'ok', tests: [] }] }
    const { code, stdout, stderr } = await list(['examples/empty.retest.ts'], { collectFiles: collecting(empty) })
    assert.equal(code, 2)
    assert.match(stdout, /examples\/empty\.retest\.ts\n {2}no tests\n\n0 tests in 1 file\n/)
    assert.equal(stderr, 'error: No tests found. Declare one with test(name, fn).\n')
  })

  test('checks the files before collecting anything', async () => {
    const { code, stdout, stderr, collects } = await list(['examples/missing.retest.ts'])
    assert.equal(code, 2)
    assert.equal(stdout, '')
    assert.match(stderr, /examples\/missing\.retest\.ts does not exist\./)
    assert.equal(collects.length, 0)
    assert.equal((await list([])).code, 2)
    assert.match((await list([file, '--browser', 'x'])).stderr, /Unknown option --browser\./)
  })

  test('exits 130 when interrupted during collection', async () => {
    const controller = new AbortController()
    const collectFiles = async () => {
      controller.abort()
      return twoTests
    }
    const { code, stdout } = await list([file], { collectFiles, signal: controller.signal })
    assert.equal(code, 130)
    assert.equal(stdout, '')
  })

  test('exits 143 when stopped by SIGTERM during collection', async () => {
    const controller = new AbortController()
    const collectFiles = async () => {
      controller.abort('SIGTERM')
      return twoTests
    }
    assert.equal((await list([file], { collectFiles, signal: controller.signal })).code, 143)
  })
})

describe('list with a config', () => {
  const project = projectFolder()
  writeFileSync(join(project, 'retest.config.ts'), '')
  const config = loadedConfig(project, {
    apps: { web: app({ targets: { chromium: chromium(), pixel: chromium({ emulate: 'Pixel 9' }) } }), admin: chromium() },
    defaultApp: 'web',
    tags: ['smoke', 'slow'],
  })
  const location = (line: number) => ({ file, line, column: 1 })
  const withTargets: CollectResult = {
    files: [
      {
        file,
        collection: 'ok',
        tests: [
          { testId: `${file} > signs in`, name: 'signs in', location: location(3), setup: true, apps: ['web'], variants: [{ web: 'chromium' }, { web: 'pixel' }] },
          {
            testId: `${file} > tasks > saves a task`,
            name: 'saves a task',
            location: location(8),
            describePath: ['tasks'],
            tags: ['smoke', 'slow'],
            apps: ['web', 'admin'],
            variants: [
              { web: 'chromium', admin: 'chromium' },
              { web: 'pixel', admin: 'chromium' },
            ],
          },
        ],
      },
    ],
  }

  async function listed(args: string[], collected: CollectResult = withTargets) {
    const fake = fakeCli({ cwd: project, config, collectFiles: collecting(collected) })
    const code = await fake.cli(['list', ...args])
    return { code, stdout: fake.stdout.text, stderr: fake.stderr.text, collects: fake.collects }
  }

  test('shows each test with its tags, apps and targets, and counts the runs', async () => {
    const { code, stdout, stderr } = await listed([])
    assert.equal(code, 0, stderr)
    assert.equal(
      stdout,
      [
        'examples/task.retest.ts',
        '  signs in (setup)      examples/task.retest.ts:3:1',
        '    apps    web',
        '    targets web=chromium · web=pixel',
        '  tasks › saves a task  examples/task.retest.ts:8:1',
        '    tags    smoke, slow',
        '    apps    web, admin',
        '    targets admin=chromium,web=chromium · admin=chromium,web=pixel',
        '',
        '2 tests in 1 file, 4 runs with their targets',
        '',
      ].join('\n'),
    )
  })

  test('shows each test.for row with its #row, which run takes after the line', async () => {
    const rows: CollectResult = {
      files: [
        {
          file,
          collection: 'ok',
          tests: [1, 2].map((row) => ({ testId: `${file} > opens ${row}`, name: `opens ${row}`, location: location(12), row })),
        },
      ],
    }
    const { stdout } = await listed([], rows)
    assert.match(stdout, /\n {2}opens 1 {2}examples\/task\.retest\.ts:12:1#1\n {2}opens 2 {2}examples\/task\.retest\.ts:12:1#2\n/)
  })

  test('names the files a setup taken from another file serves', async () => {
    const signIn = 'tests/sign-in.retest.ts'
    const borrowed: CollectResult = {
      files: [
        ...withTargets.files,
        {
          file: signIn,
          collection: 'ok',
          tests: [{ testId: `${signIn} > admin`, name: 'admin', location: { file: signIn, line: 2, column: 1 }, setup: true, setupFor: [file, 'tests/b.retest.ts'] }],
        },
      ],
    }
    const { stdout } = await listed([], borrowed)
    assert.match(stdout, /\n {2}admin \(setup for examples\/task\.retest\.ts and tests\/b\.retest\.ts\) {2}tests\/sign-in\.retest\.ts:2:1\n/)
  })

  test('collects every test file with the config and the selection', async () => {
    const { collects } = await listed(['--tag', 'smoke', '--target', 'web=pixel', `${file}:8`])
    assert.deepEqual(collects, [
      {
        files: [file],
        rootDir: project,
        timeouts: { collection: defaultTimeouts.collection },
        config,
        selection: { tags: { kind: 'tag', tag: 'smoke' }, locations: [{ file, line: 8 }], targets: { web: 'pixel' } },
      },
    ])
    assert.deepEqual((await listed([])).collects[0]?.files, [file])
  })

  test('a selection that keeps nothing says which flags were given', async () => {
    const empty: CollectResult = { files: [{ file, collection: 'ok', tests: [] }] }
    const { code, stderr } = await listed(['--grep', 'nothing', '--tag', 'slow', `${file}:99`], empty)
    assert.equal(code, 2)
    assert.equal(stderr, 'error: No tests match --grep "nothing", --tag "slow" and examples/task.retest.ts:99.\n')
  })

  test('checks the selection flags before collecting anything', async () => {
    const { code, stderr, collects } = await listed(['--tag', 'smok'])
    assert.equal(code, 2)
    assert.match(stderr, /--tag: Unknown tag "smok" at character 1\. Did you mean smoke\?/)
    assert.equal(collects.length, 0)
  })
})
