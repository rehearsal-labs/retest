import type { CollectedFile } from '../../src/runner/contract.ts'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { configFileName, loadConfig } from '../../src/config/load.ts'
import { collectFiles } from '../../src/runner/run.ts'
import { tempProject } from '../support/project.ts'
import { eventsOfType, rootDir, runSupportFiles, supportFile } from '../support/run-harness.ts'

async function collectOne(name: string, collection = 5000): Promise<CollectedFile> {
  const { files } = await collectFiles({ files: [supportFile(name)], rootDir, timeouts: { collection } })
  const [file] = files
  assert.ok(file)
  return file
}

describe('collectFiles', () => {
  test('lists each test with its id and source location, without a browser', async () => {
    const file = await collectOne('passing.retest.ts')
    assert.equal(file.collection, 'ok')
    assert.deepEqual(file.tests[0], {
      testId: 'tests/support/files/passing.retest.ts > saves a task',
      name: 'saves a task',
      location: { file: 'tests/support/files/passing.retest.ts', line: 3, column: 1 },
    })
    assert.deepEqual(
      file.tests.map((entry) => entry.name),
      ['saves a task', 'returns values from nested steps', 'reads each run of whitespace as one space'],
    )
  })

  test('a file that fails to import fails collection with the error', async () => {
    const file = await collectOne('import-error.retest.ts')
    assert.equal(file.collection, 'failed')
    assert.equal(file.failure?.class, 'collection_failed')
    assert.match(file.failure?.message ?? '', /^Could not load tests\/support\/files\/import-error\.retest\.ts\. Error: Cannot find module .*no-such-helper\.ts/)
    assert.deepEqual(file.tests, [])
  })

  test('an endless loop at the top of a file ends at the collection budget', async () => {
    const started = performance.now()
    const file = await collectOne('top-level-loop.retest.ts', 700)
    const took = performance.now() - started
    assert.equal(file.failure?.class, 'collection_failed')
    assert.equal(file.failure?.message, 'Loading tests/support/files/top-level-loop.retest.ts took longer than 700 ms, so Retest stopped its process.')
    assert.ok(took < 700 + 1500, `took ${Math.round(took)} ms`)
  })

  test('two tests with one name fail collection, naming both lines', async () => {
    const file = await collectOne('duplicate-names.retest.ts')
    assert.deepEqual(file.failure, {
      class: 'collection_failed',
      message: 'Two tests are named "same name", on lines 3 and 7. Give each test its own name.',
      location: { file: 'tests/support/files/duplicate-names.retest.ts', line: 7, column: 1 },
    })
    assert.deepEqual(file.tests, [])
  })

  test('an unknown test option is a usage failure', async () => {
    const file = await collectOne('unknown-option.retest.js')
    assert.equal(file.failure?.class, 'usage')
    assert.equal(file.failure?.message, 'Unknown test option "retries". Test options are apps, tags, state, locks and timeout.')
    assert.equal(file.failure?.location?.line, 3)
  })

  test('a timeout that is not a whole number of milliseconds is a usage failure', async () => {
    const file = await collectOne('bad-timeout.retest.js')
    assert.equal(file.failure?.class, 'usage')
    assert.match(file.failure?.message ?? '', /whole number of milliseconds from 1 to 2147483647, received 2\.5\.$/)
  })

  test('a file with no tests fails collection', async () => {
    const file = await collectOne('zero-tests.retest.ts')
    assert.deepEqual(file.failure, {
      class: 'collection_failed',
      message: 'tests/support/files/zero-tests.retest.ts has no tests. Call test() at the top level of the file.',
    })
  })

  test('a second copy of Retest in the process fails collection and says why', async () => {
    const file = await collectOne('second-copy.retest.js')
    assert.equal(file.failure?.class, 'collection_failed')
    assert.match(file.failure?.message ?? '', /Retest is loaded twice in this process, from .*src\/api\/registry\.ts and .*registry\.ts\?second-copy\./)
  })

  test('an error thrown after the tests were collected fails the file, which keeps its tests', async () => {
    const file = await collectOne('after-collection-error.retest.ts')
    const name = supportFile('after-collection-error.retest.ts')
    assert.deepEqual(file, {
      file: name,
      collection: 'ok',
      failure: {
        class: 'test_error',
        message: `${name} threw an error while no test was running: Error: thrown after the tests were collected`,
        location: { file: name, line: 6, column: 11 },
      },
      tests: [{ testId: `${name} > is listed`, name: 'is listed', location: { file: name, line: 10, column: 1 } }],
    })
  })

  test('a file whose process ends badly after collection fails, naming how it ended', async () => {
    const file = await collectOne('after-collection-exit.retest.ts')
    const name = supportFile('after-collection-exit.retest.ts')
    assert.equal(file.collection, 'ok')
    assert.deepEqual(file.failure, { class: 'test_error', message: `The process for ${name} ended with exit code 4 while no test was running.` })
    assert.equal(file.tests.length, 1)
  })

  test('work a file queued before it was asked to close still runs, however soon the request comes', async () => {
    // One collection seldom meets a request that arrives before the file's next turn; many at once make it likely.
    const names = Array.from({ length: 16 }, (_, index) => (index % 2 === 0 ? 'after-collection-error.retest.ts' : 'after-collection-exit.retest.ts'))
    const files = await Promise.all(names.map((name) => collectOne(name)))
    for (const [index, file] of files.entries()) {
      assert.equal(file.collection, 'ok')
      assert.equal(file.failure?.class, 'test_error', `${names[index]} lost the work it queued: ${JSON.stringify(file.failure)}`)
    }
  })

  test('a missing file fails collection without starting a process', async () => {
    const file = await collectOne('not-there.retest.ts')
    assert.deepEqual(file.failure, { class: 'collection_failed', message: 'There is no file at tests/support/files/not-there.retest.ts.' })
  })

  test('each file is collected on its own, in the order given', async () => {
    const { files } = await collectFiles({
      files: [supportFile('zero-tests.retest.ts'), supportFile('passing.retest.ts')],
      rootDir,
      timeouts: { collection: 5000 },
    })
    assert.deepEqual(
      files.map((file) => [file.file, file.collection]),
      [
        ['tests/support/files/zero-tests.retest.ts', 'failed'],
        ['tests/support/files/passing.retest.ts', 'ok'],
      ],
    )
  })
})

