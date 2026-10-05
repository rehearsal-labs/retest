import type { BrowserCommand, NewPageOptions, OwnedBrowser, OwnedPage, PageNavigation, PageReading, TextQuery } from '../../src/browser/contract.ts'
import type { DiagnosticCollection, DiagnosticSink } from '../../src/diagnostics/observations.ts'
import type { CommandResult } from '../../src/protocol/commands.ts'
import type { RetestEvent } from '../../src/protocol/events.ts'
import type { RunResult } from '../../src/protocol/result.ts'
import type { StorageState } from '../../src/protocol/storage-state.ts'
import type { LaunchBrowser } from '../../src/runner/browser-pool.ts'
import type { DiagnosticsConfig, RunOptions } from '../../src/runner/contract.ts'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { chromiumScope } from '../../src/diagnostics/chromium-collector.ts'
import { parseArtifact } from '../../src/diagnostics/artifact.ts'
import { eventsFile, resultFile } from '../../src/protocol/run-folder.ts'
import { createAgentReporter } from '../../src/reporters/agent.ts'
import { createHumanReporter } from '../../src/reporters/human.ts'
import { runFiles } from '../../src/runner/run.ts'
import { readRunFolder } from '../../src/store/read-run-folder.ts'
import { fakeLauncher } from '../support/fake-browser.ts'
import { newRunFolder, quickTimeouts, readEvents, rootDir, supportFile } from '../support/run-harness.ts'

/**
 * A page that delegates to a fake page and adds a collector a test scripts: each `goto` the page runs is heard as a
 * console error, a request and its 500 response.
 */
class DiagnosedPage implements OwnedPage {
  readonly #inner: OwnedPage
  readonly #hangs: boolean
  readonly #onCapture: (() => void) | undefined
  #sink: DiagnosticSink | undefined
  stops = 0

  constructor(inner: OwnedPage, hangs: boolean, onCapture: (() => void) | undefined) {
    this.#inner = inner
    this.#hangs = hangs
    this.#onCapture = onCapture
  }

  get url(): string | undefined {
    return this.#inner.url
  }

  readPage(queries: readonly TextQuery[], timeoutMs: number): Promise<PageReading> {
    return this.#inner.readPage(queries, timeoutMs)
  }

  onNavigation(listener: (navigation: PageNavigation) => void): () => void {
    return this.#inner.onNavigation(listener)
  }

  captureState(timeoutMs: number): Promise<StorageState> {
    return this.#inner.captureState(timeoutMs)
  }

  async execute(command: BrowserCommand, timeoutMs: number, signal?: AbortSignal, commandToken?: number): Promise<CommandResult> {
    const result = await this.#inner.execute(command, timeoutMs, signal, commandToken)
    if (command.kind === 'goto' && this.#sink !== undefined) {
      const time = Date.now()
      this.#sink.observe({ kind: 'console', consoleType: 'error', level: 'error', origin: 'page', text: `could not load ${command.url}`, time })
      this.#sink.observe({ kind: 'request', key: `${command.url}#1`, method: 'GET', url: `http://127.0.0.1:4173${command.url}`, time })
      this.#sink.observe({ kind: 'response', key: `${command.url}#1`, status: 500, time })
      this.#sink.observe({ kind: 'finished', key: `${command.url}#1`, time, durationMs: 1.5 })
    }
    return result
  }

  screenshot(timeoutMs: number): Promise<Uint8Array> {
    return this.#inner.screenshot(timeoutMs)
  }

  dispose(timeoutMs: number): Promise<void> {
    return this.#inner.dispose(timeoutMs)
  }

