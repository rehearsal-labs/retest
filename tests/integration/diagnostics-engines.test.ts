import type { TestContext } from 'node:test'
import type { OwnedBrowser, OwnedPage, SessionIdentity } from '../../src/browser/contract.ts'
import type { ConsoleRecord, DiagnosticKind, DiagnosticLine, DiagnosticRecord, DiagnosticsSummary, NetworkRecord, NetworkRequestRecord, RuntimeErrorRecord, ScopeArea } from '../../src/protocol/diagnostics.ts'
import type { EventBody } from '../../src/protocol/events.ts'
import type { TestResult } from '../../src/protocol/result.ts'
import type { EngineName, TestEngine } from './engines.ts'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { DIAGNOSTICS_WORDS, OPAQUE_TOKEN } from '../../fixtures/task-app/diagnostics-page.ts'
import { firefoxPlatformProblem } from '../../src/browser/firefox/executable.ts'
import { parseArtifact } from '../../src/diagnostics/artifact.ts'
import { AttemptDiagnostics } from '../../src/diagnostics/attempt.ts'
import { firefoxConsoleUnavailable } from '../../src/diagnostics/firefox-collector.ts'
import { defaultDiagnosticsPolicy } from '../../src/diagnostics/policy.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { runFiles } from '../../src/runner/run.ts'
import { readRunFolder } from '../../src/store/read-run-folder.ts'
import { fakeLauncher } from '../support/fake-browser.ts'
import { quickTimeouts } from '../support/run-harness.ts'
import { assertOk, closeMs, goto, observeUntil, openApp, setupMs } from './browser-harness.ts'
import { budgets, configSource, eventsOf, filesHolding, finishRun, runProject, startRun, testNamed, writeProject, type FinishedRun } from './cli-harness.ts'
import { engineUnderTest } from './engines.ts'

// The Release 1 console and network fixtures (the task app's diagnostics pages) on Chrome, Firefox and WebKit, through
// `retest run` and below it through the same `AttemptDiagnostics` the runner uses. Every engine is held to the same
// assertions: each console level, uncaught errors and unhandled rejections, request and response metadata, a 404 and a
// 500 apart from a refused connection, a redirect of two hops, timings, a request left pending, a capture that keeps
// listening across navigations into other sites, two contexts at once, a pooled browser shared by two files, a run
// stopped mid-capture, a capture over its limits, secrets in every place a page can put them, a capture that cannot
// start and one whose browser goes away. Where the fixed per-engine table covers an area, the fixture's record from
// that area must be there; where an engine supplies an optional field, it must be well formed, and where it does not,
// the field is absent. A difference between engines is never answered with a branch in an assertion, apart from the
// differences in `expected`, including Firefox's unavailable console: a case that fails on one engine is a finding
// for its driver. Firefox's refusal is checked by the real serialization matrix in firefox-diagnostics.test.ts.

/** An engine of this file, or the reason this machine cannot run it, which skips its tests by name. */
type EngineCase = { engine: TestEngine; unavailable: string | undefined }

// engines.ts names one engine per process through RETEST_TEST_ENGINE; this file drives all three in one process, so it
// reads each one's entry by name once, before any test runs, and puts the variable back as it found it.
function engineNamed(name: EngineName): TestEngine {
  const saved = process.env['RETEST_TEST_ENGINE']
  process.env['RETEST_TEST_ENGINE'] = name
  try {
    return engineUnderTest()
  } finally {
    if (saved === undefined) delete process.env['RETEST_TEST_ENGINE']
    else process.env['RETEST_TEST_ENGINE'] = saved
  }
}

const cases: readonly EngineCase[] = [
  { engine: engineNamed('chromium'), unavailable: undefined },
  { engine: engineNamed('firefox'), unavailable: firefoxPlatformProblem() },
  { engine: engineNamed('webkit'), unavailable: process.platform === 'darwin' ? undefined : `Retest runs WebKit on macOS only, and this host is ${process.platform}` },
]

// Every area a web page's records can come from, each of which a scope names as covered or not covered.
const webAreas: readonly ScopeArea[] = ['top_level_document', 'same_process_frames', 'out_of_process_frames', 'dedicated_workers', 'shared_workers', 'service_workers']
// The engines' own waits are longer than Chrome's for the same page; these budgets bound waits, never a verdict.
const runBudgets = budgets({ assertion: 10_000, action: 5000, test: 30_000 })

/** The fixed areas each engine covers, plus its unavailable-console reason and worker request attribution. */
type Areas = { covered: readonly ScopeArea[]; notCovered: readonly ScopeArea[] }
type Expected = { consoleUnavailable: string | undefined; workerRequestsAsPage: boolean; console: Areas; network: Areas }

// Fixed expectations for 0.1.0: changing a declared scope must fail independently of which records arrived.
// Firefox records no console message and no runtime error: it runs logged enumerable getters before a consumer can
// filter entries, and ignores subscription depth options. It names a dedicated worker's request by the page that
// started the worker. An engine not named here
// cannot pass a console check by declaring less: its console must be there.
const expected: Readonly<Record<EngineName, Expected>> = {
  chromium: {
    consoleUnavailable: undefined, workerRequestsAsPage: false,
    console: { covered: ['top_level_document', 'same_process_frames', 'dedicated_workers'], notCovered: ['out_of_process_frames', 'shared_workers', 'service_workers'] },
    network: { covered: ['top_level_document', 'same_process_frames'], notCovered: ['out_of_process_frames', 'dedicated_workers', 'shared_workers', 'service_workers'] },
  },
  firefox: {
    consoleUnavailable: firefoxConsoleUnavailable, workerRequestsAsPage: true,
    console: { covered: [], notCovered: ['top_level_document', 'same_process_frames', 'out_of_process_frames', 'dedicated_workers', 'shared_workers', 'service_workers'] },
    network: { covered: ['top_level_document', 'same_process_frames', 'out_of_process_frames'], notCovered: ['dedicated_workers', 'shared_workers', 'service_workers'] },
  },
  webkit: {
    consoleUnavailable: undefined, workerRequestsAsPage: false,
    console: { covered: ['top_level_document', 'same_process_frames', 'out_of_process_frames'], notCovered: ['dedicated_workers', 'shared_workers', 'service_workers'] },
    network: { covered: ['top_level_document', 'same_process_frames', 'out_of_process_frames'], notCovered: ['dedicated_workers', 'shared_workers', 'service_workers'] },
  },
}

