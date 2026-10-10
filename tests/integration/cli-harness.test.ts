import type { RetestEvent } from '../../src/protocol/events.ts'
import type { FinishedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { eventsFile } from '../../src/protocol/run-folder.ts'
import { passingRun, resultOf } from '../unit/reporters-fixtures.ts'
import { assertKilledStdoutIsEventPrefix, assertStdoutIsEvents, readFinishedRun, RetestProcess, scratchFolder } from './cli-harness.ts'

const events: RetestEvent[] = [0, 1, 2].map((sequence) => ({
  schemaVersion: 1,
  runId: 'killed-prefix',
  sequence,
  time: '2026-10-10T00:00:00.000Z',
  elapsedMs: sequence,
  origin: 'parent',
  type: 'app.reused',
  app: `web-${sequence}`,
  ready: 'http://127.0.0.1:4310/',
}))

function lines(events: readonly RetestEvent[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join('')
}

function killedRun(stdout: string): FinishedRun {
  return { exit: { code: null, signal: 'SIGKILL' }, stdout, stderr: '', durationMs: 0, output: '/unused', events, result: undefined }
}

test('a killed JSONL reporter may deliver none, a prefix, or all of its saved events', () => {
  for (const length of [0, 1, 2, 3]) assertKilledStdoutIsEventPrefix(killedRun(lines(events.slice(0, length))))
})

test('a killed reporter validates a complete final JSON event even without its newline', () => {
  assertKilledStdoutIsEventPrefix(killedRun(lines(events.slice(0, 2)).slice(0, -1)))
})

test('a killed reporter may stop only midway through its final JSON line', () => {
  const tail = JSON.stringify(events[1]).slice(0, 40)
  assertKilledStdoutIsEventPrefix(killedRun(`${lines(events.slice(0, 1))}${tail}`))
})

test('a divergent complete event cannot be treated as interrupted delivery', () => {
  const first = events[0]
  const event = events[1]
  assert.ok(first && event?.type === 'app.reused')
  assert.throws(() => assertKilledStdoutIsEventPrefix(killedRun(lines([first, { ...event, app: 'diverged' }]))), /uninterrupted prefix/)
})

test('missing or repeated interior complete events cannot be treated as an interrupted suffix', () => {
  const first = events[0]
  const second = events[1]
  const third = events[2]
  assert.ok(first && second && third)
  assert.throws(() => assertKilledStdoutIsEventPrefix(killedRun(lines([first, third]))), /numbered in order from 0/)
  assert.throws(() => assertKilledStdoutIsEventPrefix(killedRun(lines([first, first, second]))), /does not follow/)
})

test('stdout cannot contain an event absent from the durable log', () => {
  const last = events.at(-1)
  assert.ok(last)
  assert.throws(() => assertKilledStdoutIsEventPrefix(killedRun(lines([...events, { ...last, sequence: 3 }]))), /uninterrupted prefix/)
})

test('a malformed interior or newline-terminated final line remains an error after SIGKILL', () => {
  const first = lines(events.slice(0, 1))
  assert.throws(() => assertKilledStdoutIsEventPrefix(killedRun(`${first}{"cut\n${lines(events.slice(1, 2))}`)), /line 2 is not valid JSON/)
  assert.throws(() => assertKilledStdoutIsEventPrefix(killedRun(`${first}{"cut\n`)), /line 2 is not valid JSON/)
})

test('a complete invalid-schema or foreign-run final JSON event is refused without its newline too', () => {
  const event = events[1]
  assert.ok(event)
  const first = lines(events.slice(0, 1))
  assert.throws(() => assertKilledStdoutIsEventPrefix(killedRun(`${first}${JSON.stringify({ ...event, schemaVersion: 2 })}`)), /not a version 1 event/)
  assert.throws(() => assertKilledStdoutIsEventPrefix(killedRun(`${first}${JSON.stringify({ ...event, runId: 'foreign-run' })}`)), /belongs to run foreign-run/)
})

test('prefix delivery is allowed only for a confirmed SIGKILL with no settled result', () => {
  const run = killedRun(lines(events.slice(0, 1)))
  for (const exit of [{ code: 0, signal: null }, { code: null, signal: 'SIGTERM' }, { code: 1, signal: 'SIGKILL' }] as const) {
    assert.throws(() => assertKilledStdoutIsEventPrefix({ ...run, exit }), /fatally killed/)
  }
  assert.throws(() => assertKilledStdoutIsEventPrefix({ ...run, result: resultOf(passingRun('/work')) }), /no settled result/)
})

test('settled stdout still requires every durable event and the final newline', () => {
  const saved = passingRun('/work')
  const result = resultOf(saved)
  const run = { ...killedRun(lines(saved)), events: saved, exit: { code: result.exitCode, signal: null }, result }
  assertStdoutIsEvents(run)
  assert.throws(() => assertStdoutIsEvents({ ...run, stdout: lines(saved.slice(0, -1)) }), /exactly the events/)
  assert.throws(() => assertStdoutIsEvents({ ...run, stdout: lines(saved).slice(0, -1) }), /whole line/)
})

test('a real SIGKILL between the event append and reporter delivery leaves a valid durable suffix', { timeout: 5000 }, async (t) => {
  const output = await scratchFolder(t, 'retest-killed-event-log-')
  const source = `
    import { EventLog } from ${JSON.stringify(new URL('../../src/runner/event-log.ts', import.meta.url).href)}
    import { RunStore } from ${JSON.stringify(new URL('../../src/store/run-store.ts', import.meta.url).href)}
    import { createJsonlReporter } from ${JSON.stringify(new URL('../../src/reporters/jsonl.ts', import.meta.url).href)}
    const store = RunStore.create(${JSON.stringify(output)})
    const log = new EventLog({ runId: 'actual-kill', store, reporters: [createJsonlReporter({ stdout: process.stdout })], elapsedMs: () => 0, onFailure: problem => { throw new Error(problem.message) } })
    log.emit({ type: 'app.reused', app: 'delivered', ready: 'http://127.0.0.1:4310/' })
    await log.flush()
    log.emit({ type: 'app.reused', app: 'saved-before-kill', ready: 'http://127.0.0.1:4310/' })
    process.kill(process.pid, 'SIGKILL')
  `
  const retest = await RetestProcess.start(t, { args: [], command: [process.execPath, '--conditions=retest-source', '--input-type=module', '-e', source] })
  const run = await readFinishedRun({ retest, output })
  assert.equal(run.events.length, 2)
  assert.equal(run.stdout.split('\n').length, 2, 'one event was actually delivered')
  assertKilledStdoutIsEventPrefix(run)
  assert.throws(() => assertStdoutIsEvents(run), /exactly the events/)
})

for (const signal of ['SIGKILL', undefined] as const) {
  test(`the harness ${signal === 'SIGKILL' ? 'reads' : 'refuses'} a torn saved final line after ${signal ?? 'an ordinary exit'}`, { timeout: 5000 }, async (t) => {
    const output = await scratchFolder(t, 'retest-killed-log-tail-')
    const text = `${lines(events.slice(0, 2))}${JSON.stringify(events[2]).slice(0, 40)}`
    const stdout = `${lines(events.slice(0, 1))}${JSON.stringify(events[1]).slice(0, 40)}`
    const source = `
      import { writeFileSync } from 'node:fs'
      writeFileSync(${JSON.stringify(join(output, eventsFile))}, ${JSON.stringify(text)})
      process.stdout.write(${JSON.stringify(stdout)})
      ${signal === undefined ? '' : `process.kill(process.pid, ${JSON.stringify(signal)})`}
    `
    const retest = await RetestProcess.start(t, { args: [], command: [process.execPath, '--input-type=module', '-e', source] })
    const reading = readFinishedRun({ retest, output })
    if (signal === undefined) {
      await assert.rejects(reading, /events end with a whole line/)
      return
    }
    const run = await reading
    assert.deepEqual(run.events, events.slice(0, 2))
    assertKilledStdoutIsEventPrefix(run)
  })
}
