import type { TestContext } from 'node:test'
import type { Transport, TransportHandlers } from '../../src/browser/cdp/transport.ts'
import type { OwnedBrowser, OwnedPage, SessionIdentity } from '../../src/browser/contract.ts'
import type { DiagnosticRecord, DiagnosticsSummary, NetworkRequestRecord } from '../../src/protocol/diagnostics.ts'
import type { EventBody } from '../../src/protocol/events.ts'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { isRecord } from '../../src/browser/cdp/message.ts'
import { PipeTransport } from '../../src/browser/cdp/transport.ts'
import { launchBrowser } from '../../src/browser/launch.ts'
import { parseArtifact } from '../../src/diagnostics/artifact.ts'
import { AttemptDiagnostics } from '../../src/diagnostics/attempt.ts'
import { defaultDiagnosticsPolicy, type DiagnosticsPolicy } from '../../src/diagnostics/policy.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { assertOk, browserPath, closeMs, goto, groupExists, launch, launchGated, observeUntil, openApp, openPage, processesUsing, profileOf, setupMs } from './browser-harness.ts'

// The Chromium collector on real Chrome, below the runner: a crashed page, a lost connection, a capture that cannot
// start, listeners that end with the capture, and two contexts at once. Each test drives the same `AttemptDiagnostics`
// the runner uses, so what it checks is what a run writes.

type Written = { path: string; text: string }

/** An attempt's diagnostics with its artifacts and events kept in memory. */
function attempt(attemptId: string, options: { redactor?: Redactor; policy?: DiagnosticsPolicy } = {}): { diagnostics: AttemptDiagnostics; written: Written[]; events: EventBody[] } {
  const written: Written[] = []
  const events: EventBody[] = []
  const diagnostics = new AttemptDiagnostics({
    policy: options.policy ?? defaultDiagnosticsPolicy,
    redactor: options.redactor ?? new Redactor(),
    writeArtifact: (path, bytes) => void written.push({ path, text: Buffer.from(bytes).toString('utf8') }),
    emit: (body) => void events.push(body),
    testId: 'tests/collector.retest.ts > collects',
    attemptId,
    variant: undefined,
    named: false,
  })
  return { diagnostics, written, events }
}

function session(attemptId: string, browser: OwnedBrowser): SessionIdentity {
  return {
    sessionId: `${attemptId}:page`,
    owner: { runId: 'run', testId: 'tests/collector.retest.ts > collects', attemptId, app: 'page' },
    runtime: { kind: 'web', engine: 'chromium', product: browser.product, version: browser.version, executablePath: browser.executablePath, processIds: [browser.pid] },
  }
}

function recordsOf(written: readonly Written[]): DiagnosticRecord[] {
  return written.flatMap(({ path, text }) => {
    const reading = parseArtifact(text, path)
    assert.ok(reading.ok, reading.ok ? '' : reading.problem)
    return reading.lines.filter((line): line is DiagnosticRecord => line.type !== 'capture.started' && line.type !== 'capture.finished')
  })
}

function onlySummary(summaries: readonly DiagnosticsSummary[]): DiagnosticsSummary {
  assert.equal(summaries.length, 1)
  const [summary] = summaries
  assert.ok(summary !== undefined)
  return summary
}

async function startOn(page: OwnedPage, browser: OwnedBrowser, attemptId: string, policy?: DiagnosticsPolicy): Promise<ReturnType<typeof attempt>> {
  const started = attempt(attemptId, policy === undefined ? {} : { policy })
  await started.diagnostics.start([{ app: 'page', page, session: session(attemptId, browser) }], setupMs)
  assert.deepEqual(started.events.map((event) => event.type), ['diagnostics.started'])
  return started
}

test('a page whose renderer crashes leaves a partial capture that keeps what came before, with open requests marked', async (t) => {
  const app = await openApp(t)
  const browser = await launch(t)
  const page = await openPage(t, browser, app.url)
  const { diagnostics, written } = await startOn(page, browser, 'crashing')
  assertOk(await goto(page, '/diagnostics/pending'))
  await observeUntil(page, { by: 'testId', value: 'status' }, (observation) => observation.text === 'Waiting')
  // The page asked for the hanging request as it loaded; the request is open on the server.
  await delay(200)
  const renderers = (await processesUsing(await profileOf(browser.pid))).filter((line) => line.includes('--type=renderer')).map((line) => Number(line.trim().split(/\s+/)[0]))
  assert.ok(renderers.length > 0, 'the page has a renderer process')
  for (const pid of renderers) process.kill(pid, 'SIGKILL')
  // A crashed page answers its next command at once, after the same event that ends the capture.
  const read = await page.execute({ kind: 'observe', locator: { by: 'testId', value: 'status' } }, 10_000)
  assert.equal(read.ok ? undefined : read.failure.class, 'session_lost')
  const { summaries, failure } = diagnostics.finish('attempt_ended')
  assert.equal(failure, undefined, 'no policy was declared')
  const summary = onlySummary(summaries)
  assert.ok(summary.console.state === 'partial', JSON.stringify(summary.console))
  assert.match(summary.console.reason, /^the page crashed at \S+, and nothing after it was captured$/)
  assert.ok(summary.network.state === 'partial')
  const records = recordsOf(written)
  assert.ok(records.some((record) => record.type === 'console' && record.text.text === 'waiting for the hanging request'), 'what came before the crash is kept')
  const hang = records.find((record) => record.type === 'network.request' && record.url.endsWith('/diagnostics/hang'))
  assert.ok(hang?.type === 'network.request')
  const pending = records.find((record) => record.type === 'network.pending' && record.requestId === hang.requestId)
  assert.equal(pending?.type === 'network.pending' ? pending.reason : undefined, 'page_crashed')
})

