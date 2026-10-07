import type { RetestEvent } from '../../src/protocol/events.ts'
import type { Failure } from '../../src/protocol/failures.ts'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { truncateText } from '../../src/protocol/failures.ts'
import { runResultSchema } from '../../src/protocol/result.ts'
import { parse } from '../../src/protocol/schema.ts'
import { fakeCli, writeRunFolder } from './cli-fixtures.ts'
import { plain } from './reporters-fixtures.ts'
import {
  checkoutProject,
  hostCheckFailureRun,
  hostCheckResult,
  hostChecksPassRun,
  observed,
  onThanks,
  placesOrder,
} from './reporters-host-check-fixtures.ts'

const root = checkoutProject()
mkdirSync(join(root, 'runs'))

function folder(name: string, events: RetestEvent[], finished = true): string {
  writeRunFolder(join(root, 'runs'), name, finished ? { events, result: hostCheckResult(events) } : { events })
  return `runs/${name}`
}

async function inspect(args: string[], options: { isTTY?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const fake = fakeCli({ cwd: root, ...options })
  const code = await fake.cli(['inspect', ...args])
  return { code, stdout: fake.stdout.text, stderr: fake.stderr.text }
}

// The lines of a timeline from its first event to the test's end, without the column of times.
function timeline(stdout: string): string[] {
  const lines = stdout.split('\n')
  const start = lines.findIndex((line) => line.endsWith('started'))
  const end = lines.findIndex((line, index) => index > start && line === '')
  return lines.slice(start, end).map((line) => line.replace(/^ {2}[ \d.ms]{9} {2}/, ''))
}

function edited(events: RetestEvent[], change: (event: RetestEvent) => RetestEvent[]): RetestEvent[] {
  return events.flatMap(change)
}

const pass = folder('pass', hostChecksPassRun(root))
const fail = folder('fail', hostCheckFailureRun(root))

describe('inspect one test with looks and host checks', () => {
  test('looks sit under the assertion that rested on them, presses read as the test wrote them, host checks follow the body', async () => {
    const { code, stdout, stderr } = await inspect([pass, '--test', placesOrder])
    assert.equal(code, 0)
    assert.equal(stderr, '')
    assert.match(stdout, /\n {2}Passed · 900 ms · 1 check · 3 host checks\n/)
    assert.deepEqual(timeline(stdout), [
      'started',
      'web  goto → http://127.0.0.1:4173/cart  40 ms',
      'web  navigated to http://127.0.0.1:4173/cart',
      "web  fill getByLabel('Coupon'), 6 characters  12 ms",
      "web  getByLabel('Coupon').press('Enter')  9 ms",
      "✓ toHaveText getByTestId('total')  60 ms",
      '  looked 2 times, passed on o2: 1 match, text "$18.00"',
      "web  page.keyboard.press('Enter')  7 ms",
      'web  ✓ host check address: http://127.0.0.1:4173/thanks  10 ms, 1 look',
      'web  ✓ host check text named "order confirmed": "Order placed"  20 ms, 2 looks',
      'web  ✓ host check text: no "Error", any case  10 ms, 1 look',
      'passed  900 ms',
    ])
  })

  test('a failed host check says what the page showed, and the card follows', async () => {
    const { stdout } = await inspect([fail, '--test', placesOrder])
    assert.deepEqual(timeline(stdout).slice(8, 13), [
      'web  ✗ host check address: http://127.0.0.1:4173/thanks  5s, 14 looks  host_check_failed',
      '       page http://127.0.0.1:4173/cart',
      'web  ✗ host check text named "order confirmed": "Order placed"  5s, 14 looks  host_check_failed',
      '       page http://127.0.0.1:4173/cart, text not found',
      'web  ✓ host check text: no "Error", any case  10 ms, 1 look',
    ])
    assert.match(stdout, /\n {4}Host check failed {2}address on web\n {4}Expected {9}http:\/\/127\.0\.0\.1:4173\/thanks\n/)
  })

  test('--json keeps its shape and carries the looks and the host checks, even for a run rebuilt from its events', async () => {
    const { stdout } = await inspect([folder('unwritten', hostCheckFailureRun(root), false), '--test', placesOrder, '--json'])
    const report: unknown = JSON.parse(stdout)
    assert.ok(typeof report === 'object' && report !== null && 'events' in report && Array.isArray(report.events) && 'test' in report)
    assert.deepEqual(Object.keys(report), ['schemaVersion', 'runId', 'complete', 'test', 'events'])
    const types = report.events.map((event: unknown) => (typeof event === 'object' && event !== null && 'type' in event ? event.type : undefined))
    assert.deepEqual(
      types.filter((type: unknown) => type === 'observation' || (typeof type === 'string' && type.startsWith('host_check'))),
      ['observation', 'observation', 'host_check.failed', 'host_check.failed', 'host_check.passed'],
    )
    assert.ok(typeof report.test === 'object' && report.test !== null && 'hostChecks' in report.test && Array.isArray(report.test.hostChecks))
    assert.equal(report.test.hostChecks.length, 3)
  })

  test('a pass the test file judged on a value only it holds says so', async () => {
    const valueCheck = edited(hostChecksPassRun(root), (event) => {
      if (event.type !== 'assertion.passed') return [event]
      const { locator, observationId, comparison, pageUrl, session, judgedBy, ...fields } = event
      return [event, { ...fields, matcher: 'toBe', expected: truncateText('2'), actual: truncateText('2'), attempts: 1, durationMs: 0, judgedBy: 'child' }]
    })
    const { stdout } = await inspect([folder('value', renumbered(valueCheck)), '--test', placesOrder])
    assert.deepEqual(timeline(stdout).slice(5, 8), [
      "✓ toHaveText getByTestId('total')  60 ms",
      '  looked 2 times, passed on o2: 1 match, text "$18.00"',
      '✓ toBe  0 ms, 1 look, reported by the test file',
    ])
  })

  test('looks no assertion claimed stay where they happened, one line for each run of them', async () => {
    const violation: Failure = { class: 'test_error', message: 'The test file claimed a pass the page did not show.' }
    const events = edited(hostChecksPassRun(root), (event) => {
      if (event.type === 'assertion.passed' || (event.type === 'action.completed' && event.command === 'press' && event.locator === undefined)) return []
      if (event.type.startsWith('host_check')) return []
      if (event.type === 'test.finished') return [{ ...event, status: 'error', failure: violation }]
      return event.type === 'run.finished' ? [{ ...event, status: 'error', exitCode: 2, counts: { passed: 0, failed: 0, error: 1, notRun: 0, inconclusive: 0 } }] : [event]
    })
    const { stdout } = await inspect([folder('violation', renumbered(events)), '--test', placesOrder])
    assert.deepEqual(timeline(stdout).slice(4, 7), [
      "web  getByLabel('Coupon').press('Enter')  9 ms",
      `web  looked at getByTestId('total') 2 times, last o2: 1 match, text "$18.00"`,
      'error  900 ms',
    ])
  })

  test('page text in a look is quoted with its control characters escaped', async () => {
    const events = edited(hostChecksPassRun(root), (event) =>
      event.type === 'observation' && event.observationId === 'o2' ? [{ ...event, observed: observed('$18.00\u001b[2J\u009b') }] : [event],
    )
    const { stdout } = await inspect([folder('control', events), '--test', placesOrder], { isTTY: true })
    assert.ok(plain(stdout).includes('passed on o2: 1 match, text "$18.00\\u001b[2J\\u009b"'), stdout)
    assert.doesNotMatch(plain(stdout), /\u009b|\u001b\[2J/)
  })
})

describe('inspect a run cut off during its host checks', () => {
  const events = hostChecksPassRun(root)
  const torn = folder('torn', events.slice(0, events.findIndex((event) => event.type === 'host_check.passed') + 1), false)

  test('never reads as a pass: the test is an error, and only the check that ended is listed', async () => {
    const { code, stdout } = await inspect([torn, '--json'])
    assert.equal(code, 0)
    const parsed = parse(runResultSchema, JSON.parse(stdout))
    assert.ok(parsed.ok)
    assert.deepEqual([parsed.value.complete, parsed.value.status, parsed.value.exitCode], [false, 'error', 2])
    const [placed] = parsed.value.files[0]?.tests ?? []
    assert.equal(placed?.status, 'error')
    assert.deepEqual(placed?.hostChecks, [{ check: onThanks, app: 'web', status: 'passed' }])
  })

  test('the report and the timeline show the check that ended and nothing more', async () => {
    const run = await inspect([torn])
    assert.match(run.stdout, /\n {2}Host checks {2}1 passed\n/)
    assert.match(run.stdout, /\n {2}Exit {9}2 · incomplete\n/)
    assert.doesNotMatch(run.stdout, /✓ places an order/)
    const one = await inspect([torn, '--test', placesOrder])
    assert.match(one.stdout, /\n {2}Error · \d+ ms · 1 check · 1 host check\n/)
    assert.deepEqual(timeline(one.stdout).slice(-1), ['web  ✓ host check address: http://127.0.0.1:4173/thanks  10 ms, 1 look'])
    assert.match(one.stdout, /\n {4}Interrupted\n {4}The run stopped before this test finished\.\n/)
  })
})

// Events given again their sequence and times, after some were added or left out.
function renumbered(events: RetestEvent[]): RetestEvent[] {
  return events.map((event, sequence) => ({ ...event, sequence, elapsedMs: sequence * 10, time: new Date(Date.UTC(2026, 8, 30, 9, 15, 0, sequence * 10)).toISOString() }))
}

test('inspect associates variantless retention records by attempt and distinguishes request from completion', async () => {
  const events = hostChecksPassRun(root)
  const started = events.find((event) => event.type === 'test.started')
  assert.ok(started?.type === 'test.started')
  const requested: RetestEvent = { schemaVersion: 1, runId: started.runId, sequence: events.length, time: started.time, elapsedMs: 910, origin: 'parent', type: 'artifact.removal_requested', testId: started.testId, attemptId: started.attemptId, path: 'artifacts/recording.mp4', kind: 'recording', reason: 'passed_attempt_recording', moment: 'attempt_finished', bytes: 5 }
  const completed: RetestEvent = { ...requested, type: 'artifact.removed', sequence: events.length + 1, elapsedMs: 920 }
  const shown = await inspect([folder('retention-completed', renumbered([...events, requested, completed])), '--test', started.testId])
  assert.equal(shown.code, 0, shown.stderr)
  const request = shown.stdout.indexOf('retention removal requested: recording artifacts/recording.mp4')
  const completion = shown.stdout.indexOf('retention removed: recording artifacts/recording.mp4')
  assert.ok(request >= 0)
  assert.ok(completion > request)
})

for (const reason of ['the field reads back masked', 'the field that received the secret is gone'] as const) {
  test(`inspect names native resume: ${reason}`, async () => {
    const events = hostChecksPassRun(root)
    const started = events.find(event => event.type === 'test.started')
    assert.ok(started?.type === 'test.started')
    const { schemaVersion, runId, sequence, time, elapsedMs, origin, testId, attemptId, variant, variantKey } = started
    assert.ok(variant)
    assert.ok(variantKey)
    const resumed: RetestEvent = { schemaVersion, runId, sequence, time, elapsedMs, origin, testId, attemptId, variant, variantKey, type: 'capture.resumed', sessionId: `${started.attemptId}:desk`, session: 'desk', secret: 'password', endedBy: reason === 'the field reads back masked' ? 'field_masked' : 'field_gone', reason, fromUs: 10, untilUs: 20 }
    const shown = await inspect([folder(`resume-${resumed.endedBy}`, renumbered(edited(events, event => event.type === 'test.finished' ? [resumed, event] : [event]))), '--test', started.testId])
    assert.equal(shown.code, 0, shown.stderr)
    assert.ok(shown.stdout.includes(`capture resumed for {{password}}: ${reason}`), shown.stdout)
  })
}
