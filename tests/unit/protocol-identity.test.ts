import type { CaptureSource } from '../../src/native/session.ts'
import type { DiagnosticIdentity } from '../../src/protocol/diagnostics.ts'
import type { EvidenceRecord } from '../../src/protocol/evaluation.ts'
import type { RetestEvent } from '../../src/protocol/events.ts'
import type { EvidenceReference } from '../../src/protocol/evidence.ts'
import type { CaptureSourceName, RecordIdentity } from '../../src/protocol/identity.ts'
import type { RecordIdentity as PublicRecordIdentity, SessionRecordIdentity } from '../../src/protocol/index.ts'
import type { Evidence } from '../../src/protocol/result.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { diagnosticRecordSchema } from '../../src/protocol/diagnostics.ts'
import { evaluationRecordSchema } from '../../src/protocol/evaluation.ts'
import { retestEventSchema } from '../../src/protocol/events.ts'
import { formatSessionId } from '../../src/protocol/evidence.ts'
import { truncateText } from '../../src/protocol/failures.ts'
import { captureSourceNameSchema } from '../../src/protocol/identity.ts'
import { runResultSchema } from '../../src/protocol/result.ts'
import { parse, toJsonSchema } from '../../src/protocol/schema.ts'

// True only when two types are the same, optional keys included.
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

// Compile-time facts: every record that names its session uses the one identity, under the same names.
const evidenceCarriesIdentity: Same<Pick<EvidenceReference, keyof RecordIdentity>, RecordIdentity> = true
const diagnosticsCarryIdentity: Same<DiagnosticIdentity, Omit<RecordIdentity, 'observationId'> & { target?: string }> = true
const resultScreenshotsNameTheSource: Same<Evidence['source'], CaptureSourceName | undefined> = true
const judgedScreenshotsNameTheSource: Same<EvidenceRecord['source'], CaptureSourceName | undefined> = true
// A native session names its capture sources the way records do.
const nativeSourcesAreNamed: Same<CaptureSource extends CaptureSourceName ? true : false, true> = true
// Each type is assignable to the other, and they have the same keys: the same shape, written two ways.
type Alike<A, B> = [A] extends [B] ? ([B] extends [A] ? Same<keyof A, keyof B> : false) : false
// The protocol subpath's `RecordIdentity` keeps the shape it was published with, a diagnostics record's identity, and the
// shared identity is published as `SessionRecordIdentity`.
const publishedNameKeepsItsShape: Alike<PublicRecordIdentity, { testId: string; attemptId: string; app: string; sessionId: string; target?: string }> = true
const sharedIdentityIsPublished: Same<SessionRecordIdentity, RecordIdentity> = true

const stamp = { schemaVersion: 1, runId: 'run-1', sequence: 0, time: '2026-10-04T09:15:00.000Z', elapsedMs: 120, origin: 'parent' } as const
const identity: RecordIdentity = { testId: 'tests/tasks.retest.ts > saves', attemptId: 'k3v9q0x2mb', app: 'web', sessionId: formatSessionId('k3v9q0x2mb', 'web') }
const scope = { testId: identity.testId, attemptId: identity.attemptId }
const session = { session: identity.app, sessionId: identity.sessionId }

type IdentityKey = 'testId' | 'attemptId' | 'app' | 'sessionId' | 'observationId'

