import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { SessionIdentity } from '../../src/browser/contract.ts'
import type { DiagnosticCollection, DiagnosticSink } from '../../src/diagnostics/observations.ts'
import type { DiagnosticIdentity } from '../../src/protocol/diagnostics.ts'
import type { EventBody } from '../../src/protocol/events.ts'
import { AttemptDiagnostics } from '../../src/diagnostics/attempt.ts'
import { chromiumScope } from '../../src/diagnostics/chromium-collector.ts'
import { defaultDiagnosticsPolicy } from '../../src/diagnostics/policy.ts'
import { AttemptBudget, SessionCapture } from '../../src/diagnostics/session-capture.ts'
import { defaultDiagnosticLimits } from '../../src/protocol/diagnostics.ts'
import { Redactor } from '../../src/runner/redactor.ts'

const identity: DiagnosticIdentity = { testId: 'view.retest.ts > reads', attemptId: 'closeout123', app: 'web', sessionId: 'closeout123:web' }
const at = Date.UTC(2026, 9, 6)

function session(app = 'web'): SessionIdentity {
  return { sessionId: `${identity.attemptId}:${app}`, owner: { runId: 'run', testId: identity.testId, attemptId: identity.attemptId, app }, runtime: { kind: 'web', engine: 'chromium', product: 'Chrome', version: '154', executablePath: '/chrome', processIds: [] } }
}

function attempt(capture = true, consoleEntries = defaultDiagnosticLimits.consoleEntries): { diagnostics: AttemptDiagnostics; events: EventBody[]; written: string[]; redactor: Redactor } {
  const events: EventBody[] = []
  const written: string[] = []
  const redactor = new Redactor()
  const diagnostics = new AttemptDiagnostics({ policy: { ...defaultDiagnosticsPolicy, capture, limits: { ...defaultDiagnosticLimits, consoleEntries } }, redactor, writeArtifact: (path) => void written.push(path), emit: (event) => void events.push(event), testId: identity.testId, attemptId: identity.attemptId, named: true, variant: undefined, clock: () => at + 100 })
  return { diagnostics, events, written, redactor }
}

function page(unavailable?: DiagnosticCollection['unavailable']): { page: { collectDiagnostics(sink: DiagnosticSink): Promise<DiagnosticCollection> }; sink(): DiagnosticSink; stops(): number } {
  let held: DiagnosticSink | undefined
  let stopped = 0
  return {
    page: { async collectDiagnostics(sink) { held = sink; return { scope: chromiumScope, stop: () => void stopped++, ...(unavailable === undefined ? {} : { unavailable }) } } },
    sink() { assert.ok(held !== undefined); return held },
    stops: () => stopped,
  }
}

function log(sink: DiagnosticSink, text: string): void {
  sink.observe({ kind: 'console', consoleType: 'log', level: 'info', origin: 'page', text, time: at })
}

test('session snapshots are detached, read-only and leave the request lifecycle and budget untouched', () => {
  const budget = new AttemptBudget({ ...defaultDiagnosticLimits })
  const capture = new SessionCapture({ identity, budget, redactor: new Redactor(), startedAt: at })
  log(capture, 'first')
  capture.observe({ kind: 'runtime_error', key: 'error', errorKind: 'uncaught', message: 'boom', time: at, stack: [{ function: 'test', line: 1, column: 2 }] })
  capture.observe({ kind: 'request', key: 'request', method: 'GET', url: 'http://app.test/next', time: at })
  const before = structuredClone(budget)
  const view = capture.snapshot()
  assert.deepEqual(structuredClone(budget), before)
  assert.equal(view.network.state, 'complete')
  assert.equal(view.network.state === 'complete' ? view.network.pending : -1, 0)
  assert.equal(view.records.some((record) => record.type === 'network.pending'), false)
  assert.ok(Object.isFrozen(view) && Object.isFrozen(view.records) && Object.isFrozen(view.console))
  const first = view.records[0]
  assert.ok(first?.type === 'console')
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.text))
  assert.equal(Reflect.set(first.text, 'text', 'changed'), false)
  const error = view.records[1]
  assert.ok(error?.type === 'runtime_error')
  assert.ok(Object.isFrozen(error.stack) && Object.isFrozen(error.stack[0]))
  assert.ok(view.records.every((record) => record.testId === identity.testId && record.attemptId === identity.attemptId && record.app === identity.app && record.sessionId === identity.sessionId))
  log(capture, 'later')
  capture.observe({ kind: 'response', key: 'request', status: 200, time: at + 1 })
  capture.observe({ kind: 'finished', key: 'request', time: at + 2, durationMs: 2 })
  assert.equal(view.records.length, 3, 'later collection cannot mutate an older view')
  const finished = capture.finish('attempt_ended', at + 3)
  assert.equal(finished.records.length, 6)
  assert.equal(finished.network.state === 'complete' ? finished.network.pending : -1, 0)
  assert.deepEqual(capture.snapshot().records, finished.records)
})