test('a run stopped while its web page opens records an interrupted test with unavailable diagnostics', async (t) => {
  const root = await writeProject(t, { 'tests/stop.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'
test('never reaches its body', () => expect(1).toBe(1))
` })
  const controller = new AbortController()
  const release = Promise.withResolvers<void>()
  const reason = { class: 'interrupted', message: 'Stopped while the web page opened.' } as const
  let opened = 0
  const { launch, browsers } = fakeLauncher({ holdOpening: () => {
    opened++
    controller.abort(reason)
    release.resolve()
    return release.promise
  } })
  const output = join(root, 'run')
  const result = await runFiles({ files: ['tests/stop.retest.ts'], rootDir: root, outputDir: output,
    apps: { kind: 'browser', browserPath: '/fake/chromium' }, timeouts: quickTimeouts,
    diagnostics: { requireComplete: true }, signal: controller.signal, headless: true, workers: 1,
  }, [], launch)
  assert.equal(opened, 1, 'the stop happened inside page opening')
  assert.equal(result.exitCode, 130)
  const [file] = result.files
  const [stopped] = file?.tests ?? []
  assert.equal(file?.tests.length, 1)
  assert.deepEqual([stopped?.name, stopped?.status, stopped?.failure], ['never reaches its body', 'error', reason])
  const summary = { app: 'page', sessionId: `${stopped?.attemptId}:page`, console: { state: 'unavailable', reason: 'the run was interrupted before capture started' }, network: { state: 'unavailable', reason: 'the run was interrupted before capture started' } }
  assert.deepEqual(stopped?.diagnostics, [summary])
  assert.equal(browsers.every((browser) => !browser.connected), true)
  const written = readRunFolder(output)
  assert.deepEqual(written.result, result, 'the persisted interruption matches what the runner returned')
  assert.deepEqual(eventsOf(written.events, 'diagnostics.started'), [])
  const finished = eventsOf(written.events, 'diagnostics.finished')
  assert.equal(finished.length, 1)
  assert.deepEqual(finished.map(event => ({ testId: event.testId, attemptId: event.attemptId, session: event.session, sessionId: event.sessionId, diagnostics: event.diagnostics })), [{ testId: stopped?.testId, attemptId: stopped?.attemptId, session: 'page', sessionId: summary.sessionId, diagnostics: summary }])
})

test('a run stopped during collection lists no tests from the unfinished module and records the interruption', async (t) => {
  const root = await writeProject(t, {})
  const marker = join(root, 'collection-entered')
  await writeFile(join(root, 'stop.retest.ts'), `import { expect, test } from '@rehearsal-labs/retest'
import { writeFileSync } from 'node:fs'
test('declared before the pause', () => expect(1).toBe(1))
writeFileSync(${JSON.stringify(marker)}, 'ready')
await new Promise<void>(() => {})
`)
  const controller = new AbortController()
  const reason = { class: 'interrupted', message: 'Stopped during collection.' } as const
  const { launch, browsers } = fakeLauncher()
  const output = join(root, 'run')
  let settled = false
  const running = runFiles({ files: ['stop.retest.ts'], rootDir: root, outputDir: output,
    apps: { kind: 'browser', browserPath: '/fake/chromium' }, timeouts: quickTimeouts,
    signal: controller.signal, headless: true, workers: 1,
  }, [], launch).finally(() => { settled = true })
  try {
    const bound = performance.now() + quickTimeouts.collection
    while (!existsSync(marker)) {
      assert.ok(!settled && performance.now() < bound, 'the module reached its collection pause before the run ended')
      await delay(5)
    }
    assert.equal(settled, false, 'collection had not completed when the stop was sent')
  } finally {
    controller.abort(reason)
    await running
  }
  const result = await running
  assert.deepEqual([result.status, result.exitCode, result.failure], ['interrupted', 130, reason])
  assert.equal(result.files.length, 1)
  assert.deepEqual(result.files[0]?.tests, [], 'an unfinished module supplied no trustworthy collected test list')
  assert.deepEqual(result.files[0]?.failure, reason)
  assert.deepEqual(browsers, [], 'collection stopped before any browser launched')
  const written = readRunFolder(output)
  assert.deepEqual(written.result, result)
  assert.deepEqual(eventsOf(written.events, 'test.started'), [])
  assert.deepEqual(eventsOf(written.events, 'test.finished'), [])
})

/** A console with no source: unavailable with the engine's reason, and no console record or runtime error in the artifact. */
function assertNoConsole(capture: DiagnosticsSummary['console'], lines: readonly DiagnosticLine[], reason: string): void {
  assert.deepEqual(capture, { state: 'unavailable', reason })
  assert.deepEqual(records(lines).filter((line) => line.type === 'console' || line.type === 'runtime_error'), [], 'no console record and no runtime error')
}

/**
 * A capture's console as the engine is expected to give it: complete, holding exactly these texts among the messages
 * `pick` keeps, or, on an engine that records no console, unavailable with its reason and empty.
 */
function assertConsoleHolds(engine: TestEngine, capture: DiagnosticsSummary['console'], lines: readonly DiagnosticLine[], texts: readonly string[], what: string, pick: (line: ConsoleRecord) => boolean = () => true): void {
  const reason = expected[engine.name].consoleUnavailable
  if (reason !== undefined) return assertNoConsole(capture, lines, reason)
  assert.equal(capture.state, 'complete', JSON.stringify(capture))
  assert.deepEqual(consoles(lines).filter(pick).map((line) => line.text.text), texts, what)
}

/** A text as a regular expression that matches it word for word. */
function literally(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Declares one test per available engine, named with the engine first, so `--test-name-pattern` picks an engine. */
function eachEngine(name: string, body: (t: TestContext, engine: TestEngine) => Promise<void>): void {
  for (const { engine, unavailable } of cases) {
    test(`${engine.label}: ${name}`, async (t) => {
      if (unavailable !== undefined) {
        t.skip(unavailable)
        return
      }
      await body(t, engine)
    })
  }
}

async function project(t: TestContext, engine: TestEngine, files: Readonly<Record<string, string>>, diagnostics?: string): Promise<{ root: string; url: string }> {
  const app = await openApp(t)
  const block = diagnostics === undefined ? '' : `, diagnostics: ${diagnostics}`
  const root = await writeProject(t, { 'retest.config.ts': configSource(`{ apps: { web: ${engine.target(`baseUrl: ${JSON.stringify(app.url)}`)} }${block} }`), ...files })
  return { root, url: app.url }
}

function run(t: TestContext, engine: TestEngine, root: string, request: { args?: readonly string[]; env?: Readonly<Record<string, string>>; reporter?: 'human' | 'agent' } = {}): Promise<FinishedRun> {
  return runProject(t, root, { timeouts: runBudgets, ...request, env: { ...engine.environment, ...(request.env ?? {}) } })
}

/** Every line of a test's artifacts, read and checked against the diagnostics schema. */
function artifactLines(run: FinishedRun, result: TestResult): DiagnosticLine[] {
  return (result.diagnostics ?? []).flatMap((summary) => {
    assert.ok(summary.path !== undefined, `${summary.sessionId} names its artifact: ${JSON.stringify(summary)}`)
    const reading = parseArtifact(readFileSync(join(run.output, summary.path), 'utf8'), summary.path)
    assert.ok(reading.ok, reading.ok ? '' : reading.problem)
    return reading.lines
  })
}

function records(lines: readonly DiagnosticLine[]): DiagnosticRecord[] {
  return lines.filter((line): line is DiagnosticRecord => line.type !== 'capture.started' && line.type !== 'capture.finished')
}

function consoles(lines: readonly DiagnosticLine[]): ConsoleRecord[] {
  return records(lines).filter((line): line is ConsoleRecord => line.type === 'console')
}

function consoleNamed(lines: readonly DiagnosticLine[], text: string): ConsoleRecord {
  const found = consoles(lines).find((line) => line.text.text.includes(text))
  assert.ok(found !== undefined, `a console record says ${JSON.stringify(text)}`)
  return found
}

function pathOf(url: string): string {
  return new URL(url.replace(/…/g, '')).pathname
}

function requestsTo(lines: readonly DiagnosticLine[], path: string): NetworkRequestRecord[] {
  return records(lines).filter((line): line is NetworkRequestRecord => line.type === 'network.request' && pathOf(line.url) === path)
}

function requestTo(lines: readonly DiagnosticLine[], path: string): NetworkRequestRecord {
  const [found] = requestsTo(lines, path)
  assert.ok(found !== undefined, `a request went to ${path}`)
  return found
}

function hopRecords(lines: readonly DiagnosticLine[], requestId: string): NetworkRecord[] {
  return records(lines).filter((line): line is NetworkRecord => line.type.startsWith('network.') && 'requestId' in line && line.requestId === requestId)
}

function lifecycle(lines: readonly DiagnosticLine[], requestId: string): string[] {
  return hopRecords(lines, requestId).map((line) => line.type)
}

function responseOf(lines: readonly DiagnosticLine[], requestId: string): Extract<NetworkRecord, { type: 'network.response' }> {
  const found = hopRecords(lines, requestId).find((line): line is Extract<NetworkRecord, { type: 'network.response' }> => line.type === 'network.response')
  assert.ok(found !== undefined, `${requestId} has a response`)
  return found
}

function onlySummary(result: TestResult): DiagnosticsSummary {
  assert.equal(result.diagnostics?.length, 1, 'the test has one session')
  const [summary] = result.diagnostics ?? []
  assert.ok(summary !== undefined)
  return summary
}

function covers(summary: DiagnosticsSummary, kind: DiagnosticKind, area: ScopeArea): boolean {
  return summary.scope?.[kind].covered.includes(area) === true
}

const mainTest = `import { expect, test } from '@rehearsal-labs/retest'

test('emits every record', async ({ page }) => {
  await page.goto('/diagnostics')
  await expect(page.getByTestId('status')).toHaveText('Done')
  await expect(page).toHaveTitle('Diagnostics')
})
`

eachEngine('the fixture page leaves one artifact whose records hold every required kind, as the declared scope says, and the test passes', async (t, engine) => {
  const { root, url } = await project(t, engine, { 'tests/main.retest.ts': mainTest })
  const finished = await run(t, engine, root)
  const result = testNamed(finished, 'emits every record')
  const summary = onlySummary(result)
  const lines = artifactLines(finished, result)
  const all = records(lines)
  const consoleReason = expected[engine.name].consoleUnavailable
  // A check of the console. On an engine expected to record none, the kind must be unavailable with its reason and
  // hold no record, so the check never passes on an empty capture.
  const consoleCheck = (name: string, check: () => void): Promise<void> =>
    t.test(name, () => {
      if (consoleReason !== undefined) return assertNoConsole(summary.console, lines, consoleReason)
      check()
    })

  // Each check below is a subtest of its own, so one an engine fails does not hide the others.
  await t.test('the test passes: the expected console errors and HTTP errors failed nothing, and capture never ran the getter the page logged', () => {
    assert.equal(result.status, 'passed', JSON.stringify(result.failure))
    assert.equal(finished.exit.code, 0, finished.stderr)
  })

  await t.test('the capture is complete, says its engine and names every area of the page as covered or not', () => {
    if (consoleReason === undefined) assert.equal(summary.console.state, 'complete', JSON.stringify(summary.console))
    else {
      assert.deepEqual(summary.console, { state: 'unavailable', reason: consoleReason })
      assert.match(consoleReason, /enumerable getters/)
      assert.match(consoleReason, /before Retest can filter an entry/)
      assert.match(consoleReason, /ignores serialization options/)
      assert.deepEqual(all.filter((line) => line.type === 'console' || line.type === 'runtime_error'), [])
    }
    assert.equal(summary.network.state, 'complete', JSON.stringify(summary.network))
    assert.deepEqual([summary.scope?.engine, summary.scope?.source], [engine.name, 'page_target'])
    for (const kind of ['console', 'network'] as const) {
      const scope = summary.scope?.[kind]
      assert.deepEqual(scope?.covered, expected[engine.name][kind].covered, `${kind} keeps the engine's exact covered areas`)
      assert.deepEqual(scope?.notCovered, expected[engine.name][kind].notCovered, `${kind} keeps the engine's exact uncovered areas`)
      assert.deepEqual([...(scope?.covered ?? []), ...(scope?.notCovered ?? [])].sort(), [...webAreas].sort(), `${kind} names each area once, covered or not`)
    }
    assert.equal(lines[0]?.type, 'capture.started')
    const ending = lines.at(-1)
    assert.ok(ending?.type === 'capture.finished', 'the artifact ends with its marker')
    assert.deepEqual([ending.console, ending.network], [summary.console, summary.network], "the artifact's end says what the summary says")
    const startedAt = finished.events.findIndex((event) => event.type === 'diagnostics.started')
    const firstNavigation = finished.events.findIndex((event) => event.type === 'navigation')
    assert.ok(startedAt !== -1 && startedAt < firstNavigation, 'capture started before the first navigation')
    assert.deepEqual(eventsOf(finished.events, 'diagnostics.finished').map((event) => event.diagnostics), [summary], 'the events carry the summary the result keeps')
  })

  await consoleCheck('each console level is a record of its own, with its severity, from the page, and its place when the engine gives one', () => {
    for (const [word, level] of [[DIAGNOSTICS_WORDS.log, 'info'], [DIAGNOSTICS_WORDS.debug, 'debug'], [DIAGNOSTICS_WORDS.info, 'info'], [DIAGNOSTICS_WORDS.warning, 'warning'], [DIAGNOSTICS_WORDS.error, 'error']] as const) {
      const record = consoleNamed(lines, word)
      assert.deepEqual([record.level, record.origin], [level, 'page'], word)
      assert.ok(record.frame === undefined || record.frame === 'main', `${word} came from the main frame: ${record.frame}`)
      if (record.url !== undefined) assert.equal(record.url, `${url}/diagnostics`, word)
      for (const place of [record.line, record.column]) assert.ok(place === undefined || (Number.isInteger(place) && place >= 1), `${word}: lines and columns from 1`)
    }
  })

  await consoleCheck("a message's text holds every argument it was given, as the console shows them", () => {
    assert.equal(consoleNamed(lines, DIAGNOSTICS_WORDS.log).text.text, `${DIAGNOSTICS_WORDS.log} 42 {saved: true, title: "Release checklist"} [1, 2, 3]`)
  })

  await consoleCheck('the other console calls each leave a record of their type, an assertion as an error, and the getter shown, not called', () => {
    for (const word of ['diagnostic count', 'diagnostic assertion', 'diagnostic trace']) consoleNamed(lines, word)
    assert.equal(consoleNamed(lines, 'diagnostic assertion').level, 'error')
    for (const consoleType of ['table', 'count', 'assert', 'trace', 'dir']) assert.ok(consoles(lines).some((line) => line.consoleType === consoleType), `a ${consoleType} record keeps its type`)
    assert.equal(consoles(lines).find((line) => line.consoleType === 'dir')?.text.text, '{danger: (...)}', 'the getter is shown, not called')
    assert.equal(consoles(lines).some((line) => line.text.text.includes(DIAGNOSTICS_WORDS.getterRan)), false)
    for (const word of [`${DIAGNOSTICS_WORDS.frameFetched} 200`, `${DIAGNOSTICS_WORDS.workerFetched} 200`, `${DIAGNOSTICS_WORDS.remoteFrameFetched} 200`]) assert.equal(consoleNamed(lines, word).origin, 'page', 'the page heard from its frames and its worker')
  })

  // Each area of the page is a check of its own. A record from a frame or a worker carries its true label whatever the
  // scope declares. Each fixed covered area must leave its record, and each fixed uncovered area must leave none.
  const agrees = (kind: DiagnosticKind, area: ScopeArea, present: boolean): void => {
    assert.equal(present, expected[engine.name][kind].covered.includes(area), `${kind} ${area} agrees with the fixed per-engine coverage`)
  }
  const pageSite = (request: NetworkRequestRecord): boolean => request.url.startsWith(`${url}/`)
  const otherSite = (request: NetworkRequestRecord): boolean => new URL(request.url.replace(/…/g, '')).hostname === 'localhost'

  await consoleCheck("console, a frame of the page's site: its message carries frame child, and the scope agrees", () => {
    const message = consoles(lines).find((line) => line.text.text === DIAGNOSTICS_WORDS.frame)
    if (message !== undefined) assert.equal(message.frame, 'child')
    agrees('console', 'same_process_frames', message !== undefined)
  })

  await consoleCheck('console, a frame of another site: its message carries frame child, and the scope agrees', () => {
    const message = consoles(lines).find((line) => line.text.text === DIAGNOSTICS_WORDS.remoteFrame)
    if (message !== undefined) assert.equal(message.frame, 'child')
    agrees('console', 'out_of_process_frames', message !== undefined)
  })

  await consoleCheck("console, a dedicated worker: its message carries origin worker, and the scope agrees", () => {
    const message = consoles(lines).find((line) => line.text.text === DIAGNOSTICS_WORDS.worker)
    if (message !== undefined) assert.equal(message.origin, 'worker')
    agrees('console', 'dedicated_workers', message !== undefined)
  })

  // A frame's document and a worker's script are loads the page itself starts: each is labelled as its frame's, and
  // ends as the engine saw it end or is marked out of scope, never left pending as if it had not ended.
  await t.test("network, a frame of the page's site: its document and its fetch carry frame child, and the scope agrees", () => {
    const document = requestTo(lines, '/diagnostics/frame')
    assert.equal(document.frame, 'child')
    const end = hopRecords(lines, document.requestId).at(-1)
    assert.ok(end?.type === 'network.finished' || (end?.type === 'network.pending' && end.reason === 'out_of_scope'), `the document ended or was handed out of scope: ${JSON.stringify(end)}`)
    const fetches = requestsTo(lines, '/diagnostics/data').filter((request) => pageSite(request) && request.frame === 'child')
    assert.ok(fetches.length <= 1, `one fetch from the frame at most: ${fetches.length}`)
    agrees('network', 'same_process_frames', fetches.length === 1)
  })

  await t.test('network, a frame of another site: its document and its fetch carry frame child, and the scope agrees', () => {
    const document = requestTo(lines, '/diagnostics/remote-frame')
    assert.equal(document.frame, 'child')
    const end = hopRecords(lines, document.requestId).at(-1)
    assert.ok(end?.type === 'network.finished' || (end?.type === 'network.pending' && end.reason === 'out_of_scope'), `the document ended or was handed out of scope: ${JSON.stringify(end)}`)
    const fetches = requestsTo(lines, '/diagnostics/data').filter(otherSite)
    for (const request of fetches) assert.equal(request.frame, 'child')
    assert.ok(fetches.length <= 1, `one fetch from the other site at most: ${fetches.length}`)
    agrees('network', 'out_of_process_frames', fetches.length === 1)
  })

  await t.test("network, a dedicated worker: its script ends or is marked out of scope, the page's own fetches are counted exactly, and the scope agrees", () => {
    const script = requestTo(lines, '/diagnostics/worker.js')
    const end = hopRecords(lines, script.requestId).at(-1)
    assert.ok(end?.type === 'network.finished' || (end?.type === 'network.pending' && end.reason === 'out_of_scope'), `the script ended or was handed out of scope: ${JSON.stringify(end)}`)
    // From the page's own site and not from its frame: the page's fetch, the redirect's last hop, and the worker's own
    // fetch when the worker's requests are covered.
    // An engine that names a worker's request by its page, as its scope's reason must say, records the worker's fetch
    // as the page's: one more, exactly.
    const asPage = expected[engine.name].workerRequestsAsPage
    if (asPage) assert.match(summary.scope?.reason ?? '', /dedicated worker's request is recorded as its page's/, 'the scope says so')
    const mainFetches = requestsTo(lines, '/diagnostics/data').filter((request) => pageSite(request) && request.frame !== 'child')
    const counted = 2 + (covers(summary, 'network', 'dedicated_workers') || asPage ? 1 : 0)
    assert.equal(mainFetches.length, counted, `the page's fetch and the redirect's last hop${counted === 3 ? ", and the worker's fetch" : ''}; a fetch more is another area's request recorded as the page's`)
  })

  await consoleCheck('an uncaught error and an unhandled rejection are runtime errors of their kinds, the error with its stack and no query in it', () => {
    const errors = all.filter((line): line is RuntimeErrorRecord => line.type === 'runtime_error')
    const uncaught = errors.find((error) => error.message.text.includes(DIAGNOSTICS_WORDS.uncaught))
    assert.ok(uncaught !== undefined, 'the uncaught error is recorded')
    assert.equal(uncaught.kind, 'uncaught')
    assert.equal(uncaught.stack[0]?.function, 'throwFromScript', JSON.stringify(uncaught.stack))
    assert.equal(uncaught.stack[0]?.url, `${url}/diagnostics/thrower.js?…`)
    const rejection = errors.find((error) => error.message.text.includes(DIAGNOSTICS_WORDS.rejection))
    assert.ok(rejection !== undefined, 'the rejection is recorded')
    assert.equal(rejection.kind, 'unhandled_rejection', `the rejection is told apart from a thrown error: ${JSON.stringify(rejection.message)}`)
  })

  await t.test('a 404 and a 500 are finished responses with their statuses; the refused connection is a transport failure with its reason and no status', () => {
    for (const [path, status] of [['/diagnostics/missing', 404], ['/diagnostics/broken', 500]] as const) {
      const request = requestTo(lines, path)
      assert.deepEqual(lifecycle(lines, request.requestId), ['network.request', 'network.response', 'network.finished'], path)
      assert.equal(responseOf(lines, request.requestId).status, status)
    }
    const refused = requestTo(lines, '/diagnostics/refused')
    assert.deepEqual(lifecycle(lines, refused.requestId), ['network.request', 'network.failed'])
    const failure = hopRecords(lines, refused.requestId).find((line) => line.type === 'network.failed')
    assert.ok(failure?.type === 'network.failed' && failure.reason.trim() !== '', 'the failure says why')
    assert.equal(failure.canceled, undefined, 'a refused connection is not a cancellation')
  })

  await t.test('a fetch keeps its method, its address without the query, its status and a measured duration; no record holds the query', () => {
    const data = requestsTo(lines, '/diagnostics/data').find((request) => request.redirectedFrom === undefined && request.frame !== 'child')
    assert.ok(data !== undefined)
    assert.deepEqual([data.method, data.url], ['GET', `${url}/diagnostics/data?…`])
    assert.ok(data.resourceType === undefined || data.resourceType !== '', 'a resource type the engine gave is not empty')
    assert.deepEqual(lifecycle(lines, data.requestId), ['network.request', 'network.response', 'network.finished'])
    assert.equal(responseOf(lines, data.requestId).status, 200)
    const ended = hopRecords(lines, data.requestId).find((line) => line.type === 'network.finished')
    assert.ok(ended?.type === 'network.finished' && ended.durationMs !== undefined && ended.durationMs >= 0, `a duration measured on the engine's clock: ${JSON.stringify(ended)}`)
    assert.ok(Date.parse(ended.time) >= Date.parse(data.time), 'it ended after it started')
    assert.deepEqual(filesHolding(finished.output, OPAQUE_TOKEN), [], 'no file holds the query token')
  })

  await t.test('a redirect of two hops is two request and response pairs, each naming the next, ending in the final answer', () => {
    const first = requestTo(lines, '/diagnostics/redirect/1')
    const firstResponse = responseOf(lines, first.requestId)
    assert.equal(firstResponse.status, 302)
    const second = all.find((line): line is NetworkRequestRecord => line.type === 'network.request' && line.requestId === firstResponse.redirectedTo)
    assert.ok(second !== undefined, 'the 302 names the next hop')
    assert.deepEqual([second.redirectedFrom, pathOf(second.url)], [first.requestId, '/diagnostics/redirect/2'])
    const secondResponse = responseOf(lines, second.requestId)
    assert.equal(secondResponse.status, 307)
    const final = all.find((line): line is NetworkRequestRecord => line.type === 'network.request' && line.requestId === secondResponse.redirectedTo)
    assert.ok(final !== undefined, 'the 307 names the final hop')
    assert.deepEqual([final.redirectedFrom, final.url], [second.requestId, `${url}/diagnostics/data?…`])
    assert.deepEqual(lifecycle(lines, final.requestId), ['network.request', 'network.response', 'network.finished'])
  })

  await t.test('the request that never finished is marked pending when the attempt ended, with how far it got', () => {
    const hang = requestTo(lines, '/diagnostics/hang')
    const pending = hopRecords(lines, hang.requestId).find((line) => line.type === 'network.pending')
    assert.ok(pending?.type === 'network.pending')
    assert.equal(pending.reason, 'attempt_ended')
    assert.ok(['responded', 'receiving'].includes(pending.lastState), pending.lastState)
  })

  await t.test("the summary's counts are the records' own, and the fixture's", () => {
    assertCountsMatch(summary, all, consoleReason)
    assert.ok(summary.network.state === 'complete')
    assert.deepEqual([summary.network.httpErrors, summary.network.transportFailures, summary.network.pending], [2, 1, 1], 'the 404 and the 500, the refused connection, and the hanging request alone left pending')
    if (consoleReason !== undefined) return
    assert.ok(summary.console.state === 'complete')
    assert.equal(summary.console.runtimeErrors, 2, 'the uncaught error and the rejection')
  })

  t.diagnostic(`${engine.label} coverage: ${JSON.stringify(coverageFacts(summary, lines))}`)
})

