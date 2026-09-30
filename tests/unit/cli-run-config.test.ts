import type { RunOptions } from '../../src/runner/contract.ts'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { app, chromium, env } from '../../src/config/define.ts'
import { lastRunFile } from '../../src/protocol/last-run.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { fakeCli, loadedConfig, playing, type FakeOptions } from './cli-fixtures.ts'
import { file, passingRun, projectFolder, temporaryFolder } from './reporters-fixtures.ts'

const root = projectFolder()
for (const path of ['tests/a.retest.ts', 'tests/nested/b.retest.ts', 'node_modules/pkg/c.retest.ts', '.hidden/d.retest.ts']) {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), '')
}
writeFileSync(join(root, 'retest.config.ts'), '')
writeFileSync(join(root, 'other.config.ts'), '')

const config = loadedConfig(root, {
  apps: {
    web: app({ baseUrl: 'http://127.0.0.1:4173', targets: { chromium: chromium(), pixel: chromium({ emulate: 'Pixel 9' }) } }),
    admin: chromium({ baseUrl: 'http://127.0.0.1:5000' }),
  },
  defaultApp: 'web',
  tags: ['smoke', 'slow'],
  secrets: { password: env('TEST_PASSWORD'), code: () => '000000' },
  timeouts: { action: 2000 },
})
const secretEnv = { TEST_PASSWORD: 'hunter2' }

async function run(args: string[], options: Partial<FakeOptions> = {}) {
  const fake = fakeCli({ cwd: root, config, env: secretEnv, runFiles: playing(passingRun(root)), ...options })
  const code = await fake.cli(['run', ...args])
  return { ...fake, code, stdout: fake.stdout.text, stderr: fake.stderr.text }
}

async function planned(args: string[], options: Partial<FakeOptions> = {}): Promise<RunOptions> {
  const { runs, stderr } = await run(args, options)
  const options_ = runs[0]?.options
  assert.ok(options_ !== undefined, stderr)
  return options_
}

async function rejected(args: string[], options: Partial<FakeOptions> = {}): Promise<string> {
  const { code, stdout, stderr, runs } = await run(args, options)
  assert.equal(code, 2, stderr)
  assert.equal(stdout, '')
  assert.equal(runs.length, 0, 'a rejected command line started a run')
  return stderr
}