  // A page that hangs answers only once its own budget is long gone, as one whose Network.enable never returns.
  async collectDiagnostics(sink: DiagnosticSink, timeoutMs: number): Promise<DiagnosticCollection> {
    this.#onCapture?.()
    if (this.#hangs) await new Promise((resolve) => setTimeout(resolve, timeoutMs).unref())
    this.#sink = sink
    return { scope: chromiumScope, stop: () => void (this.stops += 1) }
  }
}

/** A fake browser whose pages collect diagnostics as `DiagnosedPage` scripts them. */
class DiagnosedBrowser implements OwnedBrowser {
  readonly #inner: OwnedBrowser
  readonly #hangs: boolean
  readonly #onCapture: (() => void) | undefined
  readonly pages: DiagnosedPage[] = []

  constructor(inner: OwnedBrowser, hangs: boolean, onCapture: (() => void) | undefined) {
    this.#inner = inner
    this.#hangs = hangs
    this.#onCapture = onCapture
  }

  get product(): string {
    return this.#inner.product
  }

  get version(): string {
    return this.#inner.version
  }

  get userAgent(): string {
    return this.#inner.userAgent
  }

  get pid(): number {
    return this.#inner.pid
  }

  get executablePath(): string {
    return this.#inner.executablePath
  }

  get connected(): boolean {
    return this.#inner.connected
  }