/** Checks each count a summary gives against the records it summarizes; a console with no source has no counts and no record. */
function assertCountsMatch(summary: DiagnosticsSummary, all: readonly DiagnosticRecord[], consoleReason: string | undefined): void {
  assert.ok(summary.network.state === 'complete' || summary.network.state === 'partial')
  const statuses = new Map<string, number>()
  let transportFailures = 0
  for (const record of all) {
    if (record.type === 'network.response') statuses.set(record.requestId, record.status)
    if (record.type === 'network.failed' && record.canceled !== true && (statuses.get(record.requestId) ?? 0) < 400) transportFailures += 1
  }
  const pending = all.filter((record) => record.type === 'network.pending')
  assert.deepEqual(
    [summary.network.requests, summary.network.httpErrors, summary.network.transportFailures, summary.network.pending, summary.network.outOfScope],
    [all.filter((record) => record.type === 'network.request').length, [...statuses.values()].filter((status) => status >= 400).length, transportFailures, pending.filter((record) => record.type === 'network.pending' && record.reason !== 'out_of_scope').length, pending.filter((record) => record.type === 'network.pending' && record.reason === 'out_of_scope').length],
    'requests, HTTP errors, transport failures, pending and out of scope',
  )
  if (consoleReason !== undefined) {
    assert.deepEqual(summary.console, { state: 'unavailable', reason: consoleReason })
    assert.deepEqual(all.filter((record) => record.type === 'console' || record.type === 'runtime_error'), [])
    return
  }
  assert.ok(summary.console.state === 'complete' || summary.console.state === 'partial')
  const messages = all.filter((record): record is ConsoleRecord => record.type === 'console')
  assert.deepEqual(
    [summary.console.entries, summary.console.runtimeErrors, summary.console.errors, summary.console.warnings],
    [messages.length, all.filter((record) => record.type === 'runtime_error' && record.handledLater !== true).length, messages.filter((record) => record.level === 'error' && record.origin !== 'browser').length, messages.filter((record) => record.level === 'warning' && record.origin !== 'browser').length],
    'console entries, runtime errors, errors and warnings',
  )
}

