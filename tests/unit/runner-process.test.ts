import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { newAttemptId } from '../../src/runner/attempt-id.ts'
import { bounded } from '../../src/runner/bounded.ts'
import { loadTests } from '../../src/runner/load-tests.ts'
import { conditionArguments, endedCleanly, TestFileProcess } from '../../src/runner/test-file-process.ts'
import { describeExit } from '../../src/shared/process-exit.ts'
import { isRunning, rootDir, supportFile } from '../support/run-harness.ts'

describe('conditionArguments', () => {
  test('keeps --conditions in each of its forms and drops everything else', () => {
    assert.deepEqual(
      conditionArguments(['--test', '--conditions=retest-source', '-C', 'dev', '--conditions', 'other', '-C=last', '--inspect']),
      ['--conditions=retest-source', '-C', 'dev', '--conditions', 'other', '-C=last'],
    )
    assert.deepEqual(conditionArguments(['--conditions']), [])
    assert.deepEqual(conditionArguments([]), [])
  })
})

describe('waiting', () => {
  test('bounded waits for work, a timeout or a stop, whichever comes first', async () => {
    assert.deepEqual(await bounded(Promise.resolve(3), 1000), { status: 'done', value: 3 })
    const error = new Error('no')
    assert.deepEqual(await bounded(Promise.reject(error), 1000), { status: 'failed', error })
    assert.deepEqual(await bounded(new Promise(() => {}), 10), { status: 'timed_out' })
    assert.deepEqual(await bounded(new Promise(() => {}), 1000, Promise.resolve()), { status: 'stopped' })
  })

  test('describes how a process ended', () => {
    assert.equal(describeExit({ code: 1, signal: null }), 'exit code 1')
    assert.equal(describeExit({ code: null, signal: 'SIGKILL' }), 'signal SIGKILL')
    assert.equal(describeExit({ code: null, signal: null }), 'exit code unknown')
    assert.equal(endedCleanly({ code: 0, signal: null }), true)
    assert.equal(endedCleanly({ code: 1, signal: null }), false)
    assert.equal(endedCleanly({ code: null, signal: 'SIGTERM' }), false)
  })
})

describe('TestFileProcess', () => {
  test('closes when asked and is gone afterwards', async () => {
    const child = TestFileProcess.spawn()
    const pid = child.pid
    assert.ok(pid !== undefined)
    const closed = await child.close(1000)
    assert.deepEqual(closed, { exit: { code: 0, signal: null }, forced: false })
    assert.equal(child.alive, false)
    assert.equal(child.killed, false)
    assert.equal(isRunning(pid), false)
  })

  test('a killed process reports its signal, and sending to it afterwards does nothing', async () => {
    const events: string[] = []
    const child = TestFileProcess.spawn()
    child.listen((event) => events.push(event.kind))
    const exit = await child.kill()
    assert.deepEqual(exit, { code: null, signal: 'SIGKILL' })
    assert.equal(child.killed, true)
    child.send({ type: 'close' })
    assert.deepEqual(events, ['exit'])
    assert.deepEqual(await child.close(1000), { exit, forced: false })
  })

  test('an error thrown while no test runs is kept, and has arrived once the process has closed', async () => {
    const file = supportFile('after-load-error.retest.ts')
    const child = TestFileProcess.spawn({ onOutput: () => undefined })
    const loaded = await loadTests(child, { file, rootDir, timeoutMs: 5000 })
    assert.equal(loaded.ok, true)
    const kinds: string[] = []
    child.listen((event) => kinds.push(event.kind))
    const exit = await child.closed
    assert.deepEqual(exit, { code: 1, signal: null })
    assert.deepEqual(child.errors, [
      { class: 'test_error', message: 'Error: thrown after the file loaded', location: { file, line: 4, column: 9 } },
    ])
    assert.deepEqual(kinds, ['exit'], 'the error is not a message for whoever listens')
    assert.equal(child.killed, false)
  })

  test('a process too busy to close is killed after the grace period, and says so', async () => {
    const file = supportFile('busy-after-load.retest.ts')
    const busy = Promise.withResolvers<void>()
    const child = TestFileProcess.spawn({
      onOutput: (_stream, text) => {
        if (text.includes('busy')) busy.resolve()
      },
    })
    assert.equal((await loadTests(child, { file, rootDir, timeoutMs: 5000 })).ok, true)
    await busy.promise
    const closed = await child.close(200)
    assert.deepEqual(closed, { exit: { code: null, signal: 'SIGKILL' }, forced: true })
    assert.equal(child.killed, true)
  })

  test('an abort or an answer with no test running changes nothing', async () => {
    const output: string[] = []
    const child = TestFileProcess.spawn({ onOutput: (_stream, text) => output.push(text) })
    const kinds: string[] = []
    child.listen((event) => kinds.push(event.kind))
    child.send({ type: 'abort', reason: 'nothing is running' })
    child.send({ type: 'command-result', id: 3, result: { ok: true, kind: 'click' } })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(child.alive, true)
    const { exit } = await child.close(1000)
    assert.equal(exit.code, 0)
    assert.deepEqual(kinds, ['exit'])
    assert.deepEqual(output, [])
  })
})

describe('newAttemptId', () => {
  test('is ten random lowercase letters and digits', () => {
    const ids = Array.from({ length: 1000 }, () => newAttemptId())
    for (const id of ids) assert.match(id, /^[a-z0-9]{10}$/)
    assert.equal(new Set(ids).size, ids.length)
    const characters = new Set(ids.join(''))
    assert.ok(characters.size > 30, `only ${characters.size} different characters appeared`)
  })
})
