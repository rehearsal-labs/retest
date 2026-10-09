import type { OwnedBrowser, OwnedPage, SessionIdentity } from '../../src/browser/contract.ts'
import type { DiagnosticRecord } from '../../src/protocol/diagnostics.ts'
import type { EventBody } from '../../src/protocol/events.ts'
import type { TestContext } from 'node:test'
import type { Transport } from '../../src/browser/cdp/transport.ts'
import type { RecordingClock } from '../../src/protocol/recording.ts'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { isRecord } from '../../src/browser/cdp/message.ts'
import { PipeTransport } from '../../src/browser/cdp/transport.ts'
import { launchBrowser } from '../../src/browser/launch.ts'
import { buildReport } from '../../src/reporters/html/build-report.ts'
import { parse, s } from '../../src/protocol/schema.ts'
import { parseArtifact } from '../../src/diagnostics/artifact.ts'
import { AttemptDiagnostics } from '../../src/diagnostics/attempt.ts'
import { defaultDiagnosticsPolicy } from '../../src/diagnostics/policy.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { readArtifactFile, resultArtifactReferences } from '../../src/store/artifacts.ts'
import { assertOk, browserPath, byRole, byText, click, goto, groupExists, launch, observe, openApp, openPage, setupMs } from './browser-harness.ts'
import { budgets, configSource, finishRun, onlyEvent, repositoryRoot, RetestProcess, runCli, scratchFolder, writeProject } from './cli-harness.ts'
import { recordingSkip } from './recording-harness.ts'

// One real run on Chrome, two tests passing and one failing, with `--reporter html`; then `retest report` on the same
// folder; then the report opened in Chrome through Retest's own driver, with Retest's own console and network collector
// watching it. Retest's `goto` opens http and https addresses only, so the run folder is served read-only over loopback,
// each file through the store's safe read, which is the same set of files a `file://` address reaches. What a reader
// sees is asserted on the page: the failing check, both values, the screenshot; and from the collector and the server:
// no console error, no uncaught error, and no request for anything but the report and the files beside it. One passing
// test types a secret the page then shows; its value must reach neither the records nor either report, which show
// `{{note}}`. RETEST_REPORT_PROOF_OUT, when set, keeps the run folder and a screenshot of the report there.

const tests = `import { expect, secret, test } from '@rehearsal-labs/retest'

test('saves a task', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('task-title').fill('Release checklist')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
})

test('shows the title it was given', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('task-title').fill('Release checklist')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('Another task')
})

test('keeps the note it saved secret', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('task-title').fill(secret('note'))
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('{{note}}')
})
`

// Long enough for the run to accept, and made of words no fixture or report ever writes.
const note = 'orchid-harbor-7731'

type Written = { path: string; text: string }

/** Retest's own collector on one page, its artifact kept in memory. */
function collector(attemptId: string): { diagnostics: AttemptDiagnostics; written: Written[]; events: EventBody[] } {
  const written: Written[] = []
  const events: EventBody[] = []
  const diagnostics = new AttemptDiagnostics({
    policy: defaultDiagnosticsPolicy,
    redactor: new Redactor(),
    writeArtifact: (path, bytes) => void written.push({ path, text: Buffer.from(bytes).toString('utf8') }),
    emit: (body) => void events.push(body),
    testId: 'tests/integration/report-html.test.ts > reads the report',
    attemptId,
    variant: undefined,
    named: false,
  })
  return { diagnostics, written, events }
}

