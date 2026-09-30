import type { Failure } from '../../src/protocol/failures.ts'
import type { CollectResult } from '../../src/runner/contract.ts'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { collecting, fakeCli, type FakeOptions } from './cli-fixtures.ts'
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
