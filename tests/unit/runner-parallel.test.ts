import type { RunRecord } from '../support/run-harness.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { eventsOfType, runSupportFiles, supportFile } from '../support/run-harness.ts'

const files = ['passing.retest.ts', 'passing-too.retest.ts']

/** The position of a file's first event of a type in the run's events. */
function firstIndex(record: RunRecord, type: 'test.started' | 'test.finished', file: string): number {
  return record.events.findIndex((event) => event.type === type && 'testId' in event && event.testId.startsWith(`${supportFile(file)} >`))
}

describe('test files on workers', () => {
  test('two workers run two files at the same time, sharing one browser, and every test passes', async () => {
    const record = await runSupportFiles(files, { workers: 2, fake: { saveDelayMs: 400 }, timeouts: { assertion: 1500 } })
    assert.equal(record.result.exitCode, 0, JSON.stringify(record.result.counts))
    assert.deepEqual(record.result.counts, { passed: 5, failed: 0, error: 0, notRun: 0, inconclusive: 0 })
    assert.equal(record.browsers.length, 1, 'one browser for both files')
    assert.equal(eventsOfType(record.events, 'run.started')[0]?.options.workers, 2)
    // The second file's first test starts while the first file's first test is still saving.
    assert.ok(firstIndex(record, 'test.started', 'passing-too.retest.ts') < firstIndex(record, 'test.finished', 'passing.retest.ts'), 'the files overlapped')
    assert.deepEqual(record.result.files.map((file) => [file.file, file.collection, file.tests.length]), [
      [supportFile('passing.retest.ts'), 'ok', 3],
      [supportFile('passing-too.retest.ts'), 'ok', 2],
    ])
  })

  test('two workers on two browsers: each file keeps to its own, every browser is an event, and the result lists the target once', async () => {
    const record = await runSupportFiles(files, { workers: 2, browsers: 2, fake: { saveDelayMs: 100 } })
    assert.equal(record.result.exitCode, 0, JSON.stringify(record.result.counts))
    assert.equal(record.browsers.length, 2)
    assert.ok(record.browsers.every((browser) => browser.closed && browser.pages.length > 0), 'both browsers ran tests and were closed')
    assert.equal(eventsOfType(record.events, 'run.started')[0]?.options.browsers, 2)
    assert.deepEqual(eventsOfType(record.events, 'browser.started').map((event) => [event.instances, event.instance]), [
      [2, undefined],
      [undefined, 2],
    ])
    assert.deepEqual(record.result.browser, { product: 'FakeChromium', version: '140.0.0.0', executablePath: '/fake/chromium' })
  })

  test('browsers are never more than the workers or the files: one file runs in one browser, whatever was asked', async () => {
    const record = await runSupportFiles(['passing.retest.ts'], { workers: 4, browsers: 4, fake: { saveDelayMs: 50 } })
    assert.equal(record.result.exitCode, 0)
    assert.equal(record.browsers.length, 1)
    assert.deepEqual(eventsOfType(record.events, 'browser.started').map((event) => [event.instances, event.instance]), [[undefined, undefined]])
  })

  test('one worker runs the files one after another, as before', async () => {
    const record = await runSupportFiles(files, { workers: 1, fake: { saveDelayMs: 100 } })
    assert.equal(record.result.exitCode, 0)
    assert.equal(eventsOfType(record.events, 'run.started')[0]?.options.workers, 1)
    const lastOfFirst = record.events.map((event) => event.type === 'test.finished' && 'testId' in event && event.testId.startsWith(`${supportFile('passing.retest.ts')} >`)).lastIndexOf(true)
    assert.ok(firstIndex(record, 'test.started', 'passing-too.retest.ts') > lastOfFirst, 'the second file waited for the first')
  })
})