// Which identity keys each event type can carry, as its writer knows them. `app` is a key named `app`; every event also
// has `session`, the app it concerns, which is the same key under the name events have always used.
const eventIdentity: Readonly<Record<string, readonly IdentityKey[]>> = {
  'run.started': [],
  'browser.started': ['app'],
  'native.started': ['testId', 'attemptId', 'app', 'sessionId'],
  'native.ended': ['testId', 'attemptId', 'sessionId'],
  'app.started': ['app'],
  'app.reused': ['app'],
  'app.failed': ['app'],
  'collection.completed': [],
  'collection.failed': [],
  'file.failed': [],
  'lock.acquired': ['testId', 'attemptId'],
  'resource.acquired': ['testId', 'attemptId'],
  'lease.taken': ['testId', 'attemptId'],
  'run.narrowed': [],
  'session.reserved': ['testId', 'attemptId'],
  'lease.expired': ['testId', 'attemptId'],
  'session.released': ['testId', 'attemptId'],
  'test.started': ['testId', 'attemptId'],
  'preparation.finished': ['testId', 'attemptId'],
  'cleanup.finished': ['testId', 'attemptId'],
  'state.saved': ['testId', 'attemptId', 'app', 'sessionId'],
  'state.restored': ['testId', 'attemptId', 'app', 'sessionId'],
  'step.started': ['testId', 'attemptId'],
  'step.finished': ['testId', 'attemptId'],
  'action.completed': ['testId', 'attemptId', 'sessionId'],
  'action.failed': ['testId', 'attemptId', 'sessionId'],
  navigation: ['testId', 'attemptId', 'sessionId'],
  observation: ['testId', 'attemptId', 'sessionId', 'observationId'],
  'host_check.passed': ['testId', 'attemptId', 'sessionId'],
  'host_check.failed': ['testId', 'attemptId', 'sessionId'],
  'assertion.passed': ['testId', 'attemptId', 'sessionId', 'observationId'],
  'assertion.failed': ['testId', 'attemptId', 'sessionId', 'observationId'],
  'evidence.captured': ['testId', 'attemptId', 'sessionId', 'observationId'],
  'evidence.failed': ['testId', 'attemptId', 'sessionId'],
  'diagnostics.started': ['testId', 'attemptId', 'sessionId'],
  'diagnostics.finished': ['testId', 'attemptId', 'sessionId'],
  'evaluation.finished': ['testId', 'attemptId'],
  'test.finished': ['testId', 'attemptId'],
  'run.finished': [],
  'run.outcome': [],
}

const identityKeys: readonly IdentityKey[] = ['testId', 'attemptId', 'app', 'sessionId', 'observationId']

function roundTrips(value: unknown): void {
  assert.deepEqual(parse(retestEventSchema, JSON.parse(JSON.stringify(value))), { ok: true, value })
}

function refusedPaths(schema: Parameters<typeof parse>[0], value: unknown): string[] {
  const parsed = parse(schema, value)
  assert.equal(parsed.ok, false, `expected ${JSON.stringify(value)} to be refused`)
  return parsed.ok ? [] : parsed.issues.map((issue) => issue.path)
}

describe('the record identity', () => {
  test('is one shape, used by screenshots, diagnostics and judged evidence, checked when this file compiles', () => {
    assert.deepEqual(
      [evidenceCarriesIdentity, diagnosticsCarryIdentity, resultScreenshotsNameTheSource, judgedScreenshotsNameTheSource, nativeSourcesAreNamed, publishedNameKeepsItsShape, sharedIdentityIsPublished],
      [true, true, true, true, true, true, true],
    )
  })

  test('a capture source is Chromium or one of the native session sources, by name', () => {
    for (const name of ['chromium', 'executor-screen', 'simulator-display', 'window-crop']) assert.equal(parse(captureSourceNameSchema, name).ok, true, name)
    for (const name of ['firefox', 'webkit', 'screen', '']) assert.equal(parse(captureSourceNameSchema, name).ok, false, name)
  })

  test('every event type carries the identity keys its writer knows, and no others', () => {
    const schema = toJsonSchema(retestEventSchema)
    const types = (schema.oneOf ?? []).map((option) => String(option.properties?.['type']?.const))
    assert.deepEqual(new Set(types), new Set(Object.keys(eventIdentity)), 'the table names every event type')
    for (const option of schema.oneOf ?? []) {
      const type = String(option.properties?.['type']?.const)
      const keys = identityKeys.filter((key) => option.properties?.[key] !== undefined)
      assert.deepEqual(keys, eventIdentity[type], type)
      assert.ok(option.properties?.['session'] !== undefined, `${type} can name its app in session`)
    }
  })

  test('the new identity fields are additive: an event without them is still a version 1 event', () => {
    const action = { ...stamp, type: 'action.completed', ...scope, session: 'web', command: 'click', durationMs: 12 } as const
    roundTrips(action)
    roundTrips({ ...action, sessionId: identity.sessionId })
    const screenshot = { ...stamp, type: 'evidence.captured', ...scope, session: 'web', kind: 'screenshot', path: 'artifacts/a.png', reason: 'failure' } as const
    roundTrips(screenshot)
  })
})

