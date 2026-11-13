import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHumanReporter } from '../../src/reporters/human.ts'
import { rebuildResult } from '../../src/store/rebuild-result.ts'
import { capture } from './reporters-fixtures.ts'
import { eventsOfType, runSupportFiles } from '../support/run-harness.ts'

// A check that something is gone passes when nothing matches, so a locator that finds nothing anywhere, as a misspelt
// test id does, passes it for ever. Such a check still passes, and the record says so: each event, the result's count,
// and one line of the human report.

const record = await runSupportFiles(['never-matched.retest.ts'])

test('each pass on a locator no look of its attempt found is marked, and a pass on an element that is there is not', () => {
  assert.equal(record.result.status, 'passed')
  assert.deepEqual(
    eventsOfType(record.events, 'assertion.passed').map((event) => [event.matcher, event.locator, event.neverMatched ?? false]),
    [
      ['toBeHidden', { by: 'testId', value: 'missing' }, true],
      ['toHaveCount', { by: 'testId', value: 'missing' }, true],
      ['toBeHidden', { by: 'testId', value: 'hidden-note' }, false],
    ],
  )
})

test('the result counts them, and a result rebuilt from the events counts the same', () => {
  assert.equal(record.result.neverMatchedChecks, 2)
  assert.equal(record.written?.neverMatchedChecks, 2)
  assert.equal(rebuildResult(record.events).neverMatchedChecks, 2)
})

test('the human report says it in one line of its summary', () => {
  const stdout = capture()
  const reporter = createHumanReporter({ stdout, stderr: capture(), color: false, runFolder: record.folder })
  for (const event of record.events) reporter.onEvent(event)
  reporter.onRunEnd(record.result)
  const lines = stdout.text.split('\n').filter((line) => line.includes('matched nothing'))
  assert.equal(lines.length, 1, stdout.text)
  assert.match(lines[0] ?? '', /^ {2}No match +2 checks passed with a locator that matched nothing in their test$/)
})