describe('run with a config', () => {
  test('runs every test file under the root, skipping node_modules and dot folders, with the config', async () => {
    const { runs, loads } = await run([])
    const options = runs[0]?.options
    assert.deepEqual(loads, [join(root, 'retest.config.ts')])
    assert.deepEqual(options?.files, [file, 'tests/a.retest.ts', 'tests/nested/b.retest.ts'])
    assert.equal(options?.selection, undefined)
    assert.equal(options?.apps.kind, 'config')
    if (options?.apps.kind !== 'config') return
    assert.equal(options.apps.config, config)
    assert.equal(options.apps.baseUrls, undefined)
    assert.deepEqual(options.apps.secrets.get('password'), { value: 'hunter2' })
    assert.equal(typeof Reflect.get(options.apps.secrets.get('code') ?? {}, 'read'), 'function')
  })

  test('says so when there is no test file to run', async () => {
    const empty = temporaryFolder()
    writeFileSync(join(empty, 'retest.config.ts'), '')
    const fake = fakeCli({ cwd: empty, config, env: secretEnv })
    assert.equal(await fake.cli(['run']), 2)
    assert.equal(fake.stderr.text, 'error: No test files found. Test files end in .retest.ts.\n')
  })

  test('lays the command line timeouts over the config over the defaults', async () => {
    assert.deepEqual((await planned(['--timeouts', 'test=3000'])).timeouts, { ...defaultTimeouts, action: 2000, test: 3000 })
    assert.deepEqual((await planned(['--timeouts', 'action=500'])).timeouts, { ...defaultTimeouts, action: 500 })
  })

  test('reads another config with --config', async () => {
    const { loads } = await run(['--config', 'other.config.ts'])
    assert.deepEqual(loads, [join(root, 'other.config.ts')])
    assert.match(await rejected(['--config', 'missing.config.ts']), /^error: No config at missing\.config\.ts\.\n$/)
  })

  test('a config that does not load stops the run with its message', async () => {
    const loadConfig: FakeOptions['loadConfig'] = async () => ({
      ok: false,
      failure: { class: 'usage', message: 'retest.config.ts: apps.web.targets.beta.channel: expected one of "stable", "beta"' },
    })
    assert.equal(
      await rejected([], { loadConfig }),
      'error: retest.config.ts: apps.web.targets.beta.channel: expected one of "stable", "beta"\n',
    )
  })

  test('--browser is milestone 1 mode, so it cannot go with a config', async () => {
    assert.match(
      await rejected([file, '--browser', '/bin/chrome']),
      /--browser runs without a config, but retest\.config\.ts is here\. Leave out --browser to use its targets\./,
    )
    assert.match(
      await rejected([file, '--browser', '/bin/chrome', '--config', 'other.config.ts']),
      /--browser runs without a config, so it cannot go with --config\./,
    )
  })

  test('a missing environment secret stops the run before it starts, naming the variable', async () => {
    const stderr = await rejected([], { env: {} })
    assert.match(stderr, /The secret "password" reads TEST_PASSWORD, which is not set\./)
    assert.match(await rejected([], { env: { TEST_PASSWORD: '' } }), /which is empty/)
    assert.doesNotMatch(stderr, /See retest help/)
  })
})

describe('run base URLs', () => {
  test('an address alone replaces the default app; app=url replaces the named one', async () => {
    const options = await planned(['--base-url', 'https://preview.example.com', '--base-url', 'admin=https://admin.example.com'])
    assert.equal(options.apps.kind, 'config')
    if (options.apps.kind !== 'config') return
    assert.deepEqual(options.apps.baseUrls, { web: 'https://preview.example.com', admin: 'https://admin.example.com' })
  })

  test('rejects an unknown app, one named twice, and an address that is not http or https', async () => {
    assert.match(
      await rejected(['--base-url', 'admn=https://a.example.com']),
      /--base-url names no app admn\. Did you mean admin\? The config's apps are web and admin\./,
    )
    assert.match(
      await rejected(['--base-url', 'https://a.example.com', '--base-url', 'web=https://b.example.com']),
      /--base-url names web twice\. Give one address for each app\./,
    )
    assert.match(await rejected(['--base-url', 'web=ftp://a.example.com']), /--base-url must be a full http or https address/)
  })

  test('with several apps and no defaultApp, an address alone needs its app', async () => {
    const twoApps = loadedConfig(root, { apps: { owner: chromium(), member: chromium() } })
    assert.match(
      await rejected(['--base-url', 'https://a.example.com'], { config: twoApps }),
      /--base-url needs an app name, since the config has several apps and no defaultApp, such as --base-url web=http:\/\/127\.0\.0\.1:4173\./,
    )
  })

  test('without a config there is one app, so app=url and a second address are mistakes', async () => {
    const bare = projectFolder()
    const m1 = (args: string[]) => fakeCli({ cwd: bare, runFiles: playing(passingRun(bare)) }).cli(['run', file, '--browser', '/bin/chrome', ...args])
    assert.equal(await m1(['--base-url', 'web=http://127.0.0.1:4173']), 2)
    assert.equal(await m1(['--base-url', 'http://a.test', '--base-url', 'http://b.test']), 2)
  })
})