function session(attemptId: string, browser: OwnedBrowser): SessionIdentity {
  return {
    sessionId: `${attemptId}:page`,
    owner: { runId: 'report', testId: 'tests/integration/report-html.test.ts > reads the report', attemptId, app: 'page' },
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

type ServedFolder = { url: string; requested: string[]; refused: string[] }

const contentTypes: Readonly<Record<string, string>> = { html: 'text/html; charset=utf-8', png: 'image/png', jpg: 'image/jpeg', jsonl: 'application/jsonl' }

/**
 * Serves a run folder over loopback, read-only, each request's path read as a portable reference through the store's
 * safe read, so nothing outside the folder, no link and no second name is ever served. Every path asked for is kept,
 * and every one refused.
 */
async function serveFolder(t: TestContext, folder: string): Promise<ServedFolder> {
  const requested: string[] = []
  const refused: string[] = []
  const server = createServer((request, response) => {
    const raw = new URL(request.url ?? '/', 'http://127.0.0.1').pathname.slice(1)
    let reference: string
    try {
      reference = decodeURIComponent(raw)
    } catch {
      reference = raw
    }
    requested.push(reference)
    // Chrome asks an http server for its icon by itself, which a file address never makes it do; nothing is there.
    if (reference === 'favicon.ico') {
      response.writeHead(204, { 'cache-control': 'no-store' })
      response.end()
      return
    }
    const read = readArtifactFile(folder, reference, { maxBytes: 64 * 1024 * 1024 })
    if (!read.ok) {
      refused.push(reference)
      response.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
      response.end('not in the run folder')
      return
    }
    response.writeHead(200, { 'content-type': contentTypes[reference.split('.').at(-1) ?? ''] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    response.end(read.bytes)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return { url: `http://127.0.0.1:${address.port}`, requested, refused }
}

/** The run's outcome and each test's status, as the report's outcome data block states them. */
function parseOutcome(text: string): { status: unknown; exitCode: unknown; complete: unknown; statuses: unknown[] } {
  const value: unknown = JSON.parse(text)
  assert.ok(typeof value === 'object' && value !== null, text)
  const tests: unknown = Reflect.get(value, 'tests')
  assert.ok(Array.isArray(tests), text)
  const listed: readonly unknown[] = tests
  return { status: Reflect.get(value, 'status'), exitCode: Reflect.get(value, 'exitCode'), complete: Reflect.get(value, 'complete'), statuses: listed.map((test) => Reflect.get(Object(test), 'status')) }
}

async function visibleOnce(page: OwnedPage, what: Parameters<typeof observe>[1], label: string): Promise<void> {
  const seen = await observe(page, what)
  assert.ok(seen.count >= 1 && seen.visible === true, `${label}: ${JSON.stringify(seen)}`)
}

test('a real run writes a report that Chrome shows from its folder: the failing check, its values and its screenshot, and nothing loaded from outside', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) }, secrets: { note: env('RETEST_REPORT_NOTE') } }`),
    'tests/report.retest.ts': tests,
  })
  const folder = await scratchFolder(t)
  const output = join(folder, 'run')
  const retest = await RetestProcess.start(t, { args: ['run', '--reporter', 'html', '--output', output, '--timeouts', budgets({ test: 30_000 })], cwd: root, tmp: join(folder, 'tmp'), env: { RETEST_REPORT_NOTE: note } })
  const run = await finishRun({ retest, output })
  assert.equal(run.exit.code, 1, `${run.stdout}\n${run.stderr}`)
  assert.match(run.stdout, /Report {2}\S+report\.html\n\n$/)
  const results = run.result?.files.flatMap((file) => file.tests) ?? []
  assert.deepEqual(results.map((result) => [result.name, result.status]), [['saves a task', 'passed'], ['shows the title it was given', 'failed'], ['keeps the note it saved secret', 'passed']])
  const failed = results.find((result) => result.status === 'failed')
  assert.ok(failed !== undefined && failed.failure?.class === 'check_failed', JSON.stringify(run.result))
  const screenshot = onlyEvent(run.events, 'evidence.captured').path
  const reportPath = join(output, 'report.html')
  const fromRun = readFileSync(reportPath, 'utf8')
  assert.match(fromRun, /data-status="failed" data-exit-code="1" data-complete="true" data-source="run"/)

  // The same folder, reported afterwards from its result.json and events, states the same outcome.
  const reported = await runCli(t, ['report', output])
  assert.equal(reported.exit.code, 0, reported.stderr)
  const fromFolder = readFileSync(reportPath, 'utf8')
  assert.match(fromFolder, /data-status="failed" data-exit-code="1" data-complete="true" data-source="result\.json"/)
  const marks = (html: string): string[] => [...html.matchAll(/data-(?:status|exit-code|complete|test-id|failure-class|evidence)="[^"]*"/g)].map(([mark]) => mark)
  assert.deepEqual(marks(fromFolder), marks(fromRun))
  assert.ok(fromFolder.includes(`<img src="${screenshot}"`), `the report shows ${screenshot}`)

  // The secret the page showed is `{{note}}` in the records, and stays so in both reports; its value is in none.
  const records = { 'events.jsonl': readFileSync(join(output, 'events.jsonl'), 'utf8'), 'result.json': readFileSync(join(output, 'result.json'), 'utf8'), 'the run’s report': fromRun, 'the folder’s report': fromFolder }
  for (const [name, text] of Object.entries(records)) assert.ok(!text.includes(note), `${name} holds the secret's value`)
  assert.ok(fromFolder.includes('fill getByTestId(&#39;task-title&#39;), {{note}}'), 'the fill shows the placeholder')
  assert.ok(fromFolder.includes('text &quot;{{note}}&quot;'), 'the look the check rested on shows the placeholder')

  // The outcome data block states the run's result.
  const block = /<script type="application\/json" id="retest-outcome">([^<]*)<\/script>/.exec(fromFolder)?.[1]
  assert.ok(block !== undefined, 'the report carries its outcome data block')
  const outcome = parseOutcome(block)
  assert.deepEqual(outcome, { status: 'failed', exitCode: 1, complete: true, statuses: ['passed', 'failed', 'passed'] })

  // Chrome opens it through Retest's own driver, with Retest's collector on the page, from the folder served as it is.
  const served = await serveFolder(t, output)
  const browser = await launch(t)
  const page = await openPage(t, browser)
  const watched = collector('report')
  await watched.diagnostics.start([{ app: 'page', page, session: session('report', browser) }], setupMs)
  assertOk(await goto(page, `${served.url}/report.html`, 10_000))
  await visibleOnce(page, byRole('heading', 'Failures'), 'the failures heading')
  await visibleOnce(page, byText('Check failed toHaveText'), 'the failing check')
  await visibleOnce(page, byText('"Another task"'), 'the expected value')
  await visibleOnce(page, byText('"Release checklist"'), 'the received value')
  await visibleOnce(page, byRole('img', 'Failure screenshot of web', true), 'the screenshot')
  // Each test's heading and its row in the table say how much of its evidence is here, apart from its outcome.
  const evidence = await observe(page, byText('Evidence complete'))
  assert.ok(evidence.count === 6 && evidence.items.every((item) => item.visible), `the evidence status: ${JSON.stringify(evidence)}`)
  assert.match(fromFolder, /data-status="failed" data-failure-class="check_failed" data-evidence="complete"/)
  const proof = process.env['RETEST_REPORT_PROOF_OUT']
  const picture = proof === undefined ? undefined : await page.screenshot(10_000)
  const { summaries } = watched.diagnostics.finish('attempt_ended')
  const seen = recordsOf(watched.written)

  // Nothing went wrong on the page, and nothing was asked for but the report and the files beside it in its folder.
  const errors = seen.filter((record) => record.type === 'runtime_error' || (record.type === 'console' && (record.level === 'error' || record.level === 'warning')))
  assert.deepEqual(errors, [], 'no console error or warning, and no uncaught error')
  const summary = summaries[0]
  assert.ok(summary !== undefined && summary.console.state === 'complete' && summary.network.state === 'complete', JSON.stringify(summary))
  const requests = seen.filter((record) => record.type === 'network.request')
  assert.ok(requests.length >= 2, `the report and its screenshot were requested: ${JSON.stringify(requests)}`)
  for (const request of requests) assert.ok(request.url.startsWith(`${served.url}/`), `a request left the folder: ${request.url}`)
  // Besides the icon Chrome asks an http server for by itself, the page asks for the report and its screenshot alone.
  assert.deepEqual(served.refused, [], 'every file the page asked for is in the run folder and passed the safe read')
  const fromPage = [...new Set(served.requested.filter((path) => path !== 'favicon.ico'))].sort()
  assert.deepEqual(fromPage, ['report.html', screenshot].sort(), 'the page asked for the report and its screenshot, and nothing else')
  const image = requests.find((request) => request.url.endsWith(`/${screenshot}`))
  assert.ok(image !== undefined, `the screenshot was requested: ${requests.map((request) => request.url).join(', ')}`)
  const finished = seen.find((record) => record.type === 'network.finished' && record.requestId === image.requestId)
  const failedLoad = seen.find((record) => record.type === 'network.failed' && record.requestId === image.requestId)
  assert.ok(finished !== undefined && failedLoad === undefined, 'the screenshot loaded')

  // At a phone's width the failing check and its values are still there to read.
  const narrow = await openPage(t, browser, undefined, { emulation: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, touch: false, isMobile: false } })
  assertOk(await goto(narrow, `${served.url}/report.html`, 10_000))
  await visibleOnce(narrow, byText('Check failed toHaveText'), 'the failing check at a narrow width')
  await visibleOnce(narrow, byText('"Another task"'), 'the expected value at a narrow width')
  await visibleOnce(narrow, byText('"Release checklist"'), 'the received value at a narrow width')
  const narrowPicture = proof === undefined ? undefined : await narrow.screenshot(10_000)

  if (proof === undefined || picture === undefined || narrowPicture === undefined) return
  rmSync(proof, { recursive: true, force: true })
  mkdirSync(proof, { recursive: true })
  cpSync(output, join(proof, 'run'), { recursive: true })
  writeFileSync(join(proof, 'report-in-chrome.png'), picture)
  writeFileSync(join(proof, 'report-in-chrome-390.png'), narrowPicture)
  writeFileSync(join(proof, 'collector.jsonl'), watched.written.map(({ text }) => text).join(''))
  assert.ok(existsSync(join(proof, 'run', 'report.html')) && statSync(join(proof, 'report-in-chrome.png')).size > 0)
})

/** Host-only CDP reads and file navigation for this proof. Step clicks still use Retest's real input. */
async function reportBrowser(t: TestContext) {
  const folder = await scratchFolder(t)
  const replies = new Map<number, (message: Record<string, unknown>) => void>()
  const requestedUrls: string[] = []
  const requestOrigins: { url: string; resourceType: string | undefined; initiatorType: string | undefined }[] = []
  let attachment: number | undefined
  let sessionId: string | undefined
  let pipe: Transport | undefined
  let nextId = 1_000_000
  const browser = await launchBrowser({ executablePath: browserPath(), logFile: join(folder, 'browser.log'), headless: true }, undefined, streams => {
    const inner = new PipeTransport(streams)
    pipe = inner
    return {
      listen(handlers) {
        inner.listen({ ...handlers, message(text) {
          const message: unknown = JSON.parse(text)
          if (isRecord(message)) {
            if (message['method'] === 'Network.requestWillBeSent' && isRecord(message['params']) && isRecord(message['params']['request']) && typeof message['params']['request']['url'] === 'string') {
              const params = message['params']
              const url = message['params']['request']['url']
              requestedUrls.push(url)
              requestOrigins.push({ url, resourceType: typeof params['type'] === 'string' ? params['type'] : undefined, initiatorType: isRecord(params['initiator']) && typeof params['initiator']['type'] === 'string' ? params['initiator']['type'] : undefined })
            }
            const id = message['id']
            if (id === attachment && isRecord(message['result']) && typeof message['result']['sessionId'] === 'string') sessionId = message['result']['sessionId']
            if (typeof id === 'number') {
              const reply = replies.get(id)
              if (reply !== undefined) { replies.delete(id); reply(message); return }
            }
          }
          handlers.message(text)
        } })
      },
      send(text) {
        const message: unknown = JSON.parse(text)
        if (isRecord(message) && message['method'] === 'Target.attachToTarget' && typeof message['id'] === 'number') attachment = message['id']
        return inner.send(text)
      },
      close() { inner.close() },
    }
  })
  t.diagnostic(`report file browser ${browser.product} ${browser.version}, pid and process group ${browser.pid}`)
  let opened: OwnedPage | undefined
  t.after(async () => {
    try { await opened?.dispose(2000) } finally { await browser.close(5000) }
    assert.equal(groupExists(browser.pid), false)
  })
  const page = await browser.newPage({}, setupMs)
  opened = page
  async function request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    assert.ok(pipe !== undefined && sessionId !== undefined)
    const id = nextId++
    const transport = pipe
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { replies.delete(id); reject(new Error(`${method} did not answer`)) }, 10_000)
      replies.set(id, message => {
        clearTimeout(timer)
        const result = message['result']
        if (!isRecord(result) || message['error'] !== undefined) reject(new Error(`${method}: ${JSON.stringify(message)}`))
        else resolve(result)
      })
      try { transport.send(JSON.stringify({ id, method, params, sessionId })) }
      catch (error) { clearTimeout(timer); replies.delete(id); reject(error) }
    })
  }
  async function state() {
    const reply = await request('Runtime.evaluate', { expression: `JSON.stringify({ currentTime: document.querySelector('video')?.currentTime ?? null, duration: document.querySelector('video')?.duration ?? null, readyState: document.querySelector('video')?.readyState ?? 0, note: document.querySelector('[data-jump-note]')?.textContent ?? '' })`, returnByValue: true })
    assert.ok(isRecord(reply['result']) && typeof reply['result']['value'] === 'string' && reply['exceptionDetails'] === undefined)
    const read = parse(s.object({ currentTime: s.union([s.number(), s.literal(null)]), duration: s.union([s.number(), s.literal(null)]), readyState: s.number(), note: s.string() }), JSON.parse(reply['result']['value']))
    assert.ok(read.ok, JSON.stringify(reply))
    return read.value
  }
  return { browser, page, request, state, requestedUrls, requestOrigins }
}

