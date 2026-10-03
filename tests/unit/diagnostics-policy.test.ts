import type { OwnedPage, SessionIdentity } from '../../src/browser/contract.ts'
import type { DiagnosticCollection, DiagnosticSink } from '../../src/diagnostics/observations.ts'
import type { DiagnosticRecord, DiagnosticsSummary } from '../../src/protocol/diagnostics.ts'
import type { EventBody } from '../../src/protocol/events.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseArtifact, redactArtifactText } from '../../src/diagnostics/artifact.ts'
import { AttemptDiagnostics } from '../../src/diagnostics/attempt.ts'
import { chromiumScope } from '../../src/diagnostics/chromium-collector.ts'
import { defaultDiagnosticsPolicy, policyFailure, resolveDiagnostics, strictMatches, withDiagnosticsFailure, type DiagnosticsPolicy } from '../../src/diagnostics/policy.ts'
import { diagnosticsCardLines, diagnosticsTotals, describeConsole, describeNetwork } from '../../src/diagnostics/report.ts'
import { validateConfig } from '../../src/config/validate.ts'
import { defaultDiagnosticLimits } from '../../src/protocol/diagnostics.ts'
import { Redactor } from '../../src/runner/redactor.ts'

const identity = { testId: 'a.retest.ts > saves', attemptId: 'k3v9q0x2mb', app: 'web', sessionId: 'k3v9q0x2mb:web' }
const time = '2026-10-03T00:00:00.000Z'

const records: DiagnosticRecord[] = [
  { type: 'runtime_error', ...identity, id: 'e1', kind: 'uncaught', message: { text: 'Uncaught Error: boom', truncated: false, length: 20 }, time, stack: [] },
  { type: 'runtime_error', ...identity, id: 'e2', kind: 'unhandled_rejection', message: { text: 'Uncaught (in promise) Error: later', truncated: false, length: 34 }, time, stack: [], handledLater: true },
  { type: 'console', ...identity, id: 'c1', consoleType: 'error', level: 'error', origin: 'page', text: { text: 'save failed', truncated: false, length: 11 }, time },
  { type: 'console', ...identity, id: 'c2', consoleType: 'error', level: 'error', origin: 'browser', source: 'network', text: { text: 'Failed to load resource', truncated: false, length: 23 }, time },
  { type: 'network.request', ...identity, requestId: 'n1', method: 'GET', url: 'http://app.test/favicon.ico', time },
  { type: 'network.response', ...identity, requestId: 'n1', status: 404, time },
  { type: 'network.request', ...identity, requestId: 'n2', method: 'POST', url: 'http://app.test/api/tasks', time },
  { type: 'network.response', ...identity, requestId: 'n2', status: 500, time },
  { type: 'network.request', ...identity, requestId: 'n3', method: 'GET', url: 'http://127.0.0.1:9/refused', time },
  { type: 'network.failed', ...identity, requestId: 'n3', time, reason: 'net::ERR_CONNECTION_REFUSED' },
  { type: 'network.request', ...identity, requestId: 'n4', method: 'GET', url: 'http://app.test/left', time },
  { type: 'network.failed', ...identity, requestId: 'n4', time, reason: 'net::ERR_ABORTED', canceled: true },
]

function policy(overrides: Partial<DiagnosticsPolicy>): DiagnosticsPolicy {
  return { ...defaultDiagnosticsPolicy, ...overrides }
}

const allRules = { runtimeErrors: true, consoleErrors: true, transportFailures: true, httpErrors: true, allow: [] }
const completeConsole = { state: 'complete' as const, entries: 0, errors: 0, warnings: 0, runtimeErrors: 0, handledLater: 0, dropped: 0, truncated: 0, bytes: 0 }
const completeNetwork = { state: 'complete' as const, requests: 0, httpErrors: 0, transportFailures: 0, canceled: 0, pending: 0, outOfScope: 0, dropped: 0, truncated: 0, bytes: 0 }