/** The fixture's records an engine produced from areas its scope names as not covered, which the record reports. */
function beyondScope(summary: DiagnosticsSummary, lines: readonly DiagnosticLine[]): string[] {
  const seen: [DiagnosticKind, ScopeArea, boolean][] = [
    ['console', 'same_process_frames', consoles(lines).some((line) => line.text.text === DIAGNOSTICS_WORDS.frame)],
    ['console', 'out_of_process_frames', consoles(lines).some((line) => line.text.text === DIAGNOSTICS_WORDS.remoteFrame)],
    ['console', 'dedicated_workers', consoles(lines).some((line) => line.text.text === DIAGNOSTICS_WORDS.worker)],
    ['network', 'same_process_frames', requestsTo(lines, '/diagnostics/frame').some((request) => !hopRecords(lines, request.requestId).some((line) => line.type === 'network.pending'))],
    ['network', 'out_of_process_frames', records(lines).some((line) => line.type === 'network.request' && line.url.startsWith('http://localhost:') && pathOf(line.url) === '/diagnostics/data')],
  ]
  return seen.flatMap(([kind, area, found]) => (found && !covers(summary, kind, area) ? [`${kind} ${area}`] : []))
}

/** Which optional facts an engine's records carried on the fixture page, for the record's coverage table. */
function coverageFacts(summary: DiagnosticsSummary, lines: readonly DiagnosticLine[]): Record<string, unknown> {
  const all = records(lines)
  const pageMessages = consoles(lines).filter((line) => line.origin === 'page')
  const responses = all.filter((line) => line.type === 'network.response')
  const ends = all.filter((line) => line.type === 'network.finished')
  const errors = all.filter((line): line is RuntimeErrorRecord => line.type === 'runtime_error')
  return {
    console: summary.console.state,
    network: summary.network.state,
    consoleCovered: summary.scope?.console.covered,
    networkCovered: summary.scope?.network.covered,
    messagePlace: pageMessages.filter((line) => line.url !== undefined && line.line !== undefined).length + '/' + pageMessages.length,
    messageFrame: pageMessages.filter((line) => line.frame !== undefined).length + '/' + pageMessages.length,
    browserEntries: consoles(lines).filter((line) => line.origin === 'browser').length,
    resourceType: all.filter((line) => line.type === 'network.request' && line.resourceType !== undefined).length + '/' + all.filter((line) => line.type === 'network.request').length,
    contentType: responses.filter((line) => line.type === 'network.response' && line.contentType !== undefined).length + '/' + responses.length,
    cache: responses.filter((line) => line.type === 'network.response' && line.cache !== undefined).length + '/' + responses.length,
    protocol: responses.filter((line) => line.type === 'network.response' && line.protocol !== undefined).length + '/' + responses.length,
    duration: ends.filter((line) => line.type === 'network.finished' && line.durationMs !== undefined).length + '/' + ends.length,
    transferred: ends.filter((line) => line.type === 'network.finished' && line.transferredBytes !== undefined).length + '/' + ends.length,
    errorKinds: errors.map((error) => error.kind),
    errorStacks: errors.map((error) => error.stack.length),
    logText: consoles(lines).find((line) => line.text.text.startsWith(DIAGNOSTICS_WORDS.log))?.text.text,
    beyondScope: beyondScope(summary, lines),
  }
}

