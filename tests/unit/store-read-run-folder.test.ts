import type { RetestEvent } from '../../src/protocol/events.ts'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { runResultSchema } from '../../src/protocol/result.ts'
import { eventsFile, resultFile } from '../../src/protocol/run-folder.ts'
import { parse } from '../../src/protocol/schema.ts'
import { readEvents, readRunFolder, RunFolderReadError } from '../../src/store/read-run-folder.ts'
import { rebuildResult } from '../../src/store/rebuild-result.ts'
import { tempFolder } from '../support/temp-folder.ts'
import { writeRunFolder } from './cli-fixtures.ts'
import { failingRun, file, lateError, lateErrorRun, launchFailureRun, passingRun, resultOf, savesTask, showsCount, stamp } from './reporters-fixtures.ts'
import { hostCheckFailureRun, hostChecksPassRun, noError, notPlaced, offThanks, onThanks, orderPlaced } from './reporters-host-check-fixtures.ts'

// The recorded runs name their root directory; no file of it is read.
const root = '/work/tasks'
const checkout = '/work/checkout'
const workspace = tempFolder('store-read-run-folder-')

function lines(events: RetestEvent[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join('')
}

function readError(action: () => unknown): RunFolderReadError {
  try {
    action()
  } catch (error) {
    assert.ok(error instanceof RunFolderReadError, String(error))
    return error
  }
  assert.fail('expected a RunFolderReadError')
}

function readErrorMessage(action: () => unknown): string {
  return readError(action).message
}

// Everything up to the moment the first test's check was still polling: a run killed mid-test.
function killedMidTest(): RetestEvent[] {
  const events = failingRun(root)
  return events.slice(
    0,
    events.findIndex((event) => event.type === 'assertion.failed'),
  )
}

describe('readEvents', () => {
  test('reads every line of a whole file', () => {
    const events = passingRun(root)
    assert.deepEqual(readEvents(lines(events)), { ok: true, events })
    assert.deepEqual(readEvents(''), { ok: true, events: [] })
  })

  test('leaves out a last line cut off while it was written, and says which', () => {
    const events = passingRun(root)
    const text = `${lines(events.slice(0, 5))}${JSON.stringify(events[5]).slice(0, 40)}`
    assert.deepEqual(readEvents(text), { ok: true, events: events.slice(0, 5), tornLine: 6 })
  })

  test('accepts a whole last line without its line break', () => {
    const events = passingRun(root)
    assert.deepEqual(readEvents(lines(events).slice(0, -1)), { ok: true, events })
  })

  test('refuses a bad line anywhere but the end', () => {
    const events = passingRun(root)
    const text = `${lines(events.slice(0, 2))}{"cut\n${lines(events.slice(2))}`
    assert.deepEqual(readEvents(text), { ok: false, problem: 'line 3 is not valid JSON' })
    assert.deepEqual(readEvents(`${lines(events.slice(0, 1))}\n`), { ok: false, problem: 'line 2 is not valid JSON' })
  })

  test('refuses a line that is JSON but not a version 1 event, even the last', () => {
    const events = passingRun(root)
    const reading = readEvents(`${lines(events.slice(0, 2))}${JSON.stringify({ ...events[2], schemaVersion: 2 })}`)
    assert.equal(reading.ok, false)
    assert.match(
      reading.ok ? '' : reading.problem,
      /^line 3 is not a version 1 event: \$\.schemaVersion expected 1, received 2/,
    )
  })

  test('refuses events from two runs or out of order', () => {
    const events = passingRun(root)
    const other = stamp([{ type: 'navigation', testId: savesTask, attemptId: 'a', url: 'http://x/' }], 'run-2')
    const mixed = readEvents(lines([...events.slice(0, 2), ...other]))
    assert.deepEqual(mixed, { ok: false, problem: 'line 3 belongs to run run-2, not run-1' })
    const swapped = [events[0], events[2], events[1]].flatMap((event) => (event === undefined ? [] : [event]))
    assert.deepEqual(readEvents(lines(swapped)), {
      ok: false,
      problem: 'line 3 has sequence 1, which does not follow 2',
    })
  })
})

describe('rebuildResult', () => {
  test('a run killed mid-test is incomplete: the started test is an error, the next did not run', () => {
    const result = rebuildResult(killedMidTest())
    assert.ok(parse(runResultSchema, result).ok)
    assert.equal(result.complete, false)
    assert.equal(result.status, 'error')
    assert.equal(result.exitCode, 2)
    assert.deepEqual(result.counts, { passed: 0, failed: 0, error: 1, notRun: 1, inconclusive: 0 })
    const [saves, count] = result.files[0]?.tests ?? []
    assert.equal(saves?.testId, savesTask)
    assert.equal(saves?.status, 'error')
    assert.equal(saves?.attemptId, 'attempt-1')
    assert.deepEqual(saves?.failure, { class: 'interrupted', message: 'The run stopped before this test finished.' })
    assert.equal(count?.testId, showsCount)
    assert.equal(count?.status, 'not_run')
    assert.deepEqual(count?.failure, { class: 'interrupted', message: 'The run stopped before this test started.' })
    assert.deepEqual(result.browser, {
      product: 'Chrome',
      version: '140.0.7339.80',
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    })
    assert.deepEqual(result.failure, { class: 'interrupted', message: 'The run stopped before it finished.' })
  })

  test('a run that finished without result.json fails for that, keeping the failure it finished with', () => {
    assert.deepEqual(rebuildResult(passingRun(root)).failure, {
      class: 'reporting_failed',
      message: 'The run finished without writing result.json.',
    })
    assert.deepEqual(rebuildResult(launchFailureRun(root)).failure, {
      class: 'setup_failed',
      message: 'No browser at /opt/chromium. Pass the path to a Chromium or Chrome executable.',
      details: { also: 'reporting_failed: The run finished without writing result.json.' },
    })
  })

  test('never reports a completed pass, even when every test passed and the run finished', () => {
    const events = passingRun(root)
    const result = rebuildResult(events)
    assert.deepEqual([result.complete, result.status, result.exitCode], [false, 'error', 2])
    assert.deepEqual(result.counts, { passed: 2, failed: 0, error: 0, notRun: 0, inconclusive: 0 })
    assert.equal(result.startedAt, events[0]?.time)
    assert.equal(result.finishedAt, events.at(-1)?.time)
  })

  test('keeps finished tests as they finished, with their evidence', () => {
    const events = failingRun(root)
    const saves = rebuildResult(events.slice(0, -1)).files[0]?.tests[0]
    assert.equal(saves?.status, 'failed')
    assert.equal(saves?.failure?.class, 'check_failed')
    assert.deepEqual(saves?.evidence, [{ kind: 'screenshot', path: 'artifacts/saves-a-task-failure.png' }])
    assert.equal(saves?.assertionCount, 1)
  })

  test('a file whose process failed keeps that failure, even when the run stopped before it finished', () => {
    const events = lateErrorRun(root)
    assert.deepEqual(rebuildResult(events).files[0]?.failure, lateError)
    const stopped = rebuildResult(events.slice(0, -1))
    assert.deepEqual(stopped.files[0]?.failure, lateError)
    assert.deepEqual(stopped.failure, { class: 'interrupted', message: 'The run stopped before it finished.' })
    assert.equal(rebuildResult(passingRun(root).slice(0, -1)).files[0]?.failure, undefined)
  })

  test('a file never collected is recorded as stopped before collection', () => {
    const [started] = passingRun(root)
    assert.ok(started !== undefined)
    const result = rebuildResult([started])
    assert.deepEqual(result.files, [
      {
        file,
        collection: 'failed',
        failure: { class: 'interrupted', message: 'The run stopped before this file was collected.' },
        tests: [],
      },
    ])
    assert.equal(result.browser, null)
  })

  test("lists the host checks a test's events recorded, in the order they ran", () => {
    assert.deepEqual(rebuildResult(hostCheckFailureRun(checkout)).files[0]?.tests[0]?.hostChecks, [
      { check: onThanks, app: 'web', status: 'failed', failure: offThanks },
      { check: orderPlaced, app: 'web', status: 'failed', failure: notPlaced },
      { check: noError, app: 'web', status: 'passed' },
    ])
    assert.equal(rebuildResult(passingRun(root)).files[0]?.tests[0]?.hostChecks, undefined)
  })

  test('a run cut off during the host checks never passes: a check with no ending is not listed', () => {
    const events = hostChecksPassRun(checkout)
    const cut = events.slice(0, events.findIndex((event) => event.type === 'host_check.passed') + 1)
    const result = rebuildResult(cut)
    assert.ok(parse(runResultSchema, result).ok)
    assert.deepEqual([result.complete, result.status, result.exitCode], [false, 'error', 2])
    const [placed] = result.files[0]?.tests ?? []
    assert.equal(placed?.status, 'error')
    assert.deepEqual(placed?.failure, { class: 'interrupted', message: 'The run stopped before this test finished.' })
    assert.deepEqual(placed?.hostChecks, [{ check: onThanks, app: 'web', status: 'passed' }])
  })

  test('needs the run.started event', () => {
    const events = passingRun(root).slice(1)
    assert.match(
      readErrorMessage(() => rebuildResult(events)),
      /events\.jsonl has no run\.started event/,
    )
  })
})

describe('readRunFolder', () => {
  test('a finished run reads from result.json, with its events', () => {
    const events = failingRun(root)
    const folder = writeRunFolder(workspace, 'finished', { events, result: resultOf(events) })
    assert.deepEqual(readRunFolder(folder, 'finished'), {
      source: 'result.json',
      result: resultOf(events),
      events,
      warnings: [],
    })
  })

  // A host reads the folder it chose, and names it no other way.
  test('messages name the folder as given, unless the caller shows it otherwise', () => {
    const missing = join(workspace, 'not-there')
    assert.equal(readErrorMessage(() => readRunFolder(missing)), `No run folder at ${missing}.`)
    assert.equal(readErrorMessage(() => readRunFolder(missing, 'runs/not-there')), 'No run folder at runs/not-there.')
    const error = readError(() => readRunFolder(missing))
    assert.equal(error.name, 'RunFolderReadError')
    assert.ok(error instanceof Error)
  })

  test('a file that is there but cannot be read makes the folder unreadable, and keeps the cause', () => {
    const folder = join(workspace, 'result-is-a-folder')
    mkdirSync(join(folder, resultFile), { recursive: true })
    writeFileSync(join(folder, eventsFile), lines(passingRun(root)))
    const error = readError(() => readRunFolder(folder))
    assert.ok(error.message.startsWith(`${join(folder, resultFile)} could not be read: `), error.message)
    assert.ok(error.cause instanceof Error)
  })

  test('a run without result.json is rebuilt from its events and says so', () => {
    const events = killedMidTest()
    const folder = writeRunFolder(workspace, 'killed', { events, tail: '{"schemaVersion":1,"ty' })
    const read = readRunFolder(folder, 'killed')
    assert.equal(read.source, 'events.jsonl')
    assert.equal(read.result.complete, false)
    assert.deepEqual(read.warnings, [
      `result.json is missing, so the run did not finish. This result is rebuilt from ${events.length} events and marked incomplete.`,
      `events.jsonl ends in a line cut off while it was written (line ${events.length + 1}); it was left out.`,
    ])
  })

  test('a result without usable events still reads, with a warning', () => {
    const events = failingRun(root)
    const result = resultOf(events)
    const missing = readRunFolder(writeRunFolder(workspace, 'no-events', { result }), 'no-events')
    assert.deepEqual(missing.warnings, ['events.jsonl is missing, so steps and check details are not shown.'])
    const broken = readRunFolder(
      writeRunFolder(workspace, 'broken-events', { result, events: [], tail: 'x\ny' }),
      'broken-events',
    )
    assert.deepEqual(broken.events, [])
    assert.match(broken.warnings[0] ?? '', /^events\.jsonl cannot be read \(line 1 is not valid JSON\)/)
    const otherRun = passingRun(root).map((event) => ({ ...event, runId: 'run-9' }))
    const foreign = readRunFolder(writeRunFolder(workspace, 'foreign', { result, events: otherRun }), 'foreign')
    assert.deepEqual(foreign.events, [])
    assert.match(foreign.warnings[0] ?? '', /belongs to run run-9, not run-1/)
  })

  test('refuses what is not a readable run folder', () => {
    assert.equal(
      readErrorMessage(() => readRunFolder(join(workspace, 'nowhere'), 'nowhere')),
      'No run folder at nowhere.',
    )
    writeFileSync(join(workspace, 'plain-file'), '')
    assert.equal(
      readErrorMessage(() => readRunFolder(join(workspace, 'plain-file'), 'plain-file')),
      'plain-file is a file, not a run folder.',
    )
    mkdirSync(join(workspace, 'empty'))
    assert.match(
      readErrorMessage(() => readRunFolder(join(workspace, 'empty'), 'empty')),
      /has neither result\.json nor events\.jsonl/,
    )
    const noEvents = writeRunFolder(workspace, 'nothing', { events: [] })
    assert.match(
      readErrorMessage(() => readRunFolder(noEvents, 'nothing')),
      /has no result\.json and no events: the run stopped before it recorded anything\./,
    )
    const tornOnly = writeRunFolder(workspace, 'torn-only', { tail: '{"schem' })
    assert.match(
      readErrorMessage(() => readRunFolder(tornOnly, 'torn-only')),
      /no events/,
    )
    const badEvents = writeRunFolder(workspace, 'bad-events', { events: passingRun(root), tail: '' })
    writeFileSync(join(badEvents, 'events.jsonl'), 'nonsense\n')
    assert.equal(
      readErrorMessage(() => readRunFolder(badEvents, 'bad-events')),
      'events.jsonl cannot be read: line 1 is not valid JSON.',
    )
  })

  test('refuses a result.json that is not JSON or not a version 1 result', () => {
    const notJson = writeRunFolder(workspace, 'not-json', { result: '{"schemaVersion":' })
    assert.equal(
      readErrorMessage(() => readRunFolder(notJson, 'not-json')),
      'result.json is not valid JSON.',
    )
    const events = passingRun(root)
    const wrong = writeRunFolder(workspace, 'wrong', {
      result: JSON.stringify({ ...resultOf(events), exitCode: 7, extra: true }),
    })
    assert.match(
      readErrorMessage(() => readRunFolder(wrong, 'wrong')),
      /^result\.json does not match the version 1 result: \$\.exitCode expected 0 or 1 or 2 or 130 or 143, received 7; \$\.extra unknown key\.$/,
    )
  })
})
