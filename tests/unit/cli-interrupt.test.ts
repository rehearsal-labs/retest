import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'
import { abortOnInterrupt } from '../../src/cli/interrupt.ts'
import { capture } from './reporters-fixtures.ts'

describe('abortOnInterrupt', () => {
  test('the first interrupt aborts the run and says how to quit; the second exits with 130', () => {
    const source = new EventEmitter()
    const stderr = capture()
    const exits: number[] = []
    const signal = abortOnInterrupt({ source, stderr, exit: (code) => exits.push(code) })
    assert.equal(signal.aborted, false)
    source.emit('SIGINT')
    assert.deepEqual([signal.aborted, signal.reason], [true, 'SIGINT'])
    assert.deepEqual(exits, [])
    assert.equal(stderr.text, '\nStopping. Press Ctrl+C again to quit at once.\n')
    source.emit('SIGINT')
    assert.deepEqual(exits, [130])
  })

  test('SIGTERM stops the run the same way, with its name as the reason; a second signal exits with its own code', () => {
    const source = new EventEmitter()
    const stderr = capture()
    const exits: number[] = []
    const signal = abortOnInterrupt({ source, stderr, exit: (code) => exits.push(code) })
    source.emit('SIGTERM')
    assert.deepEqual([signal.aborted, signal.reason], [true, 'SIGTERM'])
    assert.equal(stderr.text, '\nStopping on SIGTERM. A second signal quits at once.\n')
    assert.deepEqual(exits, [])
    source.emit('SIGTERM')
    source.emit('SIGINT')
    assert.deepEqual(exits, [143, 130])
  })
})
