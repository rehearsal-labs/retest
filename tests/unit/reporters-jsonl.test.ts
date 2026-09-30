import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { retestEventSchema } from '../../src/protocol/events.ts'
import { truncateText } from '../../src/protocol/failures.ts'
import { parse } from '../../src/protocol/schema.ts'
import { createJsonlReporter } from '../../src/reporters/jsonl.ts'
import { capture, failingRun, projectFolder, resultOf, stamp } from './reporters-fixtures.ts'

describe('jsonl reporter', () => {
  test('writes each event as one line that parses back to the same valid event', async () => {
    const events = failingRun(projectFolder())
    const stdout = capture()
    const reporter = createJsonlReporter({ stdout })
    for (const event of events) await reporter.onEvent(event)
    await reporter.onRunEnd(resultOf(events))
    const lines = stdout.text.split('\n')
    assert.equal(lines.pop(), '')
    assert.equal(lines.length, events.length)
    for (const [index, line] of lines.entries()) {
      const parsed = parse(retestEventSchema, JSON.parse(line))
      assert.ok(parsed.ok, line)
      assert.deepEqual(parsed.value, events[index])
    }
  })

  test('keeps page text with line breaks and line separators inside one line', () => {
    const text = 'one\ntwo\r\nthree four five'
    const [event] = stamp([
      {
        type: 'assertion.passed',
        testId: 'a > b',
        attemptId: 'attempt-1',
        matcher: 'toHaveText',
        expected: truncateText(text),
        actual: truncateText(text),
        attempts: 1,
        durationMs: 1,
      },
    ])
    assert.ok(event !== undefined)
    const stdout = capture()
    createJsonlReporter({ stdout }).onEvent(event)
    assert.equal(stdout.text.split('\n').length, 2)
    assert.deepEqual(JSON.parse(stdout.text), event)
  })

  test('writes nothing when the run ends', () => {
    const events = failingRun(projectFolder())
    const stdout = capture()
    createJsonlReporter({ stdout }).onRunEnd(resultOf(events))
    assert.equal(stdout.text, '')
  })
})
