import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'
import { exitCodeAfterOutput, messageTerminal, reportTerminal, shouldUseColor, terminalMarks } from '../../src/cli/terminal.ts'
import { renderMediaInstall } from '../../src/cli/install/media-report.ts'
import { describeResult } from '../../src/cli/install/report.ts'
import { createHumanReporter } from '../../src/reporters/human.ts'
import { consoleMarks, createStyle, unicodeMarks } from '../../src/reporters/style.ts'
import { capture, passingRun, projectFolder, resultOf } from './reporters-fixtures.ts'

describe('shouldUseColor', () => {
  test('colours a terminal only, and not when NO_COLOR has a value', () => {
    assert.equal(shouldUseColor(capture(true), {}), true)
    assert.equal(shouldUseColor(capture(true), { NO_COLOR: '' }), true)
    assert.equal(shouldUseColor(capture(true), { NO_COLOR: '1' }), false)
    assert.equal(shouldUseColor(capture(true), { NO_COLOR: 'false' }), false)
    assert.equal(shouldUseColor(capture(false), {}), false)
  })
})

describe('terminalMarks', () => {
  test('a Windows console that names no terminal of its own gets marks its fonts have', () => {
    assert.deepEqual(terminalMarks(capture(true), {}, 'win32'), consoleMarks)
    assert.deepEqual(terminalMarks(capture(true), { TERM: '' }, 'win32'), consoleMarks)
    assert.deepEqual(consoleMarks, { passed: '√', failed: '×', step: '►', lineBreak: '¶' })
  })

  test('Windows Terminal, an editor terminal, a terminal that sets TERM, any output that is not a terminal, and macOS and Linux get the glyphs', () => {
    for (const env of [{ WT_SESSION: '0f3c' }, { TERM_PROGRAM: 'vscode' }, { TERM: 'xterm-256color' }]) assert.deepEqual(terminalMarks(capture(true), env, 'win32'), unicodeMarks)
    assert.deepEqual(terminalMarks(capture(false), {}, 'win32'), unicodeMarks)
    for (const platform of ['darwin', 'linux'] as const) assert.deepEqual(terminalMarks(capture(true), {}, platform), unicodeMarks)
    assert.deepEqual(unicodeMarks, { passed: '✓', failed: '✗', step: '▸', lineBreak: '⏎' })
  })

  test('the human report draws the marks it is given', () => {
    const stdout = capture(true)
    const reporter = createHumanReporter({ stdout, stderr: capture(true), color: false, marks: consoleMarks, runFolder: 'run' })
    const events = passingRun(projectFolder())
    for (const event of events) reporter.onEvent(event)
    reporter.onRunEnd(resultOf(events))
    assert.match(stdout.text, /\n {4}√ /)
    assert.doesNotMatch(stdout.text, /[✓✗]/)
  })

  test('the install reports draw the marks they are given', () => {
    const refused = { ok: false, message: 'Nothing is pinned here.', stopped: false } as const
    assert.equal(describeResult('chromium', refused, createStyle(false, consoleMarks)).startsWith('  × chromium'), true)
    assert.equal(describeResult('chromium', refused, createStyle(false)).startsWith('  ✗ chromium'), true)
    assert.equal(renderMediaInstall(refused, consoleMarks), '  × media            Nothing is pinned here.\n')
    assert.equal(renderMediaInstall(refused), '  ✗ media            Nothing is pinned here.\n')
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
