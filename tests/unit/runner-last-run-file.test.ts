import type { RunOptions } from '../../src/runner/contract.ts'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { lastRunFile, lastRunSchema } from '../../src/protocol/last-run.ts'
import { parse } from '../../src/protocol/schema.ts'
import { lastRunPath } from '../../src/runner/last-run.ts'
import { runFiles } from '../../src/runner/run.ts'
import { fakeLauncher } from '../support/fake-browser.ts'
import { tempProject } from '../support/project.ts'
import { eventsOfType, newRunFolder, quickTimeouts, readEvents } from '../support/run-harness.ts'
import { tempFolder } from '../support/temp-folder.ts'

const tests = `import { expect, test } from '@rehearsal-labs/retest'

test('fails', async ({ page }) => {
  await page.goto('/')
  expect(1).toBe(2)
})
`

// Runs the project's one failing test, with `lastRunFile` as given, and returns what the run wrote.
async function runIn(root: string, lastRun?: RunOptions['lastRunFile']) {
  const { launch } = fakeLauncher()
  const outputDir = newRunFolder()
  const result = await runFiles(
    {
      files: ['tests/a.retest.ts'],
      rootDir: root,
      apps: { kind: 'browser', browserPath: '/fake/chromium', baseUrl: 'http://127.0.0.1:4173' },
      timeouts: quickTimeouts,
      outputDir,
      headless: true,
      signal: new AbortController().signal,
      ...(lastRun === undefined ? {} : { lastRunFile: lastRun }),
    },
    [],
    launch,
  )
  return { result, events: readEvents(outputDir).events }
}

function recordedTests(path: string): string[] {
  const parsed = parse(lastRunSchema, JSON.parse(readFileSync(path, 'utf8')))
  assert.ok(parsed.ok)
  return parsed.value.tests.map((entry) => entry.testId)
}

describe('lastRunFile', () => {
  test('false records nothing, and leaves no .retest folder under the root, where the default records', async () => {
    const recorded = tempProject({ 'tests/a.retest.ts': tests })
    await runIn(recorded)
    assert.deepEqual(recordedTests(join(recorded, lastRunFile)), ['tests/a.retest.ts > fails'])
    const unrecorded = tempProject({ 'tests/a.retest.ts': tests })
    const { result } = await runIn(unrecorded, false)
    assert.equal(result.exitCode, 1)
    assert.equal(existsSync(join(unrecorded, '.retest')), false)
  })

  test('a path records there, making its folder, and nothing under the root', async () => {
    const root = tempProject({ 'tests/a.retest.ts': tests })
    const path = join(tempFolder('last-run-'), 'records', 'run.json')
    const { result } = await runIn(root, path)
    assert.equal(result.exitCode, 1)
    assert.deepEqual(recordedTests(path), ['tests/a.retest.ts > fails'])
    assert.equal(existsSync(join(root, '.retest')), false)
  })

  test('a path the run cannot write is a failure to keep the output, naming that path', async () => {
    const root = tempProject({ 'tests/a.retest.ts': tests })
    const blocker = join(tempFolder('last-run-'), 'a-file')
    writeFileSync(blocker, '')
    const path = join(blocker, 'run.json')
    const { result, events } = await runIn(root, path)
    assert.equal(result.exitCode, 2)
    assert.equal(result.failure?.class, 'reporting_failed')
    assert.match(result.failure?.message ?? '', new RegExp(`^Retest could not write ${path.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `))
    assert.deepEqual(eventsOfType(events, 'run.finished')[0]?.failure, result.failure)
  })

  test('a relative path is resolved from the current directory, as the output folder is', () => {
    const root = tempFolder('last-run-')
    assert.equal(lastRunPath(root, undefined), join(root, lastRunFile))
    assert.equal(lastRunPath(root, 'records/run.json'), resolve('records/run.json'))
    assert.equal(lastRunPath(root, false), undefined)
  })
})