const markerTest = (names: readonly string[]): string => `import { expect, test } from '@rehearsal-labs/retest'
${names.map((name) => `
test('marks ${name}', async ({ page }) => {
  await page.goto('/diagnostics/marker/${name}')
  await expect(page.getByTestId('status')).toHaveText('Done')
})
`).join('')}`

function assertOwnMarker(engine: TestEngine, finished: FinishedRun, result: TestResult, marker: string): void {
  const lines = artifactLines(finished, result)
  const paths = records(lines).flatMap((line) => (line.type === 'network.request' ? [pathOf(line.url)] : []))
  assert.deepEqual(paths, [`/diagnostics/marker/${marker}`, `/diagnostics/marker/${marker}/data`], `${result.name} holds only its own requests`)
  assert.ok(records(lines).every((line) => line.attemptId === result.attemptId && line.sessionId === `${result.attemptId}:web`))
  const summary = onlySummary(result)
  assert.equal(summary.network.state, 'complete', JSON.stringify(summary))
  assertConsoleHolds(engine, summary.console, lines, [`marker ${marker}`], `${result.name} holds only its own message`)
}

eachEngine('the capture keeps listening across navigations, into another site and back, and across a reload, in one artifact', async (t, engine) => {
  const app = await openApp(t)
  const port = new URL(app.url).port
  // localhost and 127.0.0.1 are two sites, so the second page may load in a process of its own.
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: ${engine.target(`baseUrl: ${JSON.stringify(app.url)}`)} } }`),
    'tests/travel.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'

test('travels', async ({ page }) => {
  await page.goto('/diagnostics/marker/alpha')
  await expect(page.getByTestId('status')).toHaveText('Done')
  await page.goto('http://localhost:${port}/diagnostics/marker/bravo')
  await expect(page.getByTestId('status')).toHaveText('Done')
  await page.goto('http://127.0.0.1:${port}/diagnostics/marker/charlie')
  await expect(page.getByTestId('status')).toHaveText('Done')
  await page.reload()
  await expect(page.getByTestId('status')).toHaveText('Done')
})
`,
  })
  const finished = await run(t, engine, root)
  assert.equal(finished.exit.code, 0, finished.stderr)
  const result = testNamed(finished, 'travels')
  const summary = onlySummary(result)
  assert.equal(summary.network.state, 'complete', JSON.stringify(summary.network))
  const lines = artifactLines(finished, result)
  assertConsoleHolds(engine, summary.console, lines, ['marker alpha', 'marker bravo', 'marker charlie', 'marker charlie'], 'each page, the other site and the reloaded page among them', (line) => line.origin === 'page')
  const documents = records(lines).flatMap((line) => (line.type === 'network.request' && !pathOf(line.url).endsWith('/data') ? [`${new URL(line.url).hostname} ${pathOf(line.url)}`] : []))
  assert.deepEqual(documents, ['127.0.0.1 /diagnostics/marker/alpha', 'localhost /diagnostics/marker/bravo', '127.0.0.1 /diagnostics/marker/charlie', '127.0.0.1 /diagnostics/marker/charlie'])
  for (const marker of ['alpha', 'bravo', 'charlie']) {
    const fetched = requestsTo(lines, `/diagnostics/marker/${marker}/data`)
    assert.equal(fetched.length, marker === 'charlie' ? 2 : 1, `${marker}'s fetch`)
    for (const request of fetched) assert.deepEqual(lifecycle(lines, request.requestId), ['network.request', 'network.response', 'network.finished'], `${marker}'s fetch finished`)
  }
})

eachEngine('two apps of one test, two contexts of one browser at once, each keep only their own records in an artifact named with the app', async (t, engine) => {
  const app = await openApp(t)
  const target = engine.target(`baseUrl: ${JSON.stringify(app.url)}`)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { owner: ${target}, member: ${target} } }`),
    'tests/two.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'

test('two apps at once', { apps: ['owner', 'member'] }, async ({ owner, member }) => {
  await Promise.all([owner.goto('/diagnostics/marker/alpha'), member.goto('/diagnostics/marker/bravo')])
  await expect(owner.getByTestId('status')).toHaveText('Done')
  await expect(member.getByTestId('status')).toHaveText('Done')
})
`,
  })
  const finished = await run(t, engine, root)
  assert.equal(finished.exit.code, 0, finished.stderr)
  const result = testNamed(finished, 'two apps at once')
  assert.deepEqual(result.diagnostics?.map((summary) => [summary.app, summary.sessionId]), [['owner', `${result.attemptId}:owner`], ['member', `${result.attemptId}:member`]])
  for (const [name, marker] of [['owner', 'alpha'], ['member', 'bravo']] as const) {
    const summary: DiagnosticsSummary | undefined = result.diagnostics?.find((entry) => entry.app === name)
    assert.ok(summary?.path?.endsWith('.jsonl') === true && summary.path.includes(`-${name}-`), summary?.path)
    assert.equal(summary.network.state, 'complete')
    const reading = parseArtifact(readFileSync(join(finished.output, summary.path), 'utf8'), summary.path)
    assert.ok(reading.ok)
    assertConsoleHolds(engine, summary.console, reading.lines, [`marker ${marker}`], `${name} holds only its own page's message`)
    assert.deepEqual(records(reading.lines).flatMap((line) => (line.type === 'network.request' ? [pathOf(line.url)] : [])), [`/diagnostics/marker/${marker}`, `/diagnostics/marker/${marker}/data`])
    assert.ok(records(reading.lines).every((line) => line.app === name))
  }
})

