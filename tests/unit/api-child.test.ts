import type { RetestEvent } from '../../src/protocol/events.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runFiles } from '../../src/runner/run.ts'
import { fakeLauncher } from '../support/fake-browser.ts'
import { newRunFolder, quickTimeouts, readEvents, rootDir } from '../support/run-harness.ts'

const file = 'tests/support/api/files/structure.retest.ts'
const id = (title: string): string => `${file} > ${title}`

/** The step and assertion events of one test's attempt, as `kind name` pairs in order. */
function timeline(events: readonly RetestEvent[], testId: string): string[] {
  return events.flatMap((event) => {
    if (!('testId' in event) || event.testId !== testId) return []
    if (event.type === 'step.started') return [`${event.hook ?? 'step'} ${event.name}`]
    if (event.type === 'assertion.passed' || event.type === 'assertion.failed') {
      return [`${event.type === 'assertion.passed' ? 'passed' : event.soft ? 'soft failed' : 'failed'} ${event.matcher}`]
    }
    return []
  })
}

test('blocks, hooks, rows, soft checks and polls run in the process of a test file', async () => {
  const folder = newRunFolder()
  const { launch } = fakeLauncher()
  const result = await runFiles(
    {
      files: [file],
      rootDir,
      apps: { kind: 'browser', browserPath: '/fake/chromium', baseUrl: 'http://127.0.0.1:4173' },
      timeouts: quickTimeouts,
      outputDir: folder,
      headless: true,
      signal: new AbortController().signal,
    },
    [],
    launch,
  )
  const { events } = readEvents(folder)
  const tests = result.files.flatMap((entry) => entry.tests)
  assert.deepEqual(
    tests.map((entry) => [entry.testId, entry.status]),
    [
      [id('tasks > saves a task'), 'passed'],
      [id('tasks > fails, and still cleans up'), 'failed'],
      [id('types "One"'), 'failed'],
      [id('types "Two"'), 'failed'],
    ],
  )
  assert.deepEqual(timeline(events, id('tasks > saves a task')), ['beforeEach beforeEach', 'passed toHaveText', 'afterEach afterEach', 'passed toBeVisible'])

  const cleanedUp = tests.find((entry) => entry.testId === id('tasks > fails, and still cleans up'))
  assert.equal(cleanedUp?.failure?.class, 'check_failed', 'the test keeps its own failure')
  assert.match(cleanedUp?.failure?.message ?? '', /^getByTestId\('saved-task'\) is hidden\./)
  assert.deepEqual(timeline(events, id('tasks > fails, and still cleans up')), [
    'beforeEach beforeEach',
    'failed toBeVisible',
    'afterEach afterEach',
    'passed toBeVisible',
  ])

  const row = tests.find((entry) => entry.testId === id('types "One"'))
  assert.equal(row?.failure?.class, 'check_failed')
  assert.match(row?.failure?.message ?? '', /^getByTestId\('task-title'\) has value "One", expected "Three"\./)
  assert.equal(row?.assertionCount, 2, 'the test went on past its soft failure to the poll')
  assert.deepEqual(timeline(events, id('types "One"')), ['beforeEach beforeEach', 'soft failed toHaveValue', 'passed toBe'])
})
