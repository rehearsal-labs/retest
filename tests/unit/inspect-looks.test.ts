import type { EventBody } from '../../src/protocol/events.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import type { ObservedRecord } from '../../src/protocol/observation-record.ts'
import type { TestResult } from '../../src/protocol/result.ts'
import type { TestEvent } from '../../src/reporters/run-record.ts'
import { recordEvents } from '../../src/reporters/run-record.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { describeObserved, timelineEntries } from '../../src/cli/inspect/looks.ts'
import { renderTimeline } from '../../src/cli/inspect/test-timeline.ts'
import { truncateText } from '../../src/protocol/failures.ts'
import { createStyle } from '../../src/reporters/style.ts'
import { stamp } from './reporters-fixtures.ts'
import { observed } from './reporters-host-check-fixtures.ts'

const scope = { testId: 'a.retest.ts > saves', attemptId: 'attempt-1' }
const saved: LocatorRecipe = { by: 'testId', value: 'saved' }
const count: LocatorRecipe = { by: 'testId', value: 'count' }

function look(id: string, session: string, locator: LocatorRecipe = saved): EventBody {
  return { type: 'observation', ...scope, session, observationId: id, locator, observed: observed('Saved'), durationMs: 2 }
}

function passed(session: string, observationId?: string, locator: LocatorRecipe = saved): EventBody {
  const named = observationId === undefined ? {} : { observationId }
  return { type: 'assertion.passed', ...scope, session, matcher: 'toBeVisible', locator, expected: null, actual: null, attempts: 2, durationMs: 40, ...named, judgedBy: 'parent' }
}

function events(bodies: EventBody[]): TestEvent[] {
  return stamp(bodies).filter((event): event is TestEvent => 'testId' in event && event.testId !== undefined && 'attemptId' in event && event.attemptId !== undefined)
}

function ids(entry: ReturnType<typeof timelineEntries>[number]): string[] {
  return entry.looks.map((one) => one.observationId)
}

describe('which looks each assertion took', () => {
  test('an assertion takes the looks of its own app and locator, so two apps looking at once keep theirs apart', () => {
    const entries = timelineEntries(events([look('o1', 'web'), look('o2', 'admin'), look('o3', 'web'), passed('web', 'o3'), look('o4', 'admin'), passed('admin', 'o4')]))
    assert.deepEqual(
      entries.map((entry) => [entry.kind === 'event' ? entry.event.session : 'looks', ids(entry)]),
      [
        ['web', ['o1', 'o3']],
        ['admin', ['o2', 'o4']],
      ],
    )
  })

  test('an action ends the looks before it, which then stand on their own, a run of them on one line', () => {
    const action: EventBody = { type: 'action.completed', ...scope, session: 'web', command: 'click', locator: saved, durationMs: 5 }
    const entries = timelineEntries(events([look('o1', 'web'), look('o2', 'web'), action, look('o3', 'web', count), passed('web', 'o3', count)]))
    assert.deepEqual(
      entries.map((entry) => [entry.kind, ids(entry)]),
      [
        ['looks', ['o1', 'o2']],
        ['event', []],
        ['event', ['o3']],
      ],
    )
  })

  test('looks at another locator are not taken, and a value assertion takes none', () => {
    const value: EventBody = { type: 'assertion.passed', ...scope, matcher: 'toBe', expected: truncateText('2'), actual: truncateText('2'), attempts: 1, durationMs: 0, judgedBy: 'child' }
    const entries = timelineEntries(events([look('o1', 'web', count), look('o2', 'web'), value, passed('web', 'o2')]))
    assert.deepEqual(
      entries.map((entry) => [entry.kind, ids(entry)]),
      [
        ['looks', ['o1']],
        ['event', []],
        ['event', ['o2']],
      ],
    )
  })
})

describe('an assertion and its looks in a timeline', () => {
  const style = createStyle(false)
  const saves: TestResult = {
    ...scope,
    name: 'saves',
    file: 'a.retest.ts',
    location: { file: 'a.retest.ts', line: 1, column: 1 },
    status: 'passed',
    durationMs: 50,
    assertionCount: 1,
    evidence: [],
  }
  const render = (bodies: EventBody[]): string[] =>
    renderTimeline(saves, events(bodies), { style, runFolder: 'run', targets: { browsers: new Map(), apps: new Map() } })
      .split('\n')
      .slice(3, -1)
      .map((line) => line.slice(13))

  test('an assertion that names no look shows its last', () => {
    assert.deepEqual(render([look('o1', 'page'), look('o2', 'page'), passed('page')]), ["✓ toBeVisible getByTestId('saved')  40 ms", '  looked 2 times, last o2: 1 match, text "Saved"'])
  })

  test('an assertion that names a look it did not take names it by its id alone', () => {
    assert.deepEqual(render([look('o1', 'page'), passed('page', 'o9')]), ["✓ toBeVisible getByTestId('saved')  40 ms", '  looked 1 time, passed on o9'])
  })

  test('without looks, the assertion counts its own attempts', () => {
    assert.deepEqual(render([passed('page', 'o1')]), ["✓ toBeVisible getByTestId('saved')  40 ms, 2 looks"])
  })
})