/** A pipe transport through which a test can deliver a message as if the browser had sent it. */
class InjectingTransport implements Transport {
  readonly #inner: Transport
  #handlers: TransportHandlers | undefined
  /** The session id of the last target Retest attached to. */
  lastSessionId: string | undefined

  constructor(inner: Transport) {
    this.#inner = inner
  }

  listen(handlers: TransportHandlers): void {
    this.#handlers = handlers
    this.#inner.listen({
      ...handlers,
      message: (text) => {
        const message: unknown = JSON.parse(text)
        if (isRecord(message) && isRecord(message['result']) && typeof message['result']['sessionId'] === 'string') this.lastSessionId = message['result']['sessionId']
        handlers.message(text)
      },
    })
  }

  send(text: string): ReturnType<Transport['send']> {
    return this.#inner.send(text)
  }

  close(): void {
    this.#inner.close()
  }

  inject(message: object): void {
    this.#handlers?.message(JSON.stringify(message))
  }
}

async function launchInjecting(t: TestContext): Promise<{ browser: OwnedBrowser; transport: () => InjectingTransport }> {
  const folder = await mkdtemp(join(tmpdir(), 'retest-browser-test-'))
  let browser: OwnedBrowser | undefined
  t.after(async () => {
    const failures: unknown[] = []
    const owned = browser
    if (owned !== undefined) {
      try {
        await owned.close(closeMs)
        assert.equal(groupExists(owned.pid), false)
      } catch (error) { failures.push(error) }
    }
    // The injected detach leaves real messages coming from Chrome. Its diagnostic logger can recreate browser.log
    // during recursive removal, so the transport and output must be closed before the folder is removed.
    try { await rm(folder, { recursive: true, force: true }) } catch (error) { failures.push(error) }
    if (failures.length > 0) throw new AggregateError(failures, 'Diagnostics fixture cleanup failed.')
  })
  let made: InjectingTransport | undefined
  browser = await launchBrowser({ executablePath: browserPath(), logFile: join(folder, 'browser.log'), headless: true }, undefined, (pipe) => {
    made = new InjectingTransport(new PipeTransport(pipe))
    return made
  })
  return {
    browser,
    transport: () => {
      assert.ok(made !== undefined)
      return made
    },
  }
}

test('a connection to the page that ends leaves a partial capture, with open requests marked as lost', async (t) => {
  const app = await openApp(t)
  const { browser, transport } = await launchInjecting(t)
  const page = await openPage(t, browser, app.url)
  const pageSession = transport().lastSessionId
  assert.ok(pageSession !== undefined, 'the page has a session')
  const { diagnostics, written } = await startOn(page, browser, 'detached')
  assertOk(await goto(page, '/diagnostics/pending'))
  await delay(200)
  // The browser's word that the page's target detached, as Chrome sends it when the target goes away.
  transport().inject({ method: 'Target.detachedFromTarget', params: { sessionId: pageSession, targetId: 'injected' } })
  const summary = onlySummary(diagnostics.finish('attempt_ended').summaries)
  assert.ok(summary.console.state === 'partial', JSON.stringify(summary.console))
  assert.match(summary.console.reason, /^the connection to the page ended at \S+ \(the target detached\), and nothing after it was captured$/)
  const records = recordsOf(written)
  assert.ok(records.some((record) => record.type === 'console' && record.text.text === 'waiting for the hanging request'))
  const pending = records.find((record) => record.type === 'network.pending')
  assert.equal(pending?.type === 'network.pending' ? pending.reason : undefined, 'connection_lost')
})

test('a capture that cannot start is unavailable, with the reason, and never reads as an empty capture', async (t) => {
  const app = await openApp(t)
  const browser = await launchGated(t, { hold: (method) => (method === 'Network.enable' ? delay(1500) : undefined) })
  const page = await openPage(t, browser, app.url)
  const started = attempt('unstarted')
  await started.diagnostics.start([{ app: 'page', page, session: session('unstarted', browser) }], 300)
  assert.deepEqual(started.events, [], 'no start marker for a capture that never started')
  assertOk(await goto(page, '/diagnostics/quiet'))
  const summary = onlySummary(started.diagnostics.finish('attempt_ended').summaries)
  assert.deepEqual(summary.console, { state: 'unavailable', reason: 'Retest could not start capture: Could not collect diagnostics within 300 ms.' })
  assert.deepEqual(summary.network, summary.console)
  assert.equal(summary.path, undefined, 'no artifact')
  assert.deepEqual(started.written, [])

  const plain = await launch(t)
  const quiet = await openPage(t, plain, app.url)
  const empty = await startOn(quiet, plain, 'quiet')
  assertOk(await goto(quiet, '/diagnostics/quiet'))
  const emptySummary = onlySummary(empty.diagnostics.finish('attempt_ended').summaries)
  assert.deepEqual(emptySummary.console, { state: 'complete', entries: 0, errors: 0, warnings: 0, runtimeErrors: 0, handledLater: 0, dropped: 0, truncated: 0, bytes: 0 })
})