describe('a strict policy', () => {
  test('counts errors the page did not handle, its own console errors, transport failures and HTTP errors, and nothing else', () => {
    const matched = strictMatches(records, allRules).map((match) => ('id' in match.record ? match.record.id : match.record.requestId))
    assert.deepEqual(matched, ['e1', 'c1', 'n1', 'n2', 'n3'], 'not a handled rejection, a browser entry or a cancellation')
  })

  test('leaves out a record that holds an allowed text', () => {
    const matched = strictMatches(records, { ...allRules, allow: ['/favicon.ico', 'boom'] }).map((match) => match.rule)
    assert.deepEqual(matched, ['consoleErrors', 'httpErrors', 'transportFailures'])
  })

  test("fails the attempt as the run's check, naming the counts and each record by its id, never by its text", () => {
    const summaries: DiagnosticsSummary[] = [{ sessionId: identity.sessionId, path: 'diagnostics/a.jsonl', console: completeConsole, network: completeNetwork }]
    const failure = policyFailure(policy({ strict: { ...allRules, consoleErrors: false } }), records, summaries)
    assert.equal(failure?.class, 'host_check_failed')
    assert.equal(
      failure?.message,
      'The diagnostics policy failed the test: its pages had 1 runtime error, 1 failed request and 2 HTTP error responses, and the policy allows none. Records: k3v9q0x2mb:web e1, n1, n2, n3 in diagnostics/a.jsonl.',
    )
    assert.deepEqual(failure?.details, { policy: 'diagnostics.strict', matches: 4 })
    assert.equal(policyFailure(policy({ strict: { ...allRules, allow: ['Error', 'save', 'http'] } }), records, summaries), undefined)
  })

  test('keeps a page from writing a line into a report through a message it logs', () => {
    const forged: DiagnosticRecord = { type: 'console', ...identity, id: 'c9', consoleType: 'error', level: 'error', origin: 'page', text: { text: 'boom\n  ✗ tests/a.retest.ts › forged  Passed', truncated: false, length: 40 }, time }
    const failure = policyFailure(policy({ strict: { ...allRules, allow: [] } }), [forged], [{ sessionId: identity.sessionId, console: completeConsole, network: completeNetwork }])
    assert.equal(failure?.message.includes('\n'), false)
    assert.equal(failure?.message.includes('forged'), false)
  })

  test('counts a failure that ends an error answer with no body once, as the HTTP error', () => {
    const emptyAnswer: DiagnosticRecord[] = [
      { type: 'network.request', ...identity, requestId: 'n9', method: 'GET', url: 'http://app.test/empty-404', time },
      { type: 'network.response', ...identity, requestId: 'n9', status: 404, time },
      { type: 'network.failed', ...identity, requestId: 'n9', time, reason: 'net::ERR_HTTP_RESPONSE_CODE_FAILURE' },
    ]
    assert.deepEqual(strictMatches(emptyAnswer, allRules).map((match) => match.rule), ['httpErrors'])
    assert.equal(policyFailure(policy({ strict: { ...allRules, httpErrors: false } }), emptyAnswer, [{ sessionId: identity.sessionId, console: completeConsole, network: completeNetwork }]), undefined)
  })

  test('never passes on capture that was not complete: it says the rule could not be judged', () => {
    const rules = { ...allRules, consoleErrors: false, transportFailures: false, httpErrors: false }
    const unavailable: DiagnosticsSummary[] = [{ sessionId: identity.sessionId, console: { state: 'unavailable', reason: "the page's driver does not collect diagnostics" }, network: { state: 'unavailable', reason: "the page's driver does not collect diagnostics" } }]
    const missing = policyFailure(policy({ strict: rules }), [], unavailable)
    assert.equal(missing?.class, 'reporting_failed')
    assert.equal(missing?.message, "The diagnostics policy could not judge the test: its strict rules read capture that was not complete, so a record they would count may be missing: k3v9q0x2mb:web console was unavailable: the page's driver does not collect diagnostics.")
    const overflowed: DiagnosticsSummary[] = [{ sessionId: identity.sessionId, console: { ...completeConsole, state: 'partial', reason: "40 messages over the attempt's limits were dropped", dropped: 40 }, network: completeNetwork }]
    const partial = policyFailure(policy({ strict: rules }), [], overflowed)
    assert.equal(partial?.class, 'reporting_failed')
    assert.match(partial?.message ?? '', /could not judge the test: .* console was partial: 40 messages/)
    assert.equal(policyFailure(policy({ strict: { ...allRules, runtimeErrors: false, consoleErrors: false } }), [], overflowed), undefined, 'a network rule reads only the network')
    const both = policyFailure(policy({ strict: rules }), records, overflowed)
    assert.equal(both?.class, 'host_check_failed', 'a match found stays first')
    assert.match(String(both?.details?.['also']), /^reporting_failed: The diagnostics policy could not judge the test/)
  })

  test('never replaces a failure the test already had', () => {
    const own = { class: 'check_failed' as const, message: 'Expected "Saved".' }
    const diagnostics = policyFailure(policy({ strict: allRules }), records, [])
    const kept = withDiagnosticsFailure(own, diagnostics)
    assert.equal(kept?.class, 'check_failed')
    assert.match(String(kept?.details?.['also']), /^host_check_failed: The diagnostics policy failed the test/)
    assert.equal(withDiagnosticsFailure(undefined, undefined), undefined)
  })
})