describe('what a look saw', () => {
  const none: ObservedRecord = { count: 0, visible: null, text: null, value: null, items: [], itemsTruncated: false }

  test('no match, one match with what it shows, or the first matches by their text', () => {
    assert.equal(describeObserved(none), 'no match')
    assert.equal(describeObserved(observed('Saved')), '1 match, text "Saved"')
    assert.equal(
      describeObserved({ ...none, count: 1, visible: false, text: truncateText(''), value: truncateText('Ada') }),
      '1 match, hidden, text "", value "Ada"',
    )
    const items = ['Buy milk', 'Walk the dog', 'Pay rent', 'Call Ada'].map((text, index) => ({ text: truncateText(text), visible: index !== 1 }))
    assert.equal(describeObserved({ ...none, count: 5, items }), '5 matches: "Buy milk", "Walk the dog" (hidden), "Pay rent" and 2 more')
    assert.equal(describeObserved({ ...none, count: 2, items: items.slice(0, 2) }), '2 matches: "Buy milk", "Walk the dog" (hidden)')
    assert.equal(describeObserved({ ...none, count: 2 }), '2 matches')
  })

  test('page text is quoted and cut, with its control characters escaped', () => {
    assert.equal(describeObserved(observed('a\nb\u001b[2J\u0085')), '1 match, text "a\\nb\\u001b[2J\\u0085"')
    assert.match(describeObserved(observed('x'.repeat(5000))), /^1 match, text "x{300}"… \(300 of 5000 characters\)$/)
  })
})


test('the timeline names recording loss, media refusal, pixel withholding and failed retention', () => {
  const bodies: EventBody[] = [
    { type: 'recording.started', ...scope, sessionId: 'session-1', recordingId: 'rec-1', number: 1, source: 'chromium', mode: 'screencast', path: 'recordings/one.mp4', fps: 10, width: 10, height: 10, codec: 'h264', container: 'mp4', route: 'decoded', keepFrames: false, startedUs: 0 },
    { type: 'recording.finished', ...scope, sessionId: 'session-1', recording: { ...scope, recordingId: 'rec-1', sequence: 1, app: 'web', sessionId: 'session-1', status: 'unavailable', gaps: [{ code: 'media_unavailable', message: 'damaged media cache' }], partialPath: 'recordings/one.partial' } },
    { type: 'media.started', media: { pid: 4242, start: 1, version: '0.1.0', protocol: 2, build: { target: 'test', profile: 'release' }, ffmpeg: '/ffmpeg', encoder: { state: 'ready' }, owner: { pid: 4243 } } },
    { type: 'media.lost', pid: 4242, start: 1, exit: { code: null, signal: 'SIGKILL' }, recordings: 1, restart: true },
    { type: 'media.closed', pid: 4242, start: 1, forced: true, problems: ['encoder exit unconfirmed'] },
    { type: 'media.leftovers', previousRunId: 'previous', folder: 'old-run', reference: 'recordings/old.mp4', status: 'invalid', removed: [], skipped: 1 },
    { type: 'media.failed', start: 1, code: 'media_unavailable', message: 'damaged media cache' },
    { type: 'capture.withheld', ...scope, sessionId: 'session-1', secret: 'password', cause: 'unknown', fromUs: 10 },
    { type: 'capture.resumed', ...scope, sessionId: 'session-1', secret: 'password', endedBy: 'field_gone', fromUs: 10, untilUs: 20 },
    { type: 'capture.masked_entry', ...scope, sessionId: 'session-1', secret: 'password', atUs: 30 },
    { type: 'artifact.removal_requested', ...scope, kind: 'recording', path: 'recordings/one.mp4', reason: 'passed_attempt_recording', moment: 'attempt_finished', bytes: 2 },
    { type: 'artifact.removed', ...scope, kind: 'recording', path: 'recordings/one.mp4', reason: 'passed_attempt_recording', moment: 'attempt_finished', bytes: 2 },
    { type: 'artifact.removal_failed', ...scope, kind: 'recording', path: 'recordings/one.mp4', reason: 'passed_attempt_recording', moment: 'attempt_finished', message: 'unlink refused' },
  ]
  const entries = stamp(bodies).filter((event): event is import('../../src/cli/inspect/looks.ts').TimelineEvent => bodies.some(body => body.type === event.type))
  const shown = renderTimeline({ ...scope, name: 'saves', file: 'a.retest.ts', location: { file: 'a.retest.ts', line: 1, column: 1 }, status: 'passed', durationMs: 1, assertionCount: 1, evidence: [] }, entries, { style: createStyle(false), runFolder: 'run', targets: { browsers: new Map(), apps: new Map() } })
  for (const words of ['recording 1 started', 'media started', 'media lost', 'SIGKILL', 'media closed', 'encoder exit unconfirmed', 'media leftovers', 'invalid', 'recording 1 unavailable', 'partial file', 'media setup failed', 'damaged media cache', 'capture withheld', 'capture resumed', 'masked entry', 'retention removal requested', 'retention removal failed', 'unlink refused']) assert.ok(shown.includes(words), words)
  assert.ok(shown.includes('retention removed: recording recordings/one.mp4'))
  assert.ok(shown.indexOf('retention removal requested') < shown.indexOf('retention removed:'))
  assert.ok(shown.indexOf('retention removed:') < shown.indexOf('retention removal failed'))
})


test('test-scoped retention reaches the timeline while run-scoped retention stays in the run record', () => {
  const started: EventBody = { type: 'test.started', ...scope, name: 'saves', file: 'a.retest.ts', location: { file: 'a.retest.ts', line: 1, column: 1 } }
  const removed: EventBody = { type: 'artifact.removed', path: 'artifacts/one.mp4', kind: 'recording', reason: 'passed_attempt_recording', moment: 'attempt_finished', bytes: 12 }
  const bodies: EventBody[] = [started, { ...removed, ...scope }, removed, { ...removed, type: 'artifact.removal_failed', ...scope, message: 'unlink refused' }]
  const record = recordEvents(stamp(bodies))
  assert.equal(record.removals.length, 3)
  assert.deepEqual(record.test(scope.testId)?.events.map(event => event.type), ['test.started', 'artifact.removed', 'artifact.removal_failed'])
  assert.deepEqual(events(bodies).map(event => event.type), ['test.started', 'artifact.removed', 'artifact.removal_failed'])
})
