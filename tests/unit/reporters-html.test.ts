import type { EventBody } from '../../src/protocol/events.ts'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, test } from 'node:test'
import { contentSecurityPolicy } from '../../src/reporters/html/page.ts'
import { styleSheet } from '../../src/reporters/html/style.ts'
import { jumpScript, jumpScriptHash } from '../../src/reporters/html/jump-script.ts'
import { execution, configFiles, configFolder, configScreenshot, configTest, diagnosticsArtifact, failureScreenshot, judgedScreenshot, mp4, png, recordedRun, recordingPath, recordingRecord, reportOf, writeFolder } from './reporters-html-fixtures.ts'
import { actionFailureRun, failingRun, lostBrowserRun, passingRun, projectFolder, resultOf } from './reporters-fixtures.ts'

const root = projectFolder()
const dataBlockPattern = /<script type="application\/json" id="retest-outcome">([^<]*)<\/script>/g

/** The text a reader sees: tags dropped, the entities the report writes read back. */
function visible(html: string): string {
  return html
    .replace(/<style>[\s\S]*?<\/style>/, '')
    .replace(dataBlockPattern, '')
    .replace(/<script type="application\/json" id="retest-recording-clocks">[^<]*<\/script>/, '')
    .replace(`<script>${jumpScript}</script>`, '')
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&#96;', '`')
    .replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ')
}

/** The section of one test, by its test id, from its opening tag to the next test's. */
function section(html: string, testId: string): string {
  const start = html.indexOf(`data-test-id="${testId.replaceAll('&', '&amp;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')}"`)
  assert.ok(start >= 0, `no section for ${testId}`)
  const next = html.indexOf('data-test-id="', start + 1)
  return html.slice(start, next === -1 ? undefined : next)
}

