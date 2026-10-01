import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import * as protocol from '../../src/protocol/index.ts'
import { isPlainObject } from '../../src/protocol/schema.ts'
import * as runner from '../../src/runner/index.ts'

const root = new URL('../../', import.meta.url)

function packageExports(): Record<string, unknown> {
  const manifest: unknown = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
  const exports = isPlainObject(manifest) ? manifest['exports'] : undefined
  assert.ok(isPlainObject(exports))
  return exports
}

describe('package subpaths', () => {
  test('the root, runner and protocol entries name the source, the types and the build, in that order', () => {
    const exports = packageExports()
    for (const [subpath, entry] of [
      ['.', 'index'],
      ['./runner', 'runner/index'],
      ['./protocol', 'protocol/index'],
    ] as const) {
      const conditions = exports[subpath]
      assert.ok(isPlainObject(conditions), subpath)
      assert.deepEqual(Object.entries(conditions), [
        ['retest-source', `./src/${entry}.ts`],
        ['types', `./dist/${entry}.d.ts`],
        ['default', `./dist/${entry}.js`],
      ])
      assert.ok(existsSync(new URL(`src/${entry}.ts`, root)), entry)
    }
  })

  test('the runner entry runs and collects files and reads a config object', () => {
    assert.equal(typeof runner.runFiles, 'function')
    assert.equal(typeof runner.collectFiles, 'function')
    assert.equal(typeof runner.validateConfig, 'function')
    assert.equal(new runner.RunFolderError('taken').name, 'RunFolderError')
    assert.equal(new runner.LaunchError('no browser').failure.class, 'setup_failed')
  })

  // A host builds its config in memory, and every secret it has may be a function.
  test('the runner entry resolves the secrets of a config object', async () => {
    const validated = runner.validateConfig(
      { apps: { web: { browser: 'chromium' } }, secrets: { code: () => '481516', password: { env: 'TEST_PASSWORD' } } },
      '/work/host.config.ts',
    )
    assert.ok(validated.ok)
    const resolved = runner.resolveSecrets(validated.config, { TEST_PASSWORD: 'correct horse' })
    assert.ok(resolved.ok)
    assert.deepEqual(resolved.secrets.get('password'), { value: 'correct horse' })
    const code = resolved.secrets.get('code')
    assert.ok(code !== undefined && 'read' in code)
    assert.equal(await code.read({ signal: new AbortController().signal }), '481516')
    const unset = runner.resolveSecrets(validated.config, {})
    assert.equal(unset.ok, false)
    assert.equal(unset.ok ? '' : unset.failure.class, 'setup_failed')
  })

  // A caller of runFiles writes only the budgets it changes.
  test('both entries give the default budgets and the merge, so a caller names only the budgets it changes', () => {
    assert.equal(runner.defaultTimeouts.action, 10_000)
    assert.equal(runner.mergeTimeouts(runner.defaultTimeouts, { action: 500 }).action, 500)
    assert.equal(protocol.defaultTimeouts, runner.defaultTimeouts)
    assert.equal(protocol.mergeTimeouts, runner.mergeTimeouts)
    assert.equal(protocol.parse(protocol.partialTimeoutsSchema, { test: 3000 }).ok, true)
    assert.equal(protocol.parse(protocol.timeoutsSchema, { test: 3000 }).ok, false)
  })

  test('the protocol entry has the schemas, their parser and the JSON Schema files', () => {
    for (const schema of [protocol.retestEventSchema, protocol.runResultSchema, protocol.pageCommandSchema, protocol.failureSchema]) {
      assert.equal(typeof schema.kind, 'string')
    }
    assert.equal(protocol.parse(protocol.failureSchema, { class: 'timeout', message: 'Out of time.' }).ok, true)
    assert.match(protocol.eventSchemaUrl, /^file:.*\/dist\/schemas\/event-v1\.schema\.json$/)
    assert.match(protocol.resultSchemaUrl, /^file:.*\/dist\/schemas\/result-v1\.schema\.json$/)
  })

  // A host that ran Retest reads the run folder afterwards through the same reader as inspect.
  test('the runner entry reads a run folder, and the protocol entry names its files', () => {
    assert.equal(typeof runner.readRunFolder, 'function')
    const error = new runner.RunFolderReadError('No run folder at /work/runs/1.')
    assert.ok(error instanceof Error)
    assert.equal(error.name, 'RunFolderReadError')
    assert.throws(() => runner.readRunFolder(new URL('does-not-exist/', root).pathname), runner.RunFolderReadError)
    assert.deepEqual([protocol.eventsFile, protocol.resultFile, protocol.logsFolder], ['events.jsonl', 'result.json', 'logs'])
  })

  // A host that writes the test file keys its host checks by the id the run will give the test.
  test('the protocol entry builds the test id a run gives a test', () => {
    assert.equal(protocol.testTitle('places an order', ['checkout']), 'checkout > places an order')
    assert.equal(protocol.testId('tests/checkout.retest.ts', protocol.testTitle('places an order', ['checkout'])), 'tests/checkout.retest.ts > checkout > places an order')
    assert.equal(protocol.testId('tests/checkout.retest.ts', protocol.testTitle('signs in')), 'tests/checkout.retest.ts > signs in')
  })

  test('each entry only passes other modules on', () => {
    for (const entry of ['src/runner/index.ts', 'src/protocol/index.ts']) {
      const source = readFileSync(new URL(entry, root), 'utf8')
      for (const line of source.split('\n').filter((text) => text.trim() !== '')) {
        assert.match(line, /^export |^ {2}\w+,$|^\} from '/, `${entry}: ${line}`)
      }
    }
  })
})
