import type { EventBody } from '../../src/protocol/events.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { RunningTest } from '../../src/runner/running-test.ts'
import { TestFileProcess } from '../../src/runner/test-file-process.ts'
import { FakeBrowser } from '../support/fake-browser.ts'
import { quickTimeouts } from '../support/run-harness.ts'

describe('RunningTest', () => {
  test('a body due in a process that has already ended never starts, and the report says how the process ended', async () => {
    const child = TestFileProcess.spawn()
    const exit = await child.kill()
    const browser = new FakeBrowser({}, { executablePath: '/fake/chromium', logFile: '/dev/null', headless: true })
    const page = await browser.newPage({}, 1000)
    const emitted: EventBody[] = []
    const running = new RunningTest({
      process: child,
      page,
      testId: 'a.retest.ts > runs',
      attemptId: 'attempt-1',
      timeouts: quickTimeouts,
      emit: (body) => emitted.push(body),
    })
    assert.deepEqual(await running.run(), { assertionCount: 0, endedBeforeStart: exit, timedOut: false })
    await running.settle(0)
    running.close()
    assert.deepEqual(emitted, [])
  })
})