describe('a required capture', () => {
  const complete = { state: 'complete' as const, entries: 0, errors: 0, warnings: 0, runtimeErrors: 0, handledLater: 0, dropped: 0, truncated: 0, bytes: 0 }
  const network = { state: 'complete' as const, requests: 0, httpErrors: 0, transportFailures: 0, canceled: 0, pending: 0, outOfScope: 0, dropped: 0, truncated: 0, bytes: 0 }

  test('passes a complete capture, empty or not, and refuses a partial or unavailable one as reporting_failed', () => {
    const required = policy({ requireComplete: true })
    assert.equal(policyFailure(required, [], [{ sessionId: 's:web', console: complete, network }]), undefined)
    const partial: DiagnosticsSummary = { sessionId: 's:web', console: { ...complete, state: 'partial', reason: '3 messages over the attempt\'s limits were dropped', dropped: 3 }, network: { state: 'unavailable', reason: "the page's driver does not collect diagnostics" } }
    const failure = policyFailure(required, [], [partial])
    assert.equal(failure?.class, 'reporting_failed')
    assert.equal(failure?.message, "The diagnostics policy requires complete capture, and it was not complete: s:web console was partial: 3 messages over the attempt's limits were dropped; s:web network was unavailable: the page's driver does not collect diagnostics.")
    assert.equal(policyFailure(policy({}), [], [partial]), undefined, 'without the policy, capture loss fails nothing')
  })
})

describe('the policy a run follows', () => {
  test('is the host block when given, else the config, else capture on with nothing strict', () => {
    const configured = policy({ requireComplete: true })
    assert.deepEqual(resolveDiagnostics(undefined, undefined), { ok: true, policy: defaultDiagnosticsPolicy })
    assert.deepEqual(resolveDiagnostics(undefined, configured), { ok: true, policy: configured })
    const host = resolveDiagnostics({ strict: { httpErrors: true, allow: ['/favicon.ico'] }, limits: { requests: 10, textLength: undefined } }, configured)
    assert.deepEqual(host, { ok: true, policy: { capture: true, requireComplete: false, strict: { runtimeErrors: false, consoleErrors: false, transportFailures: false, httpErrors: true, allow: ['/favicon.ico'] }, limits: { ...defaultDiagnosticLimits, requests: 10 } } })
  })

  test('refuses a host block it cannot read, naming every key at fault', () => {
    const refused = resolveDiagnostics(JSON.parse('{"capture":false,"requireComplete":true,"strict":{},"limits":{"requests":-1,"bodies":5}}'), undefined)
    assert.equal(refused.ok, false)
    if (refused.ok) return
    assert.equal(refused.failure.class, 'usage')
    assert.match(refused.failure.message, /^RunOptions\.diagnostics has 5 problems: /)
    for (const part of ['diagnostics.strict: expected at least one of', 'diagnostics.limits.requests:', 'diagnostics.limits.bodies: unknown key', 'diagnostics.requireComplete: cannot be true while capture is false', 'diagnostics.strict: cannot be set while capture is false']) {
      assert.ok(refused.failure.message.includes(part), part)
    }
  })

  test('is read from a config, which refuses an unknown key under it', () => {
    const loaded = validateConfig({ apps: { web: { browser: 'chrome' } }, diagnostics: { strict: { runtimeErrors: true }, limits: { consoleEntries: 5 } } }, 'retest.config.ts')
    assert.ok(loaded.ok)
    assert.equal(loaded.config.diagnostics?.strict?.runtimeErrors, true)
    assert.equal(loaded.config.diagnostics?.limits.consoleEntries, 5)
    const wrong = validateConfig({ apps: { web: { browser: 'chrome' } }, diagnostics: { strcit: true } }, 'retest.config.ts')
    assert.equal(wrong.ok ? '' : wrong.failure.message, 'retest.config.ts: diagnostics.strcit: unknown key')
  })
})