test('session snapshots retain bounds, losses and text redaction learned after collection', () => {
  const redactor = new Redactor()
  const secret = randomUUID()
  const capture = new SessionCapture({ identity, budget: new AttemptBudget({ ...defaultDiagnosticLimits, consoleEntries: 1 }), redactor, startedAt: at })
  log(capture, `token ${secret}`)
  log(capture, 'dropped')
  redactor.learn('token', secret)
  capture.lost({ kind: 'connection_lost', reason: 'offline', time: at + 1 })
  const view = capture.snapshot()
  assert.equal(view.records.length, 1)
  assert.equal(JSON.stringify(view).includes(secret), false)
  assert.equal(view.console.state, 'partial')
  assert.equal(view.console.state === 'partial' ? view.console.dropped : -1, 1)
  assert.match(view.console.state === 'partial' ? view.console.reason : '', /connection to the page ended.*1 console message/)
  assert.equal(view.network.state, 'partial')
})

test('an attempt exposes bounded current identity-preserving records while collection continues', async () => {
  const { diagnostics, events, written, redactor } = attempt()
  const collector = page()
  await diagnostics.start([{ app: 'web', page: collector.page, session: session() }], 10)
  const secret = randomUUID()
  log(collector.sink(), `before ${secret}`)
  redactor.learn('password', secret)
  const first = diagnostics.snapshot('web')
  assert.ok(first !== undefined)
  assert.deepEqual([first.testId, first.attemptId, first.app, first.sessionId], [identity.testId, identity.attemptId, identity.app, identity.sessionId])
  assert.equal(JSON.stringify(first).includes(secret), false)
  assert.equal(first.console.state, 'complete')
  assert.equal(collector.stops(), 0)
  assert.equal(written.length, 0)
  assert.deepEqual(events.map((event) => event.type), ['diagnostics.started'])
  log(collector.sink(), 'after')
  assert.equal(first.records.length, 1)
  assert.equal(diagnostics.snapshot('web')?.records.length, 2)
  diagnostics.finish('attempt_ended')
  assert.equal(collector.stops(), 1)
  assert.equal(written.length, 1)
})

test('attempt views preserve disabled, absent and unavailable sources instead of inventing complete capture', async () => {
  const disabled = attempt(false)
  await disabled.diagnostics.start([{ app: 'web', page: {}, session: session() }], 10)
  assert.equal(disabled.diagnostics.snapshot('web')?.console.state, 'disabled')
  assert.equal(disabled.diagnostics.snapshot('missing'), undefined)
  const absent = attempt()
  await absent.diagnostics.start([{ app: 'web', page: {}, session: session() }], 10)
  assert.deepEqual(absent.diagnostics.snapshot('web')?.console, { state: 'unavailable', reason: "the page's driver does not collect diagnostics" })
  const source = attempt()
  const collector = page({ console: 'this source provides no console' })
  await source.diagnostics.start([{ app: 'web', page: collector.page, session: session() }], 10)
  assert.deepEqual(source.diagnostics.snapshot('web')?.console, { state: 'unavailable', reason: 'this source provides no console' })
  assert.equal(source.diagnostics.snapshot('web')?.network.state, 'complete')
  source.diagnostics.finish('attempt_ended')
  absent.diagnostics.finish('attempt_ended')
  disabled.diagnostics.finish('attempt_ended')
})

test('evaluation snapshots draw from the same attempt-wide bounds across apps', async () => {
  const { diagnostics } = attempt(true, 1)
  const web = page()
  const admin = page()
  await diagnostics.start([{ app: 'web', page: web.page, session: session() }, { app: 'admin', page: admin.page, session: session('admin') }], 10)
  log(web.sink(), 'kept')
  log(admin.sink(), 'over the shared bound')
  assert.equal(diagnostics.snapshot('web')?.records.length, 1)
  const other = diagnostics.snapshot('admin')
  assert.equal(other?.records.length, 0)
  assert.equal(other?.console.state, 'partial')
  assert.equal(other?.app, 'admin')
  assert.equal(other?.sessionId, `${identity.attemptId}:admin`)
  assert.equal(web.stops() + admin.stops(), 0)
  diagnostics.finish('attempt_ended')
})

test('active native sources without a non-stopping read stay explicitly unavailable to evaluation', async () => {
  const { diagnostics } = attempt()
  await diagnostics.startNative('web', session())
  const view = diagnostics.snapshot('web')
  assert.equal(view?.console.state, 'unavailable')
  assert.match(view?.console.state === 'unavailable' ? view.console.reason : '', /live native diagnostics do not provide an evaluation snapshot/)
  assert.deepEqual(view?.records, [])
  await diagnostics.finishNative('attempt_ended')
})