  async newPage(options: NewPageOptions, timeoutMs: number): Promise<OwnedPage> {
    const page = new DiagnosedPage(await this.#inner.newPage(options, timeoutMs), this.#hangs, this.#onCapture)
    this.pages.push(page)
    return page
  }

  onDisconnect(listener: (reason: string) => void): () => void {
    return this.#inner.onDisconnect(listener)
  }

  close(timeoutMs: number): Promise<void> {
    return this.#inner.close(timeoutMs)
  }
}

type Ran = { result: RunResult; events: RetestEvent[]; folder: string; human: string; agent: string; browsers: DiagnosedBrowser[] }

type RunCase = { diagnose?: boolean; hangs?: boolean; onCapture?: () => void; diagnostics?: DiagnosticsConfig; signal?: AbortSignal; setupMs?: number }

async function run(names: readonly string[], options: RunCase = {}): Promise<Ran> {
  const folder = newRunFolder()
  const { launch } = fakeLauncher()
  const browsers: DiagnosedBrowser[] = []
  const diagnosing: LaunchBrowser = async (launchOptions, timeoutMs) => {
    const browser = new DiagnosedBrowser(await launch(launchOptions, timeoutMs), options.hangs === true, options.onCapture)
    browsers.push(browser)
    return browser
  }
  let human = ''
  let agent = ''
  const runOptions: RunOptions = {
    files: names.map(supportFile),
    rootDir,
    apps: { kind: 'browser', browserPath: '/fake/chromium', baseUrl: 'http://127.0.0.1:4173' },
    timeouts: { ...quickTimeouts, ...(options.setupMs === undefined ? {} : { setup: options.setupMs }) },
    outputDir: folder,
    headless: true,
    workers: 1,
    signal: options.signal ?? new AbortController().signal,
    lastRunFile: false,
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
  }
  const reporters = [
    createHumanReporter({ stdout: { write: (text: string) => ((human += text), true) }, stderr: { write: () => true }, color: false, runFolder: 'run' }),
    createAgentReporter({ stdout: { write: (text: string) => ((agent += text), true) }, runFolder: 'run' }),
  ]
  const result = await runFiles(runOptions, reporters, options.diagnose === true ? diagnosing : launch)
  return { result, events: readEvents(folder).events, folder, human, agent, browsers }
}

function onlyTest(result: RunResult, name: string): RunResult['files'][number]['tests'][number] {
  const found = result.files.flatMap((file) => file.tests).find((test) => test.name === name)
  assert.ok(found !== undefined, name)
  return found
}

describe('diagnostics in a run with a driver that collects none', async () => {
  const ran = await run(['passing.retest.ts'])

  test('every test that ran says its capture is unavailable, and why, and passes as before', () => {
    assert.equal(ran.result.exitCode, 0)
    const saves = onlyTest(ran.result, 'saves a task')
    const reason = "the page's driver does not collect diagnostics"
    assert.deepEqual(saves.diagnostics, [{ sessionId: `${saves.attemptId}:page`, console: { state: 'unavailable', reason }, network: { state: 'unavailable', reason } }])
    assert.equal(existsSync(join(ran.folder, 'diagnostics')), false, 'no artifact claims a capture')
    assert.equal(ran.events.filter((event) => event.type === 'diagnostics.started').length, 0)
  })

  test('the reports count the captures that were never there, so they read apart from complete, quiet ones', () => {
    assert.match(ran.human, /\n {2}Diagnostics {2}3 unavailable captures · run\/diagnostics\n/)
    assert.match(ran.agent, /\ndiagnostics: 3 unavailable captures; run\/diagnostics\n/)
  })
})

describe('diagnostics in a run whose pages collect them', async () => {
  const ran = await run(['passing.retest.ts'], { diagnose: true })

  test('each attempt has an artifact its result and its events name, and every collector is stopped', () => {
    assert.equal(ran.result.exitCode, 0, 'console errors and HTTP errors fail nothing by default')
    const saves = onlyTest(ran.result, 'saves a task')
    const [summary] = saves.diagnostics ?? []
    assert.ok(summary?.path !== undefined)
    const reading = parseArtifact(readFileSync(join(ran.folder, summary.path), 'utf8'), summary.path)
    assert.ok(reading.ok)
    assert.deepEqual(reading.lines.map((line) => line.type), ['capture.started', 'console', 'network.request', 'network.response', 'network.finished', 'capture.finished'])
    assert.deepEqual(summary.console, { state: 'complete', entries: 1, errors: 1, warnings: 0, runtimeErrors: 0, handledLater: 0, dropped: 0, truncated: 0, bytes: summary.console.state === 'complete' ? summary.console.bytes : 0 })
    const finished = ran.events.filter((event) => event.type === 'diagnostics.finished' && event.attemptId === saves.attemptId)
    assert.deepEqual(finished.map((event) => (event.type === 'diagnostics.finished' ? event.diagnostics : undefined)), [summary])
    assert.ok(ran.browsers.flatMap((browser) => browser.pages).every((page) => page.stops === 1))
  })

  test('a result rebuilt from the events keeps every reference, and a capture cut off with the run reads as unavailable', () => {
    rmSync(join(ran.folder, resultFile))
    const rebuilt = readRunFolder(ran.folder).result
    for (const test of ran.result.files.flatMap((file) => file.tests)) {
      assert.deepEqual(onlyTest(rebuilt, test.name).diagnostics, test.diagnostics, test.name)
    }
    const lines = readFileSync(join(ran.folder, eventsFile), 'utf8').split('\n').filter((line) => line !== '')
    const cut = lines.slice(0, lines.findIndex((line) => line.includes('"type":"diagnostics.finished"')))
    writeFileSync(join(ran.folder, eventsFile), `${cut.join('\n')}\n`)
    const stopped = readRunFolder(ran.folder).result
    const [summary] = onlyTest(stopped, 'saves a task').diagnostics ?? []
    assert.deepEqual([summary?.console, summary?.path], [{ state: 'unavailable', reason: 'the run stopped before this capture was written' }, undefined])
    assert.equal(stopped.complete, false)
  })
})

describe('a declared policy in a run', () => {
  test('a strict policy fails each test that otherwise passed, from the parent, and the run exits 1', async () => {
    const ran = await run(['passing.retest.ts'], { diagnose: true, diagnostics: { strict: { httpErrors: true } } })
    assert.equal(ran.result.exitCode, 1)
    const saves = onlyTest(ran.result, 'saves a task')
    assert.deepEqual([saves.status, saves.failure?.class], ['failed', 'host_check_failed'])
    assert.match(saves.failure?.message ?? '', /^The diagnostics policy failed the test: its pages had 1 HTTP error response, and the policy allows none\. Records: \S+:page n1 in diagnostics\/\S+\.jsonl\.$/)
    const policy = ran.events.find((event) => event.type === 'diagnostics.started')
    assert.deepEqual(policy?.type === 'diagnostics.started' ? policy.policy : undefined, { strict: { httpErrors: true } })
    assert.match(ran.human, /Diagnostics {6}console 1 entry, 1 error · network 1 request, 1 HTTP error · run\/diagnostics\/\S+\n {4}Scope {12}console covers top level document/, 'the card names the counts, the artifact and what it covers')
    assert.match(ran.agent, /\n {2}diagnostics console 1 entry, 1 error · network 1 request, 1 HTTP error · run\/diagnostics\/\S+\n {2}scope console covers/)
    for (const words of ['could not load', 'GET http']) assert.equal(ran.human.includes(words) || ran.agent.includes(words), false, `no report prints ${words}`)
  })

  test('a required capture keeps a test whose driver collects none from passing, as an error, and its card says why', async () => {
    const ran = await run(['passing.retest.ts'], { diagnostics: { requireComplete: true } })
    assert.equal(ran.result.exitCode, 2)
    const saves = onlyTest(ran.result, 'saves a task')
    assert.deepEqual([saves.status, saves.failure?.class], ['error', 'reporting_failed'])
    const reason = "the page's driver does not collect diagnostics"
    assert.match(ran.human, new RegExp(`\\n {4}Diagnostics {6}console unavailable: ${reason} · network unavailable: ${reason}\\n`))
    assert.match(ran.agent, new RegExp(`\\n {2}diagnostics console unavailable: ${reason} · network unavailable: ${reason}\\n`))
  })

  test('a strict policy on a driver that collects nothing cannot pass: the test says it could not be judged', async () => {
    const ran = await run(['passing.retest.ts'], { diagnostics: { strict: { runtimeErrors: true } } })
    assert.equal(ran.result.exitCode, 2)
    const saves = onlyTest(ran.result, 'saves a task')
    assert.deepEqual([saves.status, saves.failure?.class, saves.failure?.details?.['policy']], ['error', 'reporting_failed', 'diagnostics.strict'])
    assert.match(saves.failure?.message ?? '', /^The diagnostics policy could not judge the test: .*console was unavailable: the page's driver does not collect diagnostics\.$/)
  })

  test('a run stopped while a page is slow to start its capture waits for no page, and the test is interrupted', async () => {
    const controller = new AbortController()
    // The stop comes once the page has been starting its capture for a while, however long a busy machine took to collect
    // the file and open the page; a stop on a fixed timer can land before either and test something else.
    const onCapture = (): void => void setTimeout(() => controller.abort('SIGINT'), 100)
    const started = performance.now()
    const ran = await run(['passing.retest.ts'], { diagnose: true, hangs: true, onCapture, signal: controller.signal, setupMs: 20_000 })
    assert.ok(performance.now() - started < 10_000, `the run ended ${Math.round(performance.now() - started)} ms after it started, not at the 20 s setup budget`)
    assert.equal(ran.result.exitCode, 130)
    const saves = onlyTest(ran.result, 'saves a task')
    assert.equal(saves.failure?.class, 'interrupted')
    const reason = 'the run was interrupted before capture started'
    assert.deepEqual(saves.diagnostics?.map((summary) => summary.console), [{ state: 'unavailable', reason }])
  })

  test('a block the run cannot read refuses the run before any test runs', async () => {
    const ran = await run(['passing.retest.ts'], { diagnostics: { strict: {} } })
    assert.equal(ran.result.exitCode, 2)
    assert.equal(ran.result.failure?.class, 'usage')
    assert.match(ran.result.failure?.message ?? '', /^RunOptions\.diagnostics has a problem: diagnostics\.strict: expected at least one of/)
    assert.equal(ran.result.files.flatMap((file) => file.tests).every((test) => test.status === 'not_run'), true)
  })
})