/** A page whose collector a test drives by hand: it hands the sink back, and counts stops. */
function scriptedPage(options: { refuse?: string } = {}): { page: Pick<OwnedPage, 'collectDiagnostics'>; sink: () => DiagnosticSink; stops: () => number } {
  let sink: DiagnosticSink | undefined
  let stops = 0
  const collection: DiagnosticCollection = { scope: chromiumScope, stop: () => void (stops += 1) }
  const page: Pick<OwnedPage, 'collectDiagnostics'> = {
    collectDiagnostics: async (given) => {
      if (options.refuse !== undefined) throw new Error(options.refuse)
      sink = given
      return collection
    },
  }
  return {
    page,
    sink: () => {
      assert.ok(sink !== undefined)
      return sink
    },
    stops: () => stops,
  }
}

function session(app: string): SessionIdentity {
  return { sessionId: `k3v9q0x2mb:${app}`, owner: { runId: 'run', testId: identity.testId, attemptId: identity.attemptId, app }, runtime: { kind: 'web', engine: 'chromium', product: 'Chrome', version: '154', executablePath: '/chrome', processIds: [1] } }
}

describe('an attempt\'s diagnostics', () => {
  function attempt(overrides: Partial<DiagnosticsPolicy> = {}, writeFails = false): { diagnostics: AttemptDiagnostics; events: EventBody[]; written: Map<string, string>; redactor: Redactor } {
    const events: EventBody[] = []
    const written = new Map<string, string>()
    const redactor = new Redactor()
    const diagnostics = new AttemptDiagnostics({
      policy: policy(overrides),
      redactor,
      writeArtifact: (path, bytes) => {
        if (writeFails) throw new Error('the disk is full')
        written.set(path, Buffer.from(bytes).toString('utf8'))
      },
      emit: (body) => void events.push(body),
      testId: identity.testId,
      attemptId: identity.attemptId,
      variant: { web: 'chrome' },
      named: true,
      clock: () => Date.parse(time),
    })
    return { diagnostics, events, written, redactor }
  }

  test('says a page whose driver collects nothing is unavailable, and that a capture which would not start is too', async () => {
    const { diagnostics, events, written } = attempt()
    const refusing = scriptedPage({ refuse: 'Could not collect diagnostics within 10 ms.' })
    await diagnostics.start([{ app: 'web', page: {}, session: session('web') }, { app: 'admin', page: refusing.page, session: session('admin') }], 10)
    const { summaries } = diagnostics.finish('attempt_ended')
    assert.deepEqual(summaries, [
      { app: 'web', sessionId: 'k3v9q0x2mb:web', console: { state: 'unavailable', reason: "the page's driver does not collect diagnostics" }, network: { state: 'unavailable', reason: "the page's driver does not collect diagnostics" } },
      { app: 'admin', sessionId: 'k3v9q0x2mb:admin', console: { state: 'unavailable', reason: 'Retest could not start capture: Could not collect diagnostics within 10 ms.' }, network: { state: 'unavailable', reason: 'Retest could not start capture: Could not collect diagnostics within 10 ms.' } },
    ])
    assert.deepEqual(events.map((event) => event.type), ['diagnostics.finished', 'diagnostics.finished'], 'no start marker for a capture that never started')
    assert.equal(written.size, 0)
  })

  test('waits for no page once the run stops, and stops a collector that answers afterwards', async () => {
    const { diagnostics, events } = attempt()
    let answer: ((collection: DiagnosticCollection) => void) | undefined
    let stops = 0
    const slow: Pick<OwnedPage, 'collectDiagnostics'> = { collectDiagnostics: () => new Promise((resolve) => (answer = resolve)) }
    const stop = Promise.withResolvers<void>()
    const starting = diagnostics.start([{ app: 'web', page: slow, session: session('web') }, { app: 'admin', page: scriptedPage().page, session: session('admin') }], 60_000, stop.promise)
    stop.resolve()
    const waited = performance.now()
    await starting
    assert.ok(performance.now() - waited < 1000, 'the stop ended the wait at once')
    answer?.({ scope: chromiumScope, stop: () => void (stops += 1) })
    await Promise.resolve()
    assert.equal(stops, 1, 'the late collector was stopped')
    const { summaries } = diagnostics.finish('run_interrupted')
    const reason = 'the run was interrupted before capture started'
    assert.deepEqual(summaries.map((summary) => summary.console), [{ state: 'unavailable', reason }, { state: 'unavailable', reason }])
    assert.deepEqual(events.map((event) => event.type), ['diagnostics.finished', 'diagnostics.finished'])
  })

  test('starts nothing when capture is off, and says so', async () => {
    const { diagnostics, events } = attempt({ capture: false })
    const scripted = scriptedPage()
    await diagnostics.start([{ app: 'web', page: scripted.page, session: session('web') }], 10)
    assert.deepEqual(diagnostics.finish('attempt_ended').summaries, [{ app: 'web', sessionId: 'k3v9q0x2mb:web', console: { state: 'disabled' }, network: { state: 'disabled' } }])
    assert.deepEqual(events.map((event) => event.type), ['diagnostics.finished'])
  })

  test('writes one artifact per session, between its markers, redacted again with what the run learned since', async () => {
    const { diagnostics, events, written, redactor } = attempt({ strict: { ...allRules, allow: [] } })
    const scripted = scriptedPage()
    await diagnostics.start([{ app: 'web', page: scripted.page, session: session('web') }], 10)
    scripted.sink().observe({ kind: 'console', consoleType: 'error', level: 'error', origin: 'page', text: 'code 739104 rejected', time: Date.parse(time) })
    redactor.learn('code', '739104')
    const { summaries, failure } = diagnostics.finish('attempt_ended')
    assert.equal(scripted.stops(), 1, 'the collector was stopped')
    const [summary] = summaries
    assert.ok(summary?.path !== undefined)
    assert.equal(summary.path, `diagnostics/${summary.path.slice('diagnostics/'.length)}`)
    assert.match(summary.path, /^diagnostics\/a-retest-ts-saves-[a-z0-9]+-k3v9q0x2mb-web-[a-z0-9]+\.jsonl$/)
    const text = written.get(summary.path) ?? ''
    assert.equal(text.includes('739104'), false)
    const reading = parseArtifact(text, summary.path)
    assert.ok(reading.ok)
    assert.deepEqual(reading.lines.map((line) => line.type), ['capture.started', 'console', 'capture.finished'])
    assert.equal(reading.lines[1]?.type === 'console' ? reading.lines[1].text.text : '', 'code {{code}} rejected')
    assert.deepEqual(events.map((event) => event.type), ['diagnostics.started', 'diagnostics.finished'])
    assert.match(failure?.message ?? '', /1 console error, and the policy allows none\. Records: k3v9q0x2mb:web c1 in diagnostics\/a-retest-ts-saves-[a-z0-9]+-k3v9q0x2mb-web-[a-z0-9]+\.jsonl\.$/)
  })

  test('says a capture whose artifact could not be saved is unavailable, and still judges what the page did', async () => {
    const { diagnostics } = attempt({ strict: { ...allRules, allow: [] } }, true)
    const scripted = scriptedPage()
    await diagnostics.start([{ app: 'web', page: scripted.page, session: session('web') }], 10)
    scripted.sink().observe({ kind: 'runtime_error', key: '1', errorKind: 'uncaught', message: 'Uncaught Error: boom', time: Date.parse(time), stack: [] })
    const { summaries, failure } = diagnostics.finish('attempt_ended')
    assert.deepEqual(summaries[0]?.console, { state: 'unavailable', reason: 'Retest could not save the diagnostics artifact: the disk is full' })
    assert.equal(summaries[0]?.path, undefined)
    assert.equal(failure?.class, 'host_check_failed')
  })

  test('redacts an artifact again in place, record by record, and leaves a line it cannot read as it was', () => {
    const line = JSON.stringify({ type: 'console', ...identity, id: 'c1', consoleType: 'log', level: 'info', origin: 'page', text: { text: 'a "quoted" hunter2', truncated: false, length: 18 }, time })
    const redacted = redactArtifactText(`${line}\nnot json\n`, (text) => text.replace('hunter2', '{{password}}'))
    assert.equal(redacted, `${line.replace('hunter2', '{{password}}')}\nnot json\n`)
  })
})