describe('schema samples of the identity on each record', () => {
  const samples: RetestEvent[] = [
    { ...stamp, type: 'action.completed', ...scope, ...session, command: 'click', locator: { by: 'testId', value: 'save-task' }, durationMs: 12 },
    { ...stamp, type: 'action.failed', ...scope, ...session, command: 'fill', durationMs: 5, failure: { class: 'not_actionable', message: 'It is disabled.' } },
    { ...stamp, type: 'navigation', ...scope, ...session, url: 'http://127.0.0.1:4173/tasks', title: 'Tasks', cause: 'goto', document: 'new' },
    { ...stamp, type: 'host_check.passed', ...scope, ...session, check: { kind: 'text', text: 'Saved' }, actual: { url: 'http://127.0.0.1:4173/tasks', found: true }, attempts: 1, timeoutMs: 1000, durationMs: 3 },
    { ...stamp, type: 'state.saved', ...scope, state: 'signed-in', app: 'web', target: 'default', sessionId: identity.sessionId },
    { ...stamp, type: 'state.restored', ...scope, state: 'signed-in', app: 'web', target: 'default', sessionId: identity.sessionId },
    {
      ...stamp,
      origin: 'child',
      type: 'assertion.passed',
      ...scope,
      ...session,
      matcher: 'toHaveText',
      locator: { by: 'testId', value: 'saved-task' },
      expected: truncateText('Saved'),
      actual: truncateText('Saved'),
      attempts: 1,
      durationMs: 4,
      observationId: 'o2',
      judgedBy: 'parent',
    },
    {
      ...stamp,
      type: 'evidence.captured',
      ...scope,
      ...session,
      kind: 'screenshot',
      path: 'artifacts/saves-web-failure.png',
      reason: 'failure',
      capturedAt: '2026-10-04T09:15:01.000Z',
      capturedElapsedMs: 1118,
      source: 'chromium',
    },
    { ...stamp, type: 'evidence.captured', ...scope, ...session, kind: 'screenshot', path: 'artifacts/phone.png', reason: 'failure', source: 'simulator-display', observationId: 'o7' },
    { ...stamp, type: 'evidence.captured', ...scope, session: 'phone', sessionId: formatSessionId(identity.attemptId, 'phone'), kind: 'screenshot', path: 'artifacts/phone-failure.png', reason: 'failure', capturedElapsedMs: 1400, source: 'executor-screen' },
    {
      ...stamp,
      type: 'native.started',
      ...scope,
      session: 'phone',
      app: 'phone',
      sessionId: formatSessionId(identity.attemptId, 'phone'),
      target: 'ios-simulator',
      product: 'TaskPhone',
      identity: {
        platform: 'ios-simulator',
        app: { bundleId: 'dev.retest.fixtures.taskphone', version: '1.0', build: '1', path: '/work/build/TaskPhone.app', sha256: 'a'.repeat(64) },
        os: { name: 'iOS', version: '26.5', build: '23F77' },
        device: { name: 'Retest iPhone 17', type: 'iPhone 17', udid: '6F1C2D3E-0000-4000-8000-000000000001' },
        executor: { name: 'WebDriverAgent', version: '16.13.6', commit: 'c'.repeat(40), commitVerified: false, productsSha256: 'd'.repeat(64), origin: 'adopted' },
        xcode: { version: '26.5', build: '17F42' },
      },
    },
    {
      ...stamp,
      type: 'native.ended',
      ...scope,
      session: 'phone',
      sessionId: formatSessionId(identity.attemptId, 'phone'),
      unknownOutcomes: [{ source: 'input', id: 'input-1', kind: 'tap', generation: 1, route: 'POST /session/:session/element/:element/click', input: 'unknown', reconciled: { running: true, pids: [4242] } }],
    },
    { ...stamp, type: 'evidence.failed', ...scope, ...session, kind: 'screenshot', reason: 'failure', message: 'The browser was gone, so Retest took no screenshot.', source: 'chromium' },
  ]

  test('each sample is a version 1 event and survives a JSON round trip', () => {
    for (const sample of samples) roundTrips(sample)
  })

  test('a capture source that is not one, or a time before the run, is refused', () => {
    const captured = samples.find((sample) => sample.type === 'evidence.captured')
    assert.ok(captured)
    assert.deepEqual(refusedPaths(retestEventSchema, { ...captured, source: 'webkit' }), ['$.source'])
    assert.deepEqual(refusedPaths(retestEventSchema, { ...captured, capturedElapsedMs: -1 }), ['$.capturedElapsedMs'])
    assert.deepEqual(refusedPaths(retestEventSchema, { ...captured, capturedElapsedMs: 1.5 }), ['$.capturedElapsedMs'])
  })

  test('a diagnostics record names no look, so a look id on one is refused', () => {
    const record = { ...identity, type: 'console', id: 'c1', consoleType: 'log', level: 'info', origin: 'page', text: truncateText('ready'), time: '2026-10-04T09:15:00.500Z' }
    assert.equal(parse(diagnosticRecordSchema, record).ok, true)
    assert.deepEqual(refusedPaths(diagnosticRecordSchema, { ...record, observationId: 'o1' }), ['$.observationId'])
  })

  test('a judged screenshot carries the identity, when it came back on the run’s clock and what took it', () => {
    const record = {
      checkId: 'saved',
      source: 'test',
      mode: 'required',
      verdict: 'pass',
      criteria: [{ id: 'shown', requirement: 'The task shows as saved.', verdict: 'pass' }],
      criteriaSha256: 'a'.repeat(64),
      evidence: [
        { id: 'e1', kind: 'screenshot', ...identity, capturedAt: '2026-10-04T09:15:01.000Z', capturedElapsedMs: 1200, source: 'chromium', path: 'artifacts/e1.png', sha256: 'b'.repeat(64), bytes: 2048, width: 800, height: 600 },
        { id: 'e2', kind: 'text', testId: identity.testId, attemptId: identity.attemptId, capturedAt: '2026-10-04T09:15:01.100Z', capturedElapsedMs: 1300, sha256: 'c'.repeat(64), bytes: 5 },
      ],
      durationMs: 40,
    }
    assert.equal(parse(evaluationRecordSchema, record).ok, true)
    const [screenshot] = record.evidence
    assert.ok(screenshot)
    assert.deepEqual(
      refusedPaths(evaluationRecordSchema, { ...record, evidence: [{ ...screenshot, source: 'camera' }] }),
      ['$.evidence[0].source'],
    )
  })

  test('a result’s screenshot carries what its event carries', () => {
    const evidence = { kind: 'screenshot', path: 'artifacts/a.png', app: 'web', sessionId: identity.sessionId, attemptId: identity.attemptId, capturedAt: '2026-10-04T09:15:01.000Z', capturedElapsedMs: 1118, source: 'chromium', observationId: 'o3' }
    const result = {
      schemaVersion: 1,
      runId: 'run-1',
      retestVersion: '0.0.0',
      startedAt: '2026-10-04T09:15:00.000Z',
      finishedAt: '2026-10-04T09:15:02.000Z',
      complete: true,
      status: 'failed',
      exitCode: 1,
      durationMs: 2000,
      browser: null,
      counts: { passed: 0, failed: 1, error: 0, notRun: 0, inconclusive: 0 },
      files: [
        {
          file: 'tests/tasks.retest.ts',
          collection: 'ok',
          tests: [
            {
              testId: identity.testId,
              name: 'saves',
              file: 'tests/tasks.retest.ts',
              location: { file: 'tests/tasks.retest.ts', line: 3, column: 1 },
              attemptId: identity.attemptId,
              status: 'failed',
              durationMs: 1500,
              assertionCount: 1,
              failure: { class: 'check_failed', message: 'It did not show.' },
              evidence: [evidence],
            },
          ],
        },
      ],
    }
    assert.equal(parse(runResultSchema, result).ok, true)
    const schema = toJsonSchema(runResultSchema)
    assert.ok(JSON.stringify(schema).includes('"capturedElapsedMs"'), 'the published result schema names the run-clock time')
  })
})
