import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'
import { exitCodeAfterOutput, messageTerminal, reportTerminal, shouldUseColor } from '../../src/cli/terminal.ts'
import { capture } from './reporters-fixtures.ts'

describe('shouldUseColor', () => {
  test('colours a terminal only, and not when NO_COLOR has a value', () => {
    assert.equal(shouldUseColor(capture(true), {}), true)
    assert.equal(shouldUseColor(capture(true), { NO_COLOR: '' }), true)
    assert.equal(shouldUseColor(capture(true), { NO_COLOR: '1' }), false)
    assert.equal(shouldUseColor(capture(true), { NO_COLOR: 'false' }), false)
    assert.equal(shouldUseColor(capture(false), {}), false)
  })
})

describe('exitCodeAfterOutput', () => {
  test('turns a pass into 2 when output failed and leaves every other code alone', () => {
    assert.equal(exitCodeAfterOutput(0, true), 2)
    assert.equal(exitCodeAfterOutput(0, false), 0)
    for (const code of [1, 2, 130, 143] as const) {
      assert.equal(exitCodeAfterOutput(code, true), code)
      assert.equal(exitCodeAfterOutput(code, false), code)
    }
  })
})

// A process stream whose pipe the reader closed: it takes writes and then reports the error.
class ClosedPipe extends EventEmitter {
  readonly written: string[] = []
  readonly isTTY = false

  write(text: string): boolean {
    this.written.push(text)
    return true
  }

  close(): void {
    this.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
  }
}

describe('output terminals', () => {
  test('a closed report stream is kept as its failure, and writing to it afterwards throws', () => {
    const pipe = new ClosedPipe()
    const stdout = reportTerminal(pipe)
    stdout.terminal.write('before\n')
    assert.equal(stdout.failure(), undefined)
    pipe.close()
    assert.equal(stdout.failure()?.message, 'write EPIPE')
    assert.throws(() => stdout.terminal.write('after\n'), /^Error: Cannot write the report to stdout: write EPIPE$/)
    assert.deepEqual(pipe.written, ['before\n'])
  })

  test('a closed message stream neither crashes nor counts against a report that was delivered', () => {
    const pipe = new ClosedPipe()
    const stderr = messageTerminal(pipe)
    const stdout = reportTerminal(new ClosedPipe())
    pipe.close()
    stderr.write('a line the test printed\n')
    assert.equal(stdout.failure(), undefined)
    assert.equal(exitCodeAfterOutput(0, stdout.failure() !== undefined), 0)
  })
})