describe('how reports speak of diagnostics', () => {
  const consoleCounts = { state: 'complete' as const, entries: 4, errors: 1, warnings: 2, runtimeErrors: 1, handledLater: 0, dropped: 0, truncated: 1, bytes: 900 }
  const networkCounts = { state: 'partial' as const, reason: '2 requests over the attempt\'s limits were dropped', requests: 5, httpErrors: 1, transportFailures: 1, canceled: 0, pending: 1, outOfScope: 2, dropped: 2, truncated: 0, bytes: 3000 }

  test('in counts and states, never in the words of a message', () => {
    assert.equal(describeConsole(consoleCounts), 'console 4 entries, 1 error, 2 warnings, 1 runtime error, 1 cut')
    assert.equal(describeNetwork(networkCounts), "network partial (5 requests, 1 HTTP error, 1 failed, 1 pending, 2 out of scope, 2 dropped): 2 requests over the attempt's limits were dropped")
    assert.equal(describeConsole({ ...consoleCounts, entries: 0, runtimeErrors: 0 }), 'console empty')
    assert.equal(describeConsole({ state: 'unavailable', reason: 'the page crashed' }), 'console unavailable: the page crashed')
    const lines = diagnosticsCardLines([{ app: 'web', sessionId: 's:web', path: 'diagnostics/a.jsonl', scope: chromiumScope, console: consoleCounts, network: networkCounts }], 'run')
    assert.deepEqual(lines, [
      { label: 'Diagnostics', value: `web: ${describeConsole(consoleCounts)} · ${describeNetwork(networkCounts)} · run/diagnostics/a.jsonl` },
      { label: 'Scope', value: 'web: console covers top level document, same process frames, dedicated workers; network covers top level document, same process frames' },
    ])
    assert.equal(describeConsole({ ...consoleCounts, runtimeErrors: 0, handledLater: 1 }), 'console 4 entries, 1 error, 2 warnings, 1 handled later, 1 cut')
    assert.deepEqual(diagnosticsCardLines([{ sessionId: 's:page', console: { state: 'disabled' }, network: { state: 'disabled' } }], 'run'), [{ label: 'Diagnostics', value: 'capture disabled' }])
  })

  test('add up across tests only what is worth a look', () => {
    const summary: DiagnosticsSummary = { sessionId: 's:web', console: consoleCounts, network: networkCounts }
    const quiet: DiagnosticsSummary = { sessionId: 's:web', console: { ...consoleCounts, errors: 0, runtimeErrors: 0, truncated: 0 }, network: { ...networkCounts, state: 'complete', httpErrors: 0, transportFailures: 0 } }
    const test = (diagnostics: DiagnosticsSummary[]) => ({ testId: 't', name: 't', file: 'a.retest.ts', location: { file: 'a.retest.ts', line: 1, column: 1 }, attemptId: 'a', status: 'passed' as const, durationMs: 1, assertionCount: 1, evidence: [], diagnostics })
    assert.deepEqual(diagnosticsTotals([test([summary]), test([summary])]), ['2 runtime errors', '2 console errors', '2 HTTP errors', '2 failed requests', '2 partial captures', '2 records cut'])
    assert.equal(diagnosticsTotals([test([quiet])]), undefined)
    const unavailable: DiagnosticsSummary = { sessionId: 's:web', console: { state: 'unavailable', reason: 'none' }, network: { state: 'unavailable', reason: 'none' } }
    assert.deepEqual(diagnosticsTotals([test([unavailable])]), ['1 unavailable capture'], 'a capture that was never there is told apart from a quiet one')
  })
})