eachEngine('two files at once in one pooled browser, each test after another in its pool, keep every record with its own attempt, twice over', async (t, engine) => {
  const { root } = await project(t, engine, { 'tests/a.retest.ts': markerTest(['alpha', 'bravo', 'charlie']), 'tests/b.retest.ts': markerTest(['delta', 'echo', 'foxtrot']) })
  for (let round = 0; round < 2; round += 1) {
    const finished = await run(t, engine, root, { args: ['--workers', '2', '--browsers', '1'] })
    assert.equal(finished.exit.code, 0, finished.stderr)
    assert.equal(eventsOf(finished.events, 'browser.started').length, 1, 'one browser served both files')
    for (const marker of ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']) assertOwnMarker(engine, finished, testNamed(finished, `marks ${marker}`), marker)
  }
})

eachEngine('a run stopped while a request hangs keeps what it captured, marks the request interrupted, ends the artifact and exits 130', async (t, engine) => {
  const { root } = await project(t, engine, {
    'tests/pending.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'

test('waits on a request that never ends', async ({ page }) => {
  await page.goto('/diagnostics/pending')
  await expect(page.getByTestId('status')).toHaveText('Never')
})
`,
  })
  const started = await startRun(t, { files: [], cwd: root, browser: false, env: engine.environment, timeouts: budgets({ assertion: 20_000, test: 30_000, action: 5000 }) })
  await started.retest.waitForEvent('observation')
  started.retest.signal('SIGINT')
  const finished = await finishRun(started)
  assert.equal(finished.exit.code, 130, finished.stderr)
  const result = testNamed(finished, 'waits on a request that never ends')
  assert.equal(result.failure?.class, 'interrupted')
  const summary = onlySummary(result)
  assert.ok(summary.network.state === 'complete' && summary.network.pending === 1, `the stop leaves the capture complete, with the hanging request its one pending hop: ${JSON.stringify(summary.network)}`)
  const lines = artifactLines(finished, result)
  assertConsoleHolds(engine, summary.console, lines, ['waiting for the hanging request'], "the page's message before the stop", (line) => line.origin === 'page')
  const hang = requestTo(lines, '/diagnostics/hang')
  const pending = hopRecords(lines, hang.requestId).find((line) => line.type === 'network.pending')
  assert.equal(pending?.type === 'network.pending' ? pending.reason : undefined, 'run_interrupted')
  assert.equal(lines.at(-1)?.type, 'capture.finished')
})

const floodTest = (count: number, size: number, fetches: number): string => `import { expect, test } from '@rehearsal-labs/retest'

test('floods the console', async ({ page }) => {
  await page.goto('/diagnostics/flood?count=${count}&size=${size}&fetches=${fetches}')
  await expect(page.getByTestId('status')).toHaveText('Done')
})
`

eachEngine('records over the limits are dropped and counted, the capture is partial with the reason, and a required capture keeps the test from passing', async (t, engine) => {
  const limits = '{ consoleEntries: 10, requests: 5 }'
  const lenient = await project(t, engine, { 'tests/flood.retest.ts': floodTest(50, 20, 30) }, `{ limits: ${limits} }`)
  const passing = await run(t, engine, lenient.root)
  assert.equal(passing.exit.code, 0, passing.stderr)
  const kept = testNamed(passing, 'floods the console')
  const summary = onlySummary(kept)
  const consoleReason = expected[engine.name].consoleUnavailable
  const lines = artifactLines(passing, kept)
  if (consoleReason === undefined) {
    assert.ok(summary.console.state === 'partial', JSON.stringify(summary.console))
    assert.equal(summary.console.entries, 10)
    assert.ok(summary.console.dropped >= 40, `dropped ${summary.console.dropped}`)
    assert.match(summary.console.reason, /^\d+ messages over the attempt's limits were dropped$/)
    assert.equal(consoles(lines).length, 10)
  } else {
    assertNoConsole(summary.console, lines, consoleReason)
  }
  assert.ok(summary.network.state === 'partial', JSON.stringify(summary.network))
  assert.equal(summary.network.requests, 5)
  assert.ok(summary.network.dropped >= 26)
  for (const request of records(lines).filter((line) => line.type === 'network.request')) assert.notEqual(lifecycle(lines, 'requestId' in request ? request.requestId : '').at(-1), 'network.request', 'a kept request keeps its later records')
  assert.equal(lines.at(-1)?.type, 'capture.finished')

  const strict = await project(t, engine, { 'tests/flood.retest.ts': floodTest(50, 20, 30) }, `{ requireComplete: true, limits: ${limits} }`)
  const refused = await run(t, engine, strict.root)
  assert.equal(refused.exit.code, 2, refused.stderr)
  const result = testNamed(refused, 'floods the console')
  assert.deepEqual([result.status, result.failure?.class], ['error', 'reporting_failed'])
  const consoleGap = consoleReason === undefined ? 'console was partial: .*' : `console was unavailable: ${literally(consoleReason)}`
  assert.match(result.failure?.message ?? '', new RegExp(`^The diagnostics policy requires complete capture, and it was not complete: \\S+:web ${consoleGap}; \\S+:web network was partial`))
})

const secretValue = 'correct horse "battery\\ staple'
const longSecret = `long-${'k7Qm2xWp9Lr4Zt8N'.repeat(8)}-${'end'.repeat(3)}`

/** Every run of ten characters of a value: the parts a cut could leave behind. */
function windows(value: string): string[] {
  return Array.from({ length: value.length - 9 }, (_, index) => value.slice(index, index + 10))
}

const secretsTest = `import { expect, secret, test } from '@rehearsal-labs/retest'

test('leaks a secret everywhere a page can', async ({ page }) => {
  await page.goto('/diagnostics/secrets')
  await page.getByTestId('secret').fill(secret('password'))
  await page.getByTestId('token').fill(secret('token'))
  await page.getByTestId('send').click()
  await expect(page.getByTestId('status')).toHaveText('Sent')
})
`

eachEngine('a secret the page puts in messages, errors, queries, paths, headers, cookies and stacks reaches no file and no report', async (t, engine) => {
  const app = await openApp(t)
  const config = configSource(`{ apps: { web: ${engine.target(`baseUrl: ${JSON.stringify(app.url)}`)} }, secrets: { password: env('RETEST_DIAGNOSTICS_SECRET'), token: env('RETEST_DIAGNOSTICS_TOKEN') } }`)
  const root = await writeProject(t, { 'retest.config.ts': config, 'tests/secrets.retest.ts': secretsTest })
  const env = { RETEST_DIAGNOSTICS_SECRET: secretValue, RETEST_DIAGNOSTICS_TOKEN: longSecret }
  const finished = await run(t, engine, root, { env })
  assert.equal(finished.exit.code, 0, finished.stderr)
  const result = testNamed(finished, 'leaks a secret everywhere a page can')
  const lines = artifactLines(finished, result)
  assert.deepEqual(filesHolding(finished.output, secretValue), [], 'no file in the run folder holds the secret, in any form a URL gives it')
  assert.deepEqual(filesHolding(finished.output, JSON.stringify(secretValue).slice(1, -1)), [], 'nor in the form JSON escapes it')
  for (const value of [secretValue, longSecret]) {
    const left = windows(value).filter((part) => filesHolding(finished.output, part).length > 0)
    assert.deepEqual(left, [], `no part of a ${value.length}-character secret is left`)
  }
  assert.deepEqual(filesHolding(finished.output, OPAQUE_TOKEN), [], 'no file holds a query value')
  const text = readFileSync(join(finished.output, onlySummary(result).path ?? ''), 'utf8').toLowerCase()
  for (const header of ['authorization', 'bearer', 'x-api-key', 'set-cookie', 'cookie']) assert.equal(text.includes(header), false, `the artifact holds no ${header}`)
  // Each path the page put a secret on, and the engine captures, carried it to a record, so the absence of the value
  // above is redaction, not a message that never arrived. An engine with no console source carries it on the network.
  const echo = records(lines).find((line): line is NetworkRequestRecord => line.type === 'network.request' && line.url.includes('/diagnostics/echo/'))
  assert.equal(echo?.url, `${app.url}/diagnostics/echo/{{password}}`)
  const consoleReason = expected[engine.name].consoleUnavailable
  if (consoleReason !== undefined) {
    assertNoConsole(onlySummary(result).console, lines, consoleReason)
  } else {
    assert.equal(consoleNamed(lines, 'the secret is').text.text, 'the secret is {{password}}', "the page's own words keep their place, with the secret written as its name")
    const object = consoleNamed(lines, 'note:')
    assert.ok(object.text.text.includes('quoted') && object.text.text.includes('{{password}}'), `the logged object's message holds the password by its name: ${JSON.stringify(object.text.text)}`)
    assert.ok(consoles(lines).some((line) => line.text.text.includes('{{token}}')), 'a message holds the long token by its name')
    assert.ok(consoles(lines).some((line) => line.level === 'error' && line.text.text.startsWith('Error: failed with {{password}}')), 'the logged error names the secret by its name')
    assert.ok(records(lines).some((line) => line.type === 'runtime_error' && line.message.text.includes('uncaught with {{password}}')), 'the uncaught error names the secret by its name')
    const thrower = records(lines).find((line): line is RuntimeErrorRecord => line.type === 'runtime_error' && line.message.text.includes(DIAGNOSTICS_WORDS.uncaught))
    assert.equal(thrower?.stack[0]?.url, `${app.url}/diagnostics/thrower.js?…`, 'the stack keeps the script, not its query')
  }
  for (const reporter of ['human', 'agent'] as const) {
    const shown = await run(t, engine, root, { env, reporter })
    assert.equal(shown.stdout.includes(secretValue), false, `the ${reporter} report never prints the secret`)
  }
})

eachEngine('a declared strict policy fails a test that otherwise passed, in the parent, names what matched, and prints no word the page wrote', async (t, engine) => {
  // A rule on runtime or console errors reads the console; on an engine with no console source it cannot judge.
  const consoleReason = expected[engine.name].consoleUnavailable
  const runtime = await project(t, engine, { 'tests/main.retest.ts': mainTest }, '{ strict: { runtimeErrors: true } }')
  const failed = await run(t, engine, runtime.root)
  const result = testNamed(failed, 'emits every record')
  if (consoleReason === undefined) {
    assert.deepEqual([failed.exit.code, result.status, result.failure?.class], [1, 'failed', 'host_check_failed'], JSON.stringify(result.failure))
    assert.match(result.failure?.message ?? '', /^The diagnostics policy failed the test: its pages had 2 runtime errors, and the policy allows none\. Records: \S+:web e1, e2 in diagnostics\/\S+\.jsonl\.$/)
    assert.deepEqual(result.failure?.details, { policy: 'diagnostics.strict', matches: 2 })
  } else {
    assert.deepEqual([failed.exit.code, result.status, result.failure?.class], [2, 'error', 'reporting_failed'], JSON.stringify(result.failure))
    assert.equal(result.failure?.message, `The diagnostics policy could not judge the test: its strict rules read capture that was not complete, so a record they would count may be missing: ${result.attemptId}:web console was unavailable: ${consoleReason}.`)
    assert.deepEqual(result.failure?.details, { policy: 'diagnostics.strict' })
  }
  assert.equal(result.assertionCount, 2, 'its own checks passed')
  assert.equal(result.evidence.length, 1, 'a failure screenshot was taken')
  assert.deepEqual(eventsOf(failed.events, 'diagnostics.started')[0]?.policy, { strict: { runtimeErrors: true } })

  // Only what the allow list leaves counts: the 404 is allowed, the 500 is not.
  const http = await project(t, engine, { 'tests/main.retest.ts': mainTest }, "{ strict: { httpErrors: true, allow: ['/diagnostics/missing'] } }")
  const httpRun = await run(t, engine, http.root)
  assert.equal(httpRun.exit.code, 1, httpRun.stderr)
  const httpResult = testNamed(httpRun, 'emits every record')
  assert.match(httpResult.failure?.message ?? '', /1 HTTP error response, and the policy allows none\./)
  const named = /Records: \S+:web (n\d+) in /.exec(httpResult.failure?.message ?? '')?.[1]
  assert.equal(named, requestTo(artifactLines(httpRun, httpResult), '/diagnostics/broken').requestId, 'the failure names the 500 by its id, not the allowed 404')

  for (const reporter of ['human', 'agent'] as const) {
    const shown = await run(t, engine, runtime.root, { reporter })
    for (const word of Object.values(DIAGNOSTICS_WORDS)) assert.equal(shown.stdout.includes(word), false, `the ${reporter} report of a strict failure never prints ${word}`)
    assert.match(shown.stdout, consoleReason === undefined ? /2 runtime errors, and the policy allows none\. Records: / : /could not judge the test: its strict rules read capture that was not complete/)
  }

  // With every match allowed, the test passes; a rule that reads a console with no source still cannot judge.
  const allowed = await project(t, engine, { 'tests/main.retest.ts': mainTest }, "{ strict: { runtimeErrors: true, transportFailures: true, allow: ['thrown from the script', 'rejected with nobody', '/diagnostics/refused'] } }")
  const allowedRun = await run(t, engine, allowed.root)
  const allowedResult = testNamed(allowedRun, 'emits every record')
  if (consoleReason === undefined) assert.equal(allowedRun.exit.code, 0, JSON.stringify(allowedResult.failure))
  else assert.deepEqual([allowedRun.exit.code, allowedResult.failure?.class], [2, 'reporting_failed'], JSON.stringify(allowedResult.failure))

  // Network rules alone judge on every engine: with each match allowed, the test passes.
  const network = await project(t, engine, { 'tests/main.retest.ts': mainTest }, "{ strict: { transportFailures: true, httpErrors: true, allow: ['/diagnostics/refused', '/diagnostics/missing', '/diagnostics/broken'] } }")
  const networkRun = await run(t, engine, network.root)
  assert.equal(networkRun.exit.code, 0, JSON.stringify(testNamed(networkRun, 'emits every record').failure))
})

eachEngine('a test that fails its own check keeps that failure first, its own artifact and a complete capture, with the strict policy after it', async (t, engine) => {
  const failing = mainTest.replace("toHaveText('Done')", "toHaveText('Never')").replace("('emits every record'", "('fails its own check'")
  const { root } = await project(t, engine, { 'tests/failing.retest.ts': failing, 'tests/quiet.retest.ts': markerTest(['alpha']) }, '{ strict: { runtimeErrors: true } }')
  const finished = await run(t, engine, root, { args: ['--workers', '1'] })
  assert.equal(finished.exit.code, 1, finished.stderr)
  const result = testNamed(finished, 'fails its own check')
  assert.deepEqual([result.status, result.failure?.class], ['failed', 'check_failed'], 'the test keeps its own failure')
  const consoleReason = expected[engine.name].consoleUnavailable
  const after = consoleReason === undefined ? /^host_check_failed: The diagnostics policy failed the test/ : /^reporting_failed: The diagnostics policy could not judge the test/
  assert.match(String(result.failure?.details?.['also'] ?? ''), after)
  const summary = onlySummary(result)
  assert.equal(summary.network.state, 'complete', JSON.stringify(summary))
  const lines = artifactLines(finished, result)
  assert.equal(lines[0]?.type, 'capture.started')
  assert.equal(lines.at(-1)?.type, 'capture.finished')
  assert.ok(records(lines).every((line) => line.attemptId === result.attemptId && line.sessionId === `${result.attemptId}:web`), "every record is the failed attempt's own")
  assert.equal(requestsTo(lines, '/diagnostics/marker/alpha').length, 0, "no request from the other test's page")
  assert.equal(requestsTo(lines, '/diagnostics/broken').length, 1, "the failed test's own requests are there")
  if (consoleReason === undefined) {
    assert.equal(summary.console.state, 'complete', JSON.stringify(summary))
    assert.equal(consoles(lines).some((line) => line.text.text === 'marker alpha'), false, "nothing from the other test's page")
    consoleNamed(lines, DIAGNOSTICS_WORDS.error)
  } else {
    assertNoConsole(summary.console, lines, consoleReason)
  }
  assertOwnMarker(engine, finished, testNamed(finished, 'marks alpha'), 'alpha')
})

eachEngine('a quiet page leaves a complete, empty console capture, and capture turned off says it was disabled and writes nothing', async (t, engine) => {
  const quietTest = `import { expect, test } from '@rehearsal-labs/retest'

test('stays quiet', async ({ page }) => {
  await page.goto('/diagnostics/quiet')
  await expect(page.getByTestId('quiet')).toBeVisible()
})
`
  const quiet = await project(t, engine, { 'tests/quiet.retest.ts': quietTest })
  const heard = await run(t, engine, quiet.root)
  assert.equal(heard.exit.code, 0, heard.stderr)
  const summary = onlySummary(testNamed(heard, 'stays quiet'))
  const consoleReason = expected[engine.name].consoleUnavailable
  const quietConsole = consoleReason === undefined ? { state: 'complete', entries: 0, errors: 0, warnings: 0, runtimeErrors: 0, handledLater: 0, dropped: 0, truncated: 0, bytes: 0 } : { state: 'unavailable', reason: consoleReason }
  assert.deepEqual(summary.console, quietConsole)
  assert.ok(summary.network.state === 'complete' && summary.network.requests === 1, `only the document: ${JSON.stringify(summary.network)}`)
  assert.ok(summary.path !== undefined, 'an artifact with its markers')

  const off = await project(t, engine, { 'tests/quiet.retest.ts': quietTest }, '{ capture: false }')
  const silent = await run(t, engine, off.root)
  assert.equal(silent.exit.code, 0, silent.stderr)
  const disabled = onlySummary(testNamed(silent, 'stays quiet'))
  assert.deepEqual([disabled.console, disabled.network, disabled.path], [{ state: 'disabled' }, { state: 'disabled' }, undefined])
  assert.equal(eventsOf(silent.events, 'diagnostics.started').length, 0)
})

// Below the runner, on a browser this test launches through its engine's driver and closes itself.

type Written = { path: string; text: string }

function attempt(attemptId: string): { diagnostics: AttemptDiagnostics; written: Written[]; events: EventBody[] } {
  const written: Written[] = []
  const events: EventBody[] = []
  const diagnostics = new AttemptDiagnostics({
    policy: defaultDiagnosticsPolicy,
    redactor: new Redactor(),
    writeArtifact: (path, bytes) => void written.push({ path, text: Buffer.from(bytes).toString('utf8') }),
    emit: (body) => void events.push(body),
    testId: 'tests/engines.retest.ts > collects',
    attemptId,
    variant: undefined,
    named: false,
  })
  return { diagnostics, written, events }
}

function sessionOn(engine: TestEngine, attemptId: string, browser: OwnedBrowser): SessionIdentity {
  return {
    sessionId: `${attemptId}:page`,
    owner: { runId: 'run', testId: 'tests/engines.retest.ts > collects', attemptId, app: 'page' },
    runtime: { kind: 'web', engine: engine.name, product: browser.product, version: browser.version, executablePath: browser.executablePath, processIds: [browser.pid] },
  }
}

function writtenRecords(written: readonly Written[]): DiagnosticRecord[] {
  return written.flatMap(({ path, text }) => {
    const reading = parseArtifact(text, path)
    assert.ok(reading.ok, reading.ok ? '' : reading.problem)
    return records(reading.lines)
  })
}

/** A browser of the engine, launched by its own driver, closed after the test unless the test closed it first. */
async function launched(t: TestContext, engine: TestEngine): Promise<OwnedBrowser> {
  const folder = await mkdtemp(join(tmpdir(), 'retest-engines-diagnostics-'))
  const browser = await engine.launch({ logFile: join(folder, 'browser.log'), headless: true }, setupMs * 3)
  t.after(async () => {
    await browser.close(closeMs)
    await rm(folder, { recursive: true, force: true })
  })
  return browser
}

async function pageOn(t: TestContext, browser: OwnedBrowser, baseUrl: string): Promise<OwnedPage> {
  const page = await browser.newPage({ baseUrl }, setupMs)
  t.after(() => page.dispose(2000).catch(() => undefined))
  return page
}

eachEngine('a capture on a page that is already closed is unavailable on both kinds with the reason, and never reads as an empty capture', async (t, engine) => {
  const app = await openApp(t)
  const browser = await launched(t, engine)
  const page = await pageOn(t, browser, app.url)
  await page.dispose(closeMs)
  const { diagnostics, written, events } = attempt('closed')
  await diagnostics.start([{ app: 'page', page, session: sessionOn(engine, 'closed', browser) }], 2000)
  const [summary] = diagnostics.finish('attempt_ended').summaries
  assert.ok(summary !== undefined)
  assert.equal(summary.console.state, 'unavailable')
  assert.match(summary.console.state === 'unavailable' ? summary.console.reason : '', /^Retest could not start capture: ./)
  assert.deepEqual(summary.network, summary.console)
  assert.equal(summary.path, undefined)
  assert.deepEqual(written, [])
  assert.deepEqual(events.map((event) => event.type), ['diagnostics.finished'])
})

eachEngine('a browser that goes away mid-capture leaves a partial capture that keeps what came before, with the open request marked', async (t, engine) => {
  const app = await openApp(t)
  const browser = await launched(t, engine)
  const page = await pageOn(t, browser, app.url)
  const { diagnostics, written } = attempt('lost')
  await diagnostics.start([{ app: 'page', page, session: sessionOn(engine, 'lost', browser) }], setupMs)
  assertOk(await goto(page, '/diagnostics/pending'))
  await observeUntil(page, { by: 'testId', value: 'status' }, (observation) => observation.text === 'Waiting')
  // The page asked for the hanging request as it loaded; give its response time to arrive.
  await delay(300)
  await browser.close(closeMs)
  const [summary] = diagnostics.finish('attempt_ended').summaries
  assert.ok(summary !== undefined)
  const consoleReason = expected[engine.name].consoleUnavailable
  for (const capture of consoleReason === undefined ? [summary.console, summary.network] : [summary.network]) {
    assert.ok(capture.state === 'partial', `the capture is not complete once its browser went away: ${JSON.stringify(capture)}`)
    assert.match(capture.reason, /^(the page crashed|the connection to the page ended) at \S+.*, and nothing after it was captured$/)
  }
  const kept = writtenRecords(written)
  if (consoleReason !== undefined) {
    assert.deepEqual(summary.console, { state: 'unavailable', reason: consoleReason })
    assert.deepEqual(kept.filter((record) => record.type === 'console' || record.type === 'runtime_error'), [])
  } else {
    assert.ok(kept.some((record) => record.type === 'console' && record.text.text === 'waiting for the hanging request'), 'what came before the loss is kept')
  }
  const hang = kept.find((record): record is NetworkRequestRecord => record.type === 'network.request' && pathOf(record.url) === '/diagnostics/hang')
  assert.ok(hang !== undefined)
  const pending = kept.find((record) => record.type === 'network.pending' && record.requestId === hang.requestId)
  assert.ok(pending?.type === 'network.pending' && ['connection_lost', 'page_crashed'].includes(pending.reason), JSON.stringify(pending))
})

eachEngine('a capture that ended hears nothing more though the page goes on, and two contexts of one browser at once each keep only their own records', async (t, engine) => {
  const app = await openApp(t)
  const browser = await launched(t, engine)
  const first = await pageOn(t, browser, app.url)
  const second = await pageOn(t, browser, app.url)
  const one = attempt('first')
  const two = attempt('second')
  await one.diagnostics.start([{ app: 'page', page: first, session: sessionOn(engine, 'first', browser) }], setupMs)
  await two.diagnostics.start([{ app: 'page', page: second, session: sessionOn(engine, 'second', browser) }], setupMs)
  await Promise.all([goto(first, '/diagnostics/marker/charlie'), goto(second, '/diagnostics/marker/delta')])
  await Promise.all([
    observeUntil(first, { by: 'testId', value: 'status' }, (observation) => observation.text === 'Done'),
    observeUntil(second, { by: 'testId', value: 'status' }, (observation) => observation.text === 'Done'),
  ])
  const ended = one.diagnostics.finish('attempt_ended')
  assertOk(await goto(first, '/diagnostics/marker/echo'))
  await observeUntil(first, { by: 'testId', value: 'status' }, (observation) => observation.text === 'Done')
  assert.deepEqual(one.diagnostics.finish('attempt_ended'), ended, 'a second ending changes nothing')
  const endedTwo = two.diagnostics.finish('attempt_ended')
  const consoleReason = expected[engine.name].consoleUnavailable
  for (const [started, marker, finishedAttempt] of [[one, 'charlie', ended], [two, 'delta', endedTwo]] as const) {
    const kept = writtenRecords(started.written)
    const texts = kept.flatMap((record) => (record.type === 'console' ? [record.text.text] : []))
    if (consoleReason === undefined) assert.deepEqual(texts, [`marker ${marker}`], `only ${marker}, and nothing after its capture ended`)
    else assert.deepEqual([finishedAttempt.summaries[0]?.console, texts], [{ state: 'unavailable', reason: consoleReason }, []])
    assert.deepEqual(kept.flatMap((record) => (record.type === 'network.request' ? [pathOf(record.url)] : [])), [`/diagnostics/marker/${marker}`, `/diagnostics/marker/${marker}/data`])
  }
})