describe('the HTML report of a failed run', async () => {
  const events = failingRun(root).map((event) => event.type === 'test.started' ? { ...event, execution } : event)
  const folder = writeFolder(root, 'failed', { events, result: resultOf(events), files: { [failureScreenshot]: png(80, 60) } })
  const html = await reportOf(folder)
  const failing = section(html, 'examples/task.retest.ts > saves a task')

  test('states the outcome on the page and in the attributes a reader of the file can trust', async () => {
    assert.match(html, /<main data-run-id="run-1" data-status="failed" data-exit-code="1" data-complete="true" data-source="result.json">/)
    const text = visible(html)
    assert.match(text, /Retest run ✗ Failed Exit 1/)
    assert.match(text, /Tests 1 failed · 1 passed/)
    assert.match(failing, /data-status="failed" data-failure-class="check_failed"/)
  })

  test('puts the failing check, its values and its screenshot before the code and before the list of tests', async () => {
    const text = visible(failing)
    assert.match(text, /Check failed toHaveText/)
    assert.match(text, /Locator getByTestId\('saved-task'\)/)
    assert.match(text, /− Expected "Release checklist" \+ Received "Saving…"/)
    assert.match(text, /Waited 5s for toHaveText, looked 14 times, limit 5s/)
    const check = failing.indexOf('Check failed')
    const picture = failing.indexOf(`<img src="${failureScreenshot}"`)
    const code = failing.indexOf('class="code"')
    assert.ok(check >= 0 && picture > check && code > picture, `check ${check}, picture ${picture}, code ${code}`)
    assert.ok(html.indexOf('id="failures"') < html.indexOf('id="all-tests"'), 'failures come before the list of tests')
  })

  test('shows the screenshot from the run folder by its portable path, at its own size, linked to the file', async () => {
    assert.match(failing, new RegExp(`<a href="${failureScreenshot}"><img src="${failureScreenshot}" alt="Failure screenshot" width="80" height="60"`))
    assert.match(failing, /data-evidence="complete"/)
  })

  test('marks the failing line in the code frame, read from the project', async () => {
    assert.match(visible(failing), /examples\/task\.retest\.ts:7:3/)
    assert.match(failing, /<div class="marked"><span class="line-number">7<\/span> {2}await expect\(page\.getByTestId\(&#39;saved-task&#39;\)\)\.toHaveText\(&#39;Release checklist&#39;\)<\/div>/)
  })

  test('lists every test, the passed one closed under its heading', async () => {
    assert.match(html, /<details class="test" id="test-2" data-test-id="examples\/task\.retest\.ts &gt; shows the count" data-status="passed"/)
    assert.match(visible(html), /✓ Passed examples\/task\.retest\.ts › shows the count/)
  })

  test('is one file that loads nothing from outside it', async () => {
    assert.deepEqual([...html.matchAll(/<script\b[^>]*>/gi)].map(([tag]) => tag), ['<script type="application/json" id="retest-outcome">', '<script type="application/json" id="retest-recording-clocks">', '<script>'])
    const passiveAndFixed = html.replace(dataBlockPattern, '').replace(/<script type="application\/json" id="retest-recording-clocks">[^<]*<\/script>/, '').replace(`<script>${jumpScript}</script>`, '')
    assert.doesNotMatch(passiveAndFixed, /<link\b|<script\b|<iframe\b|<object\b|<embed\b|<base\b|<form\b|@import|url\(/i)
    for (const [, value] of html.matchAll(/\s(?:src|href)="([^"]*)"/g)) {
      assert.ok(value !== undefined && (value.startsWith('#') || /^[A-Za-z0-9_-][A-Za-z0-9._%/-]*$/.test(value)), `a link that leaves the folder: ${value}`)
    }
  })

  test('carries the exact policy that allows only its fixed script and style sheet', async () => {
    const policy = contentSecurityPolicy()
    const hash = createHash('sha256').update(styleSheet).digest('base64')
    const scriptHash = createHash('sha256').update(jumpScript).digest('base64')
    assert.equal(jumpScriptHash, `sha256-${scriptHash}`)
    assert.equal(policy, `default-src 'none'; img-src 'self' file:; media-src 'self' file:; style-src 'sha256-${hash}'; script-src 'sha256-${scriptHash}'; script-src-attr 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`)
    assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${policy.replaceAll("'", '&#39;')}">`))
    assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<style>'), 'the policy comes before what it governs')
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1]
    assert.equal(style, styleSheet, 'the style element holds exactly the hashed sheet')
  })

  test('carries the outcome the page shows as JSON a program can read, the same facts as result.json', async () => {
    const block = [...html.matchAll(dataBlockPattern)].map((match) => match[1] ?? '')
    assert.equal(block.length, 1)
    assert.deepEqual(JSON.parse(block[0] ?? ''), {
      version: 1,
      runId: 'run-1',
      status: 'failed',
      exitCode: 1,
      complete: true,
      source: 'result.json',
      counts: { passed: 1, failed: 1, error: 0, notRun: 0, inconclusive: 0 },
      tests: [
        { testId: 'examples/task.retest.ts > saves a task', name: 'saves a task', status: 'failed', failureClass: 'check_failed', evidence: 'complete' },
        { testId: 'examples/task.retest.ts > shows the count', name: 'shows the count', status: 'passed', evidence: 'none' },
      ],
    })
  })
})

describe('missing evidence is named where it would have been', async () => {
  test('a screenshot the folder does not hold', async () => {
    const events = failingRun(root)
    const html = await reportOf(writeFolder(root, 'no-screenshot', { events, result: resultOf(events) }))
    const failing = section(html, 'examples/task.retest.ts > saves a task')
    assert.match(failing, /<div class="gap" data-reference="artifacts\/saves-a-task-failure\.png" data-refusal="missing">/)
    assert.match(visible(failing), /Failure screenshot cannot be shown \(missing\) artifacts\/saves-a-task-failure\.png/)
    assert.match(failing, /data-evidence="unavailable"/)
    assert.match(visible(failing), /Evidence unavailable\. What is missing: the screenshot cannot be shown: artifacts\/saves-a-task-failure\.png \(missing\)/)
    assert.match(html, /<tr data-reference="artifacts\/saves-a-task-failure\.png" data-refusal="missing">/)
    assert.match(visible(html), /Named by the records, not readable here File Refused as Why Named by artifacts\/saves-a-task-failure\.png missing /)
  })

  test('a screenshot the run could not save', async () => {
    const events = actionFailureRun(root)
    const html = await reportOf(writeFolder(root, 'not-saved', { events, result: resultOf(events) }))
    const failing = section(html, 'examples/task.retest.ts > saves a task')
    assert.match(visible(failing), /Failure screenshot not saved\. The page closed first\./)
    assert.match(visible(failing), /Not actionable click getByTestId\('save-task'\)/)
  })

  test('a file in the folder that is not the image its record names', async () => {
    const events = failingRun(root)
    const html = await reportOf(writeFolder(root, 'not-an-image', { events, result: resultOf(events), files: { [failureScreenshot]: '<svg onload="alert(1)"></svg>' } }))
    assert.match(html, /data-reference="artifacts\/saves-a-task-failure\.png" data-refusal="not_an_image"/)
    assert.match(visible(html), /Failure screenshot cannot be shown \(not an image\) artifacts\/saves-a-task-failure\.png/)
    assert.doesNotMatch(html, /<img/)
  })

  test('a file in the folder that no record names, such as a recording left unfinished', async () => {
    const events = passingRun(root)
    const html = await reportOf(writeFolder(root, 'stray', { events, result: resultOf(events), files: { 'artifacts/recording-1.mp4.partial': 'x' } }))
    assert.match(visible(html), /In the folder, named by no record File Size Note artifacts\/recording-1\.mp4\.partial 1 bytes left unfinished/)
  })
})

describe('a run that did not finish', async () => {
  test('one that left no result.json is rebuilt from its events and says it is incomplete', async () => {
    const events = failingRun(root)
    const cut = events.slice(0, events.findIndex((event) => event.type === 'assertion.failed'))
    const html = await reportOf(writeFolder(root, 'cut', { events: cut }))
    assert.match(html, /data-status="error" data-exit-code="2" data-complete="false" data-source="events\.jsonl"/)
    const text = visible(html)
    assert.match(text, /result\.json is missing, so the run did not finish\. This result is rebuilt from \d+ events and marked incomplete\./)
    assert.match(text, /The run is incomplete: it did not check everything it was asked to check\./)
    assert.match(text, /Run failed: Interrupted The run stopped before it finished\./)
    const started = section(html, 'examples/task.retest.ts > saves a task')
    assert.match(started, /data-status="error" data-failure-class="interrupted"/)
    assert.match(visible(started), /the run stopped before this test finished, so evidence it would have taken later is missing/)
    const neverStarted = section(html, 'examples/task.retest.ts > shows the count')
    assert.match(neverStarted, /data-status="not_run"/)
    assert.match(visible(neverStarted), /No evidence: the test did not run\./)
  })

  test('one whose browser was lost names the test it kept from running', async () => {
    const events = lostBrowserRun(root)
    const html = await reportOf(writeFolder(root, 'lost', { events, result: resultOf(events) }))
    assert.match(html, /data-status="error" data-exit-code="2" data-complete="false"/)
    const notRun = section(html, 'examples/task.retest.ts > shows the count')
    assert.match(visible(notRun), /– Not run .* Browser lost The browser was lost before this test started\./)
    assert.match(visible(section(html, 'examples/task.retest.ts > saves a task')), /Outcome unknown click The browser closed after the click was sent\. Locator getByTestId\('save-task'\) Waited 40 ms for click/)
  })
})

describe('the report of a recorded run', async () => {
  const failingTest = 'examples/task.retest.ts > saves a task'

  test('shows a complete recording as a video from the run folder, under the failing test, and names it in the steps', async () => {
    const events = recordedRun(root)
    const html = await reportOf(writeFolder(root, 'recorded', { events, result: resultOf(events), files: { ...configFiles(), [recordingPath]: mp4() } }))
    const failing = section(html, failingTest)
    assert.match(failing, /<details class="part" open><summary>Recordings<\/summary>/)
    assert.ok(failing.includes(`<video controls preload="metadata" src="${recordingPath}" width="1280" height="720"></video>`), 'the video, by its portable path')
    assert.match(failing, /data-recording-id="rec-1" data-status="complete"/)
    const text = visible(failing)
    assert.match(text, /Recording 1 of web Complete/)
    assert.match(text, /Video h264 in mp4, 1280×720, 10 fps, 42 frames, 4\.2s Frames 50 delivered, 50 sent Session k3v9q0x2mb:web/)
    assert.match(text, /web recording 1 started: chromium, screencast, 1280×720 at 10 fps/)
    assert.match(text, /web recording 1 complete/)
    assert.doesNotMatch(html, /named by no record/, 'the video is named by its record')
  })

  test('names a recording without a video where the video would have been, with the partial file kept and each gap, and never calls the evidence complete', async () => {
    const gaps = [{ code: 'media_process_lost' as const, message: 'The media process ended while this recording ran.', app: 'web', sessionId: 'k3v9q0x2mb:web' }]
    const partialPath = `${recordingPath}.partial`
    const record = recordingRecord({ status: 'unavailable', gaps, partialPath })
    const { path: _path, video: _video, clock: _clock, ...withoutVideo } = record
    const events = recordedRun(root, withoutVideo)
    const html = await reportOf(writeFolder(root, 'recording-lost', { events, result: resultOf(events), files: { ...configFiles(), [partialPath]: 'half a video' } }))
    const failing = section(html, failingTest)
    assert.doesNotMatch(failing, /<video/)
    const text = visible(failing)
    assert.match(text, /Recording 1 of web has no video\. A partial file was kept at artifacts\/k3v9q0x2mb\/web-0123456789abc\/recording-1\.mp4\.partial ?; whether it plays was not checked\./)
    assert.match(text, /Recording 1 of web Unavailable/)
    assert.match(text, /The media process ended while this recording ran\./)
    assert.match(failing, /data-evidence="partial"/)
    assert.match(text, /the recording 1 of web is unavailable: The media process ended while this recording ran\./)
    assert.match(text, /! recording 1 unavailable The media process ended while this recording ran\./)
    assert.doesNotMatch(html, /named by no record/, 'the partial file is named by its record')
  })

  test('says a video retention removed after a pass was removed by rule, not lost', async () => {
    const removal: EventBody = { type: 'artifact.removed', path: recordingPath, kind: 'recording', reason: 'passed_attempt_recording', moment: 'attempt_finished', bytes: 32, testId: configTest, attemptId: 'k3v9q0x2mb', sessionId: 'k3v9q0x2mb:web' }
    const events = recordedRun(root, recordingRecord(), [removal])
    const html = await reportOf(writeFolder(root, 'recording-removed', { events, result: resultOf(events), files: configFiles() }))
    const failing = section(html, failingTest)
    assert.ok(visible(failing).includes(`Recording 1 of web was removed after the test passed. The config keeps recordings of tests that did not pass. ${recordingPath}`))
    assert.doesNotMatch(failing, /<video/)
    assert.doesNotMatch(failing, /the recording 1 of web cannot be shown/, 'a removal by rule is not a loss')
    assert.doesNotMatch(html, new RegExp(`data-reference="${recordingPath}" data-refusal="missing"`))
  })

  test('refuses a file at the recording’s path that is not a video, and counts it lost', async () => {
    const events = recordedRun(root)
    const html = await reportOf(writeFolder(root, 'recording-not-video', { events, result: resultOf(events), files: { ...configFiles(), [recordingPath]: '<svg onload="alert(1)"></svg>' } }))
    const failing = section(html, failingTest)
    assert.doesNotMatch(failing, /<video/)
    assert.ok(failing.includes(`<div class="gap" data-reference="${recordingPath}" data-refusal="not_a_video">`))
    assert.match(visible(failing), /the recording 1 of web cannot be shown: artifacts\/k3v9q0x2mb\/web-0123456789abc\/recording-1\.mp4 \(not a video\)/)
  })
})

describe('the report of a run from a config', async () => {
  const folder = configFolder(root, 'config')
  const html = await reportOf(folder)
  const failing = section(html, 'examples/task.retest.ts > saves a task')
  const text = visible(failing)

  test('names the target, its engine and build, the session and the runtime', async () => {
    assert.match(visible(html), /Browser web=chrome: Chrome 154\.0\.8037\.93 · engine chromium, build 1610480/)
    assert.match(text, /web k3v9q0x2mb:web chromium Chrome 154\.0\.8037\.93 1610480 takes a browser context/)
    assert.match(text, /Ran with Retest 0\.0\.0, Node v24\.12\.0 on darwin-arm64/)
  })

  test('shows the console and network records from the artifact, with what each capture holds', async () => {
    assert.match(failing, new RegExp(`Artifact <a href="${diagnosticsArtifact}">`))
    assert.match(text, /web: console 1 entry, 1 runtime error · network partial \(2 requests, 1 HTTP error, 1 failed, 3 dropped\): the browser stopped reporting requests after a renderer swap/)
    assert.match(text, /saving the task/)
    assert.match(text, /error e1 uncaught Uncaught Error: save failed/)
    assert.match(text, /r1 POST 404 7\.0 ms http:\/\/127\.0\.0\.1:4173\/api\/tasks/)
    assert.match(text, /r2 GET failed 1\.0 ms http:\/\/127\.0\.0\.1:9\/offline net::ERR_CONNECTION_REFUSED/)
    assert.match(text, /The network capture is partial \(3 dropped\)\. the browser stopped reporting requests after a renderer swap/)
  })

  test('shows each AI check with every criterion, its citations, the judge’s words, provider, model and usage', async () => {
    assert.match(text, /✗ AI check task-saved failed, required, judge visual \(anthropic claude-sonnet-5-20260901\)/)
    assert.match(text, /saved The task list shows the new task as saved\. fail e1/)
    assert.match(text, /no-error No error message is visible\. pass e1/)
    assert.match(text, /The judge said "The list shows \\"Saving…\\" and no saved task\."/)
    assert.match(text, /Provider anthropic Model claude-sonnet-5, revision claude-sonnet-5-20260901 Evaluator version 1\.2\.0, instructions version 3/)
    assert.match(text, /Answered in 2\.3s Usage 1200 input tokens, 80 output tokens, 1280 in total/)
    assert.match(failing, new RegExp(`<img src="${judgedScreenshot}" alt="Screenshot e1 of web for AI check task-saved" width="40" height="30"`))
    assert.match(text, /! AI check tidy-layout undecided, advisory/)
    assert.match(text, /The advisory AI check tidy-layout was undecided\./)
  })

  test('shows the replay facts and fingerprints of the attempt', async () => {
    assert.match(text, /Ending assertion failed/)
    assert.match(text, /Bundle sha256 b{64}, 2 modules/)
    assert.match(text, /Configuration sha256 d{64}; web=chrome \(web, chrome, headless\)/)
    assert.match(text, /Requirement version tasks@2, sha256 e{64} Required check task-saved, evaluation, sha256 f{64}/)
    assert.match(text, /Started from web: fresh browser storage, backend data prepared/)
    assert.match(text, /Modules of the bundle \(2\) Module sha256 examples\/task\.retest\.ts a{64} helpers\/tasks\.ts c{64}/)
  })

  test('shows the steps of each app at their times, with the looks and the failing check', async () => {
    assert.match(failing, /<th scope="col">Time<\/th><th scope="col">App<\/th><th scope="col">Step<\/th>/)
    assert.match(text, /web goto → http:\/\/127\.0\.0\.1:4173\//)
    assert.match(text, /web fill getByTestId\('task-title'\), 17 characters/)
    assert.match(text, /✗ toHaveText getByTestId\('saved-task'\) Check failed/)
    assert.match(failing, /<tr class="row-failed" data-elapsed-ms="\d+">/)
    assert.match(failing, new RegExp(`<img src="${configScreenshot}" alt="Failure screenshot of web"`))
    assert.match(text, /artifacts\/config-failure\.png · chromium · session k3v9q0x2mb:web/)
  })
})

for (const reason of ['the field reads back masked', 'the field that received the secret is gone'] as const) {
  test(`HTML names native resume: ${reason}`, async () => {
    const resumed: EventBody = { type: 'capture.resumed', testId: configTest, attemptId: 'k3v9q0x2mb', variant: { web: 'chrome' }, variantKey: 'web=chrome', session: 'web', sessionId: 'k3v9q0x2mb:web', secret: 'password', endedBy: reason === 'the field reads back masked' ? 'field_masked' : 'field_gone', reason, fromUs: 10, untilUs: 20 }
    const events = recordedRun(root, recordingRecord(), [resumed])
    const html = await reportOf(writeFolder(root, `resume-${resumed.endedBy}`, { events, result: resultOf(events), files: { ...configFiles(), [recordingPath]: mp4() } }))
    assert.ok(visible(html).includes(`captures resumed: ${reason}`))
  })
}
