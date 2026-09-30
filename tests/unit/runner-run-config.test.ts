import type { RunResult } from '../../src/protocol/result.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { validateConfig } from '../../src/config/validate.ts'
import { lastRunFile } from '../../src/protocol/last-run.ts'
import { lastRunOf, writeLastRun } from '../../src/runner/last-run.ts'
import { runConfig } from '../../src/runner/run-config.ts'
import { appWith, at } from '../support/plans.ts'
import { tempFolder } from '../support/temp-folder.ts'

function loaded() {
  const config = validateConfig({ apps: { web: appWith('stable'), admin: appWith('stable') }, defaultApp: 'web' }, '/work/retest.config.ts')
  assert.ok(config.ok)
  return config.config
}

describe('runConfig', () => {
  test("milestone 1's mode is one app, page, whose one target is the browser given, with no variants", () => {
    const single = runConfig({ kind: 'browser', browserPath: '/usr/bin/chromium', baseUrl: 'http://127.0.0.1:4173' })
    assert.ok(single.ok)
    assert.equal(single.config.variants, false)
    assert.equal(single.config.defaultApp, 'page')
    assert.deepEqual(single.config.apps.get('page'), {
      name: 'page',
      baseUrl: 'http://127.0.0.1:4173',
      targets: new Map([['page', { name: 'page', browser: 'chromium', headless: true, executablePath: '/usr/bin/chromium' }]]),
    })
  })

  test('base URLs from the command line replace the apps’ own', () => {
    const configured = runConfig({ kind: 'config', config: loaded(), secrets: new Map(), baseUrls: { admin: 'https://preview.example' } })
    assert.ok(configured.ok)
    assert.equal(configured.config.variants, true)
    assert.equal(configured.config.apps.get('admin')?.baseUrl, 'https://preview.example')
    assert.equal(configured.config.apps.get('web')?.baseUrl, 'http://127.0.0.1:4173')
  })

  test('a base URL for an unknown app, or one that is not a web address, is a usage failure naming each', () => {
    const configured = runConfig({ kind: 'config', config: loaded(), secrets: new Map(), baseUrls: { mobile: 'http://x', web: 'ftp://x' } })
    assert.deepEqual(configured, {
      ok: false,
      failure: {
        class: 'usage',
        message: '--base-url names the app "mobile", which the config does not have. --base-url for web must be an http or https URL, received "ftp://x".',
      },
    })
  })
})

describe('the last run', () => {
  const result: Pick<RunResult, 'runId' | 'finishedAt' | 'files'> = {
    runId: 'run-1',
    finishedAt: '2026-09-30T12:00:00.000Z',
    files: [
      {
        file: 'tests/a.retest.ts',
        collection: 'ok',
        tests: (['passed', 'failed', 'error', 'not_run'] as const).map((status, index) => ({
          testId: `tests/a.retest.ts > test ${index}`,
          name: `test ${index}`,
          file: 'tests/a.retest.ts',
          location: at(index + 1),
          ...(index === 1 ? { variant: { web: 'beta' }, variantKey: 'web=beta' } : {}),
          attemptId: `attempt${index}`,
          status,
          durationMs: 0,
          assertionCount: 0,
          evidence: [],
        })),
      },
    ],
  }

  test('lists each test that failed, ended in an error or did not run, with its variant key when it has one', () => {
    assert.deepEqual(lastRunOf(result), {
      schemaVersion: 1,
      runId: 'run-1',
      finishedAt: '2026-09-30T12:00:00.000Z',
      tests: [
        { testId: 'tests/a.retest.ts > test 1', variantKey: 'web=beta', status: 'failed' },
        { testId: 'tests/a.retest.ts > test 2', status: 'error' },
        { testId: 'tests/a.retest.ts > test 3', status: 'not_run' },
      ],
    })
  })

  test('is written whole under the root, and replaced by the next run', () => {
    const root = tempFolder('last-run-')
    writeLastRun(root, lastRunOf(result))
    writeLastRun(root, { ...lastRunOf(result), runId: 'run-2', tests: [] })
    assert.deepEqual(JSON.parse(readFileSync(join(root, lastRunFile), 'utf8')), { schemaVersion: 1, runId: 'run-2', finishedAt: '2026-09-30T12:00:00.000Z', tests: [] })
  })
})