describe('run selection', () => {
  test('file:line keeps the file and names the line; a column after it is allowed', async () => {
    const options = await planned([`${file}:7`, 'tests/a.retest.ts:3:5', 'tests/a.retest.ts:9', 'tests/nested/b.retest.ts'])
    assert.deepEqual(options.files, [file, 'tests/a.retest.ts', 'tests/nested/b.retest.ts'])
    assert.deepEqual(options.selection, {
      locations: [
        { file, line: 7 },
        { file: 'tests/a.retest.ts', line: 3 },
        { file: 'tests/a.retest.ts', line: 9 },
      ],
    })
  })

  test('file:line#row names one row of the test.for on that line, after a column too, beside the whole line', async () => {
    const options = await planned([`${file}:7#2`, `${file}:7:3#1`, `${file}:7`])
    assert.deepEqual(options.files, [file])
    assert.deepEqual(options.selection, {
      locations: [
        { file, line: 7, row: 2 },
        { file, line: 7, row: 1 },
        { file, line: 7 },
      ],
    })
  })

  test('rejects a line that is not a whole number from 1, and a file named twice or both ways', async () => {
    assert.match(
      await rejected([`${file}:0`]),
      /examples\/task\.retest\.ts:0 names no line\. Write the line as a whole number from 1, such as examples\/task\.retest\.ts:7, and a row of a test\.for after it, such as examples\/task\.retest\.ts:7#2\./,
    )
    assert.match(await rejected([`${file}:top`]), /names no line/)
    for (const row of ['#0', '#', '#two', '#2#3', ':3#']) assert.match(await rejected([`${file}:7${row}`]), /names no line/, row)
    assert.match(await rejected([`${file}:7#2`, `./${file}:7#2`]), /\.\/examples\/task\.retest\.ts:7#2 is named twice\./)
    assert.match(await rejected([`${file}:7`, `./${file}:7`]), /\.\/examples\/task\.retest\.ts:7 is named twice\./)
    assert.match(await rejected([file, `${file}:7`]), /examples\/task\.retest\.ts is named on its own and with a line\. Name it one way\./)
    assert.match(await rejected(['tests/b.retest.ts:3']), /tests\/b\.retest\.ts does not exist\. Did you mean tests\/a\.retest\.ts\?/)
  })

  test('--grep is text, or a pattern written /pattern/flags', async () => {
    assert.deepEqual((await planned(['--grep', 'saves a'])).selection, { grep: 'saves a' })
    assert.deepEqual((await planned(['--grep', '/^tasks > sav/i'])).selection, { grep: /^tasks > sav/i })
    assert.deepEqual((await planned(['--grep', '/'])).selection, { grep: '/' })
    assert.match(await rejected(['--grep', '/(/']), /--grep \/\(\/ is not a valid pattern: Invalid regular expression/)
    assert.match(await rejected(['--grep', '/save/g']), /--grep \/save\/g: leave out the g and y flags/)
  })

  test('--tag is parsed against the config tags, and a mistake points at its character', async () => {
    const { selection } = await planned(['--tag', 'smoke and not slow'])
    assert.deepEqual(selection, {
      tags: { kind: 'and', left: { kind: 'tag', tag: 'smoke' }, right: { kind: 'not', operand: { kind: 'tag', tag: 'slow' } } },
    })
    assert.equal(
      await rejected(['--tag', 'smoke and slwo']),
      [
        'error: --tag: Unknown tag "slwo" at character 11. Did you mean slow? The config\'s tags are smoke and slow.',
        '  smoke and slwo',
        '            ^',
        'See retest help run.',
        '',
      ].join('\n'),
    )
    assert.match(await rejected(['--tag', 'smoke and']), /--tag: Expected a tag at character 10, but the expression ends there\.\n {2}smoke and\n {11}\^\n/)
  })

  test('--target keeps the named target of each app, and checks it against the config', async () => {
    assert.deepEqual((await planned(['--target', 'web=pixel'])).selection, { targets: { web: 'pixel' } })
    assert.deepEqual((await planned(['--target', 'web=pixel', '--target', 'admin=chromium'])).selection, {
      targets: { web: 'pixel', admin: 'chromium' },
    })
    assert.match(
      await rejected(['--target', 'web=pixle']),
      /--target web=pixle: web has no target pixle\. Did you mean web=pixel\? Its targets are chromium and pixel\./,
    )
    assert.match(await rejected(['--target', 'wb=pixel']), /--target names no app wb\. Did you mean web\?/)
    assert.match(await rejected(['--target', 'pixel']), /--target takes app=name, such as web=beta, received "pixel"\. Did you mean web=pixel\?/)
    assert.match(await rejected(['--target', 'web=pixel', '--target', 'web=chromium']), /--target names web twice\. Name one target for each app\./)
  })

  test('--target needs a config', async () => {
    const bare = projectFolder()
    const fake = fakeCli({ cwd: bare, runFiles: playing(passingRun(bare)) })
    assert.equal(await fake.cli(['run', file, '--browser', '/bin/chrome', '--target', 'web=beta']), 2)
    assert.match(fake.stderr.text, /--target picks a target from the config\. With --browser there is one browser\./)
  })

  test('flags combine into one selection', async () => {
    const { selection } = await planned([`${file}:7`, '--grep', 'task', '--tag', 'smoke', '--target', 'web=chromium'])
    assert.deepEqual(selection, {
      grep: 'task',
      tags: { kind: 'tag', tag: 'smoke' },
      locations: [{ file, line: 7 }],
      targets: { web: 'chromium' },
    })
  })
})

describe('run --last-failed', () => {
  function lastRun(project: string, tests: unknown[]): void {
    mkdirSync(join(project, '.retest'), { recursive: true })
    writeFileSync(join(project, lastRunFile), JSON.stringify({ schemaVersion: 1, runId: 'run-1', finishedAt: '2026-09-30T09:15:00.000Z', tests }))
  }

  test('keeps the tests the last run did not pass, and collects only the files that hold them', async () => {
    const project = projectFolder()
    writeFileSync(join(project, 'retest.config.ts'), '')
    mkdirSync(join(project, 'tests'))
    writeFileSync(join(project, 'tests/other.retest.ts'), '')
    const failed = [
      { testId: `${file} > saves a task`, variantKey: 'web=pixel', status: 'failed' },
      { testId: `${file} > shows the count`, status: 'not_run' },
    ]
    lastRun(project, failed)
    const fake = fakeCli({ cwd: project, config, env: secretEnv, runFiles: playing(passingRun(project)) })
    assert.equal(await fake.cli(['run', '--last-failed']), 0)
    assert.deepEqual(fake.runs[0]?.options.files, [file])
    assert.deepEqual(fake.runs[0]?.options.selection, { lastFailed: failed })
  })

  test('says why when there is nothing to run again', async () => {
    const project = projectFolder()
    writeFileSync(join(project, 'retest.config.ts'), '')
    const call = async () => {
      const fake = fakeCli({ cwd: project, config, env: secretEnv })
      const code = await fake.cli(['run', '--last-failed'])
      return { code, stderr: fake.stderr.text, runs: fake.runs.length }
    }
    assert.deepEqual(await call(), {
      code: 2,
      stderr: 'error: --last-failed reads .retest/last-run.json, which is not there yet. Run the tests once first.\nSee retest help run.\n',
      runs: 0,
    })
    lastRun(project, [])
    assert.match((await call()).stderr, /The last run passed every test it ran, so --last-failed has nothing to run\./)
    lastRun(project, [{ testId: 'gone.retest.ts > old', status: 'failed' }])
    assert.match((await call()).stderr, /The tests the last run did not pass are in no test file here any more\./)
    writeFileSync(join(project, lastRunFile), '{"schemaVersion":1')
    assert.match((await call()).stderr, /\.retest\/last-run\.json is not valid JSON\. Run the tests again to write it anew\./)
    writeFileSync(join(project, lastRunFile), '{"schemaVersion":2}')
    assert.match((await call()).stderr, /is not a record Retest wrote/)
  })
})
