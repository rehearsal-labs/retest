import type { EventBody, RetestEvent } from '../../src/protocol/events.ts'
import type { Failure } from '../../src/protocol/failures.ts'
import type { RunResult } from '../../src/protocol/result.ts'
import type { Reporter } from '../../src/reporters/reporter.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { EventLog } from '../../src/runner/event-log.ts'
import { RunStore } from '../../src/store/run-store.ts'
import { tempFolder } from '../support/temp-folder.ts'

const started: EventBody = { type: 'browser.started', product: 'Chrome', version: '140', userAgent: 'Chrome/140', pid: 4242, executablePath: '/opt/chromium/chrome' }

function newStore(): RunStore {
  return RunStore.create(tempFolder('events-'))
}

function newLog(reporters: Reporter[], store = newStore()): { log: EventLog; store: RunStore; failures: Failure[] } {
  const failures: Failure[] = []
  let elapsed = 0
  const log = new EventLog({ runId: 'run-1', store, reporters, elapsedMs: () => elapsed++, onFailure: (problem) => failures.push(problem) })
  return { log, store, failures }
}

function recorder(seen: string[], name: string, delayMs = 0): Reporter {
  return {
    name,
    async onEvent(event: RetestEvent) {
      await sleep(delayMs)
      seen.push(`${name}:${event.sequence}`)
    },
    onRunEnd() {
      seen.push(`${name}:end`)
    },
  }
}

describe('EventLog', () => {
  test('stamps events in order and writes each before reporters see it', async () => {
    const store = newStore()
    const linesOnDisk: number[] = []
    const reporter: Reporter = {
      name: 'counting',
      onEvent: () => {
        linesOnDisk.push(readFileSync(join(store.directory, 'events.jsonl'), 'utf8').split('\n').length - 1)
      },
      onRunEnd: () => undefined,
    }
    const { log } = newLog([reporter], store)
    const first = log.emit(started)
    const second = log.emit(started)
    await log.flush()
    assert.deepEqual([first.schemaVersion, first.runId, first.sequence, first.elapsedMs], [1, 'run-1', 0, 0])
    assert.deepEqual([second.sequence, second.elapsedMs], [1, 1])
    assert.match(first.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    assert.ok((linesOnDisk[0] ?? 0) >= 1, 'the first event was on disk before the reporter ran')
    assert.equal(linesOnDisk.length, 2)
    store.close()
  })

  test('awaits each reporter in order for each event, even when one is slow', async () => {
    const seen: string[] = []
    const { log, store } = newLog([recorder(seen, 'slow', 20), recorder(seen, 'fast')])
    log.emit(started)
    log.emit(started)
    await log.flush()
    assert.deepEqual(seen, ['slow:0', 'fast:0', 'slow:1', 'fast:1'])
    store.close()
  })

  test('a reporter that throws is dropped, the others go on, and the run is told once, by its name', async () => {
    const seen: string[] = []
    let calls = 0
    const broken: Reporter = {
      name: 'terminal',
      onEvent: () => {
        calls++
        throw new Error('stdout closed')
      },
      onRunEnd: () => undefined,
    }
    const { log, store, failures } = newLog([broken, recorder(seen, 'kept')])
    log.emit(started)
    log.emit(started)
    await log.flush()
    assert.equal(calls, 1)
    assert.deepEqual(seen, ['kept:0', 'kept:1'])
    assert.deepEqual(failures, [{ class: 'reporting_failed', message: 'The terminal reporter failed on browser.started: stdout closed' }])
    assert.deepEqual(log.failures, failures)
    store.close()
  })

  test('a failure at the end of the run is recorded too', async () => {
    const { log, store, failures } = newLog([
      {
        name: 'summary',
        onEvent: () => undefined,
        onRunEnd: async () => {
          throw new Error('disk full')
        },
      },
    ])
    const result: RunResult = {
      schemaVersion: 1,
      runId: 'run-1',
      retestVersion: '0.0.0',
      startedAt: '',
      finishedAt: '',
      complete: true,
      status: 'passed',
      exitCode: 0,
      durationMs: 0,
      browser: null,
      counts: { passed: 0, failed: 0, error: 0, notRun: 0, inconclusive: 0 },
      files: [],
    }
    await log.end(result)
    assert.equal(failures[0]?.message, 'The summary reporter failed on the end of the run: disk full')
    store.close()
  })

  test('an events file that cannot be written is a reporting failure, and reporters still hear of events', async () => {
    const seen: string[] = []
    const { log, store, failures } = newLog([recorder(seen, 'kept')])
    store.close()
    log.emit(started)
    log.emit(started)
    await log.flush()
    assert.equal(failures.length, 1)
    assert.match(failures[0]?.message ?? '', /^Retest could not write events\.jsonl: /)
    assert.deepEqual(seen, ['kept:0', 'kept:1'])
  })

  test('keeps every different failure in order, each once', async () => {
    const broken = (name: string): Reporter => ({
      name,
      onEvent: () => {
        throw new Error('gone')
      },
      onRunEnd: () => undefined,
    })
    const { log, store, failures } = newLog([broken('first'), broken('second')])
    log.emit(started)
    await log.flush()
    log.reportFailure({ class: 'reporting_failed', message: 'Retest could not keep the output of a.retest.ts: gone' })
    log.reportFailure({ class: 'reporting_failed', message: 'Retest could not keep the output of a.retest.ts: gone' })
    assert.deepEqual(
      log.failures.map((failure) => failure.message),
      [
        'The first reporter failed on browser.started: gone',
        'The second reporter failed on browser.started: gone',
        'Retest could not keep the output of a.retest.ts: gone',
      ],
    )
    assert.deepEqual(failures, log.failures)
    store.close()
  })
})

test('emitPersisted returns append success, then false for a failed store and every later event', async () => {
  const { log, store, failures } = newLog([])
  assert.equal(log.emitPersisted(started), true)
  store.close()
  assert.equal(log.emitPersisted(started), false)
  assert.equal(log.emitPersisted(started), false)
  await log.flush()
  assert.equal(failures.length, 1)
  assert.equal(failures[0]?.class, 'reporting_failed')
})