test('a capture that ended hears nothing more, though the page goes on', async (t) => {
  const app = await openApp(t)
  const browser = await launch(t)
  const page = await openPage(t, browser, app.url)
  const { diagnostics, written } = await startOn(page, browser, 'stopped')
  assertOk(await goto(page, '/diagnostics/marker/alpha'))
  await observeUntil(page, { by: 'testId', value: 'status' }, (observation) => observation.text === 'Done')
  const before = diagnostics.finish('attempt_ended')
  assertOk(await goto(page, '/diagnostics/marker/bravo'))
  await observeUntil(page, { by: 'testId', value: 'status' }, (observation) => observation.text === 'Done')
  assert.deepEqual(diagnostics.finish('attempt_ended'), before, 'a second ending changes nothing')
  assert.equal(written.length, 1)
  const texts = recordsOf(written).flatMap((record) => (record.type === 'console' ? [record.text.text] : []))
  assert.deepEqual(texts, ['marker alpha'], 'nothing from the page after the capture ended')
})

test('two contexts of one browser at once each keep only their own records', async (t) => {
  const app = await openApp(t)
  const browser = await launch(t)
  const first = await openPage(t, browser, app.url)
  const second = await openPage(t, browser, app.url)
  const one = await startOn(first, browser, 'first')
  const two = await startOn(second, browser, 'second')
  await Promise.all([goto(first, '/diagnostics/marker/charlie'), goto(second, '/diagnostics/marker/delta')])
  await Promise.all([
    observeUntil(first, { by: 'testId', value: 'status' }, (observation) => observation.text === 'Done'),
    observeUntil(second, { by: 'testId', value: 'status' }, (observation) => observation.text === 'Done'),
  ])
  for (const [started, marker] of [[one, 'charlie'], [two, 'delta']] as const) {
    started.diagnostics.finish('attempt_ended')
    const records = recordsOf(started.written)
    assert.deepEqual(records.flatMap((record) => (record.type === 'console' ? [record.text.text] : [])), [`marker ${marker}`])
    assert.deepEqual(records.flatMap((record) => (record.type === 'network.request' ? [new URL(record.url).pathname] : [])), [`/diagnostics/marker/${marker}`, `/diagnostics/marker/${marker}/data`])
  }
})

test('an error answer with no body is one HTTP error, never a transport failure too, and Chrome\'s error page is out of scope', async (t) => {
  const app = await openApp(t)
  const browser = await launch(t)
  for (const status of [404, 500]) {
    const page = await openPage(t, browser, app.url)
    const strict = { ...defaultDiagnosticsPolicy, strict: { runtimeErrors: false, consoleErrors: false, transportFailures: true, httpErrors: false, allow: [] } }
    const { diagnostics, written } = await startOn(page, browser, `empty${status}`, strict)
    // Chrome will not show an empty error answer, so the navigation itself fails; the records say what happened.
    const opened = await goto(page, `/diagnostics/empty-${status}`)
    assert.equal(opened.ok ? undefined : opened.failure.details?.['errorText'], 'net::ERR_HTTP_RESPONSE_CODE_FAILURE')
    await delay(300)
    const { summaries, failure } = diagnostics.finish('attempt_ended')
    assert.equal(failure, undefined, 'a strict transport rule does not fail on a status')
    const summary = onlySummary(summaries)
    assert.ok(summary.network.state === 'complete', JSON.stringify(summary.network))
    assert.deepEqual([summary.network.httpErrors, summary.network.transportFailures], [1, 0])
    const records = recordsOf(written)
    const document = records.find((record) => record.type === 'network.request' && record.url.endsWith(`/diagnostics/empty-${status}`))
    assert.ok(document?.type === 'network.request')
    const ended = records.filter((record) => 'requestId' in record && record.type !== 'console' && record.requestId === document.requestId).map((record) => record.type)
    assert.deepEqual(ended, ['network.request', 'network.response', 'network.failed'], 'the failure is still recorded, as Chrome reported it')
    const errorPage = records.filter((record): record is NetworkRequestRecord => record.type === 'network.request' && record.url.startsWith('data:'))
    assert.ok(errorPage.length > 0, "Chrome's error page asked for its images")
    for (const request of errorPage) {
      const mark = records.find((record) => record.type === 'network.pending' && record.requestId === request.requestId)
      assert.equal(mark?.type === 'network.pending' ? mark.reason : undefined, 'out_of_scope', `${request.requestId} belongs to Chrome's error page`)
    }
  }
})