// Chrome 154's native media controls use these six inline SVG icons. Pin their entire data URI bytes, not a scheme.
// The report contains none of these URIs, and its CSP excludes author-supplied data images.
const chromeControlImageHashes = new Set([
  '6e9507b2fdf358e1da8766056477b2cb687dd3f854db9e11760d7ec6266aded4',
  '562063826c760bc08a14884bc355c3ffa3da93910ff13b72b80a5ca7fe0a658f',
  '2ae48d82087f99c487f1f2a9a5d91aac363ccc480f83edb41fe705ba7f9cd914',
  '9650c23900a7f176ce836489e0e7e5a78ad52dd1d0cd52668450ef3b0b5051c8',
  '3a206a5ef9360c72ac1f2a8937513ee99c3b744f87166ee53b7dc1210210ae1c',
  '45ed1ccb8617180e8232d68eb867e968f57916988d08f19436db1718bc332278',
])

test('a step click in a recorded real-Chrome run seeks its video from a file report, and incomplete mappings refuse the jump', { timeout: 180_000, skip: recordingSkip }, async t => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) }, recording: { record: true, fps: 10, size: { width: 320, height: 240 } } }`),
    'tests/jump.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'
test('recorded task', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('task-title')).toBeVisible()
  await new Promise(resolve => setTimeout(resolve, 400))
  await test.step('Saved task moment', async () => {
    await page.getByTestId('task-title').fill('Recorded task')
    await page.getByTestId('save-task').click()
    await expect(page.getByTestId('saved-task')).toHaveText('Recorded task')
  })
  await expect(page.getByTestId('saved-task')).toHaveText('Deliberate report failure')
})`,
  })
  const scratch = await scratchFolder(t)
  const output = join(scratch, 'run')
  const retest = await RetestProcess.start(t, { args: ['run', '--reporter', 'html', '--output', output, '--timeouts', budgets({ test: 30_000, cleanup: 15_000 })], cwd: root, tmp: join(scratch, 'tmp'), env: { RETEST_MEDIA_BINARY: process.env['RETEST_TEST_MEDIA_BINARY'] ?? join(repositoryRoot, 'media/target/release/retest-media'), RETEST_FFMPEG: process.env['RETEST_TEST_FFMPEG'] ?? '/opt/homebrew/bin/ffmpeg' } })
  const run = await finishRun({ retest, output })
  assert.equal(run.exit.code, 1, `${run.stdout}\n${run.stderr}`)
  const result = run.result
  const recorded = result?.files.flatMap(file => file.tests)[0]
  const recording = recorded?.recordings?.[0]
  assert.ok(result !== undefined && recorded?.failure?.class === 'check_failed' && recording?.path !== undefined && recording.clock !== undefined)
  assert.equal(recording.status, 'complete', JSON.stringify(recording))
  const step = run.events.find(event => event.type === 'step.started' && event.name === 'Saved task moment')
  assert.ok(step !== undefined)
  const clock: RecordingClock = recording.clock
  assert.equal(clock.shortenedCount, clock.shortened.length)
  const mappedUs = step.elapsedMs * 1000 - clock.videoZeroUs - clock.shortened.filter(gap => gap.captureUs <= step.elapsedMs * 1000).reduce((sum, gap) => sum + gap.shortenedByUs, 0)
  assert.ok(mappedUs > 0 && mappedUs < clock.durationUs, 'the selected step is inside this actual recording')

  const viewed = await reportBrowser(t)
  const watched = collector('report-jump')
  await watched.diagnostics.start([{ app: 'page', page: viewed.page, session: session('report-jump', viewed.browser) }], setupMs)
  const reportUrl = pathToFileURL(join(output, 'report.html')).href
  await viewed.request('Page.navigate', { url: reportUrl })
  await visibleOnce(viewed.page, byRole('heading', 'Failures'), 'the recorded failure report')
  const until = performance.now() + 10_000
  let before = await viewed.state()
  while (before.readyState === 0 && performance.now() < until) { await delay(50); before = await viewed.state() }
  assert.ok(before.duration !== null && before.duration > 0 && before.currentTime === 0, JSON.stringify(before))
  assertOk(await click(viewed.page, byText('Steps', true)))
  assertOk(await click(viewed.page, byRole('button', '▸ Saved task moment', true)))
  const after = await viewed.state()
  const expected = Math.max(0, Math.min(mappedUs / 1_000_000, clock.durationUs / 1_000_000, before.duration))
  assert.ok(after.currentTime !== null && Math.abs(after.currentTime - expected) < 0.00001, JSON.stringify({ before, after, expected, stepMs: step.elapsedMs, clock }))
  assert.equal(after.note, '')
  const videoUrl = pathToFileURL(join(output, recording.path)).href
  assert.ok(viewed.requestedUrls.includes(reportUrl) && viewed.requestedUrls.includes(videoUrl), 'Chrome reads this report and its retained video')
  const proof = process.env['RETEST_REPORT_PROOF_OUT']
  const picture = proof === undefined ? undefined : await viewed.page.screenshot(10_000)

  // An isolated report fixture omits a shortened gap. It cannot move the same playable video.
  const incomplete = structuredClone(result)
  const missingClock = incomplete.files[0]?.tests[0]?.recordings?.[0]?.clock
  assert.ok(missingClock !== undefined)
  missingClock.shortenedCount += 1
  const refused = await buildReport({ directory: output, shown: output, source: 'result.json', result: incomplete, events: run.events, warnings: [] })
  writeFileSync(join(output, 'incomplete-report.html'), refused)
  const incompleteUrl = pathToFileURL(join(output, 'incomplete-report.html')).href
  await viewed.request('Page.navigate', { url: incompleteUrl })
  await visibleOnce(viewed.page, byText('Cannot jump to a step: the recording clock mapping is incomplete.', true), 'the mapping refusal')
  assertOk(await click(viewed.page, byText('Steps', true)))
  assertOk(await click(viewed.page, byRole('button', '▸ Saved task moment', true)))
  const untouched = await viewed.state()
  assert.equal(untouched.currentTime, 0)
  assert.equal(untouched.note, 'Cannot jump to a step: the recording clock mapping is incomplete.')
  const { summaries } = watched.diagnostics.finish('attempt_ended')
  const seen = recordsOf(watched.written)
  const requests = seen.filter(record => record.type === 'network.request')
  if (proof !== undefined) writeFileSync(join(proof, 'jump-request-audit.json'), JSON.stringify({ browser: viewed.browser.version, requests, origins: viewed.requestOrigins, before, after, expected, untouched }, null, 2))
  assert.deepEqual(seen.filter(record => record.type === 'runtime_error' || record.type === 'console' && (record.level === 'error' || record.level === 'warning')), [])
  assert.ok(summaries[0]?.console.state === 'complete' && summaries[0].network.state === 'complete', JSON.stringify(summaries))
  assert.ok(requests.length >= 2, 'the diagnostic collector also observes the file loads')
  for (const request of requests) assert.ok(request.url.startsWith('file:') || request.url.startsWith('data:image/svg+xml,'), `no network fetch: ${request.url}`)
  // The diagnostic collector redacts temporary paths. Check exact file membership on the owned CDP pipe too.
  const allowedUrls = new Set([reportUrl, incompleteUrl, ...resultArtifactReferences(result).filter(reference => reference.kind === 'screenshot' || reference.kind === 'recording').map(reference => pathToFileURL(join(output, reference.path)).href)])
  // The only non-file resources accepted are the exact known browser-owned inline icons. Nothing is fetched for them.
  assert.doesNotMatch(readFileSync(join(output, 'report.html'), 'utf8'), /data:image\//)
  assert.doesNotMatch(refused, /data:image\//)
  for (const origin of viewed.requestOrigins) {
    const nativeIcon = origin.resourceType === 'Image' && origin.url.startsWith('data:image/svg+xml;base64,') && chromeControlImageHashes.has(createHash('sha256').update(origin.url).digest('hex'))
    assert.ok(allowedUrls.has(origin.url) || nativeIcon, `no network fetch, unreferenced file or unknown inline image: ${origin.url}`)
  }
  assert.ok(viewed.requestedUrls.includes(incompleteUrl), 'Chrome also reads the mapping-refusal fixture')
  if (proof !== undefined) {
    const kept = join(proof, 'jump-run')
    mkdirSync(kept, { recursive: true })
    cpSync(output, kept, { recursive: true })
    writeFileSync(join(proof, 'jump-observations.json'), JSON.stringify({ reportUrl, before, after, expected, untouched, clock, stepMs: step.elapsedMs, browser: { product: viewed.browser.product, version: viewed.browser.version, pid: viewed.browser.pid }, requestedUrls: viewed.requestedUrls, requests }, null, 2))
    if (picture !== undefined) writeFileSync(join(proof, 'jump-in-chrome.png'), picture)
    writeFileSync(join(proof, 'jump-collector.jsonl'), watched.written.map(({ text }) => text).join(''))
    t.diagnostic(`recorded jump proof ${kept}`)
  }
})