describe('collection in a run', () => {
  test('every file failing collection exits 2 without launching the browser', async () => {
    const record = await runSupportFiles(['import-error.retest.ts', 'zero-tests.retest.ts'])
    assert.equal(record.result.exitCode, 2)
    assert.equal(record.result.status, 'error')
    assert.equal(record.result.complete, false)
    assert.equal(record.browsers.length, 0)
    assert.equal(record.result.browser, null)
    assert.equal(eventsOfType(record.events, 'collection.failed').length, 2)
    assert.deepEqual(record.written, record.result)
  })

  test('a failed collection beside passing tests still cannot exit 0', async () => {
    const record = await runSupportFiles(['duplicate-names.retest.ts', 'passing.retest.ts'])
    assert.equal(record.result.exitCode, 2)
    assert.deepEqual(record.result.counts, { passed: 3, failed: 0, error: 0, notRun: 0, inconclusive: 0 })
  })

  test('a failed collection beside a failed test exits 1', async () => {
    const record = await runSupportFiles(['duplicate-names.retest.ts', 'no-assertions.retest.ts'])
    assert.equal(record.result.exitCode, 1)
    assert.equal(record.result.complete, false)
  })

  test('the collection budget ends a file that never loads, and the run goes on', async () => {
    const record = await runSupportFiles(['top-level-loop.retest.ts', 'passing.retest.ts'], { timeouts: { collection: 700 } })
    const [looping, passing] = record.result.files
    assert.equal(looping?.collection, 'failed')
    assert.match(looping?.failure?.message ?? '', /took longer than 700 ms, so Retest stopped its process\. Its output is in logs\/.+\.log\.$/)
    assert.equal(passing?.collection, 'ok')
    assert.equal(record.result.exitCode, 2)
  })
})

describe('collectFiles with a config', async () => {
  const config = `import { app, chromium, defineConfig } from '@rehearsal-labs/retest'
export default defineConfig({
  apps: { web: app({ baseUrl: 'http://127.0.0.1:4173', targets: { stable: chromium({ executablePath: '/fake/stable' }), beta: chromium({ executablePath: '/fake/beta' }) } }) },
  tags: ['smoke'],
})
`
  const root = tempProject({
    'retest.config.ts': config,
    'tests/archive.retest.ts': `import { test } from '@rehearsal-labs/retest'
test('archives', { state: 'signed-in', tags: ['smoke'] }, async () => {})
test('lists', async () => {})
`,
    'tests/sign-in.retest.ts': `import { test } from '@rehearsal-labs/retest'
test.setup('signed-in', async () => {})
`,
    'tests/broken.retest.ts': `import { test } from '@rehearsal-labs/retest'
test('tagged', { tags: ['smok'] }, async () => {})
`,
  })
  const loaded = await loadConfig(join(root, configFileName))
  assert.ok(loaded.ok)
  const files = ['tests/archive.retest.ts', 'tests/sign-in.retest.ts', 'tests/broken.retest.ts']

  test('lists each test with its apps and variants, and fails a file as a run would', async () => {
    const collected = await collectFiles({ files, rootDir: root, timeouts: { collection: 5000 }, config: loaded.config })
    const [archive, signIn, broken] = collected.files
    assert.deepEqual(archive?.tests.map((entry) => [entry.name, entry.apps, entry.variants?.length]), [['archives', ['web'], 2], ['lists', ['web'], 2]])
    assert.equal(signIn?.tests[0]?.setup, true)
    assert.deepEqual(broken?.failure, {
      class: 'collection_failed',
      message: '"tagged": The tag "smok" is not in the config\'s tags: smoke.',
      location: { file: 'tests/broken.retest.ts', line: 2, column: 1 },
    })
  })

  test('takes a setup the files given lack from the project, listing only that setup and whom it serves', async () => {
    const collected = await collectFiles({ files: ['tests/archive.retest.ts'], rootDir: root, timeouts: { collection: 5000 }, config: loaded.config })
    assert.deepEqual(collected.files.map((file) => [file.file, file.collection, file.tests.map((entry) => [entry.name, entry.setupFor])]), [
      ['tests/archive.retest.ts', 'ok', [['archives', undefined], ['lists', undefined]]],
      ['tests/sign-in.retest.ts', 'ok', [['signed-in', ['tests/archive.retest.ts']]]],
    ])
  })

  test('with a selection, lists only the tests and variants a run would start, setups they need included', async () => {
    const selection = { tags: { kind: 'tag' as const, tag: 'smoke' }, targets: { web: 'beta' } }
    const collected = await collectFiles({ files, rootDir: root, timeouts: { collection: 5000 }, config: loaded.config, selection })
    assert.deepEqual(collected.files.map((file) => file.tests.map((entry) => [entry.name, entry.variants])), [
      [['archives', [{ web: 'beta' }]]],
      [['signed-in', [{ web: 'beta' }]]],
      [],
    ])
  })
})
