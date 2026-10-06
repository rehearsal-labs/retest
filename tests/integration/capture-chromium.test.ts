import type { TestContext } from 'node:test'
import type { CaptureStats, CapturedFrame, MediaRecorder, RecordSourceOptions, SourceRecording } from '../../src/media/capture.ts'
import type { RecordIdentity } from '../../src/protocol/identity.ts'
import type { MediaPrerequisites } from './capture-proof.ts'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { webRuntimeIdentity } from '../../src/browser/contract.ts'
import { ChromiumPage } from '../../src/browser/page.ts'
import { CaptureSuspension, microsecondsSince, recordSource, ScreenshotLoopSource } from '../../src/media/capture.ts'
import { mediaArguments, MediaProcess } from '../../src/media/client.ts'
import { formatSessionId } from '../../src/protocol/evidence.ts'
import { groupExists, launchGated, openApp, scratchFolder, setupMs } from './browser-harness.ts'
import { decodeFrames, decodeVideo, even, imageSize, mediaPrerequisites, pausesMs, shownFrameIds, spread, tickerFrames, tickerServer, videoAgainstTicks, watched } from './capture-proof.ts'

// Chrome's screencast of one page, through the Chromium frame source, into the real media process: a plumbing proof
// that a session's frames reach a recording with their identity and their clock. It claims nothing about the video's
// quality, size or the time anything took. Set RETEST_CAPTURE_PROOF_OUT to keep the video and the process's reply.

const run = promisify(execFile)
const title = { by: 'testId', value: 'task-title' } as const
const identity: RecordIdentity = { testId: 'tests/integration/capture-chromium.test.ts > records', attemptId: 'capture1', app: 'web', sessionId: formatSessionId('capture1', 'web') }

async function startMedia(t: TestContext, needs: MediaPrerequisites): Promise<MediaProcess> {
  const media = await MediaProcess.start({ executable: needs.binary, args: mediaArguments({ ffmpeg: needs.ffmpeg }), startTimeoutMs: 10_000 })
  t.after(() => media.close(10_000))
  return media
}

/** How many screencast frames Chrome has sent so far, counted on the wire. */
function frameCounter(): { watch: (message: Record<string, unknown>) => void; count: () => number } {
  let frames = 0
  return {
    watch: (message) => {
      if (message['method'] === 'Page.screencastFrame') frames += 1
    },
    count: () => frames,
  }
}

async function typeFor(page: ChromiumPage, milliseconds: number): Promise<number> {
  const end = performance.now() + milliseconds
  let typed = 0
  while (performance.now() < end) {
    typed += 1
    const result = await page.execute({ kind: 'fill', locator: title, value: `Release checklist ${typed}` }, 2000)
    assert.ok(result.ok, `fill ${typed} ${JSON.stringify(result)}`)
    await delay(100)
  }
  return typed
}

// A Chrome page on the task app, named as the session `identity` is, as the runner names each page it opens, or left
// unnamed.
async function chromePage(t: TestContext, watch: (message: Record<string, unknown>) => void, named: RecordIdentity | 'unnamed' = identity): Promise<{ page: ChromiumPage; pid: number }> {
  const app = await openApp(t)
  const browser = await launchGated(t, { watch })
  const opened = await browser.newPage({ baseUrl: app.url }, setupMs)
  assert.ok(opened instanceof ChromiumPage, 'a Chromium page')
  const page = opened
  t.after(() => page.dispose(2000))
  if (named !== 'unnamed') {
    const owner = { runId: 'run-1', testId: named.testId, attemptId: named.attemptId, app: named.app }
    page.identify({ sessionId: named.sessionId, owner, runtime: webRuntimeIdentity(browser, 'chromium') })
  }
  const went = await page.execute({ kind: 'goto', url: '/' }, 10_000)
  assert.ok(went.ok, JSON.stringify(went))
  return { page, pid: browser.pid }
}

function recordOptions(folder: string, name: string, signal: AbortSignal): RecordSourceOptions {
  return {
    recordingId: name,
    runId: 'run-1',
    output: join(folder, name),
    width: 800,
    height: 600,
    fps: 10,
    deadlineMs: 20_000,
    clock: microsecondsSince(performance.now()),
    startTimeoutMs: 10_000,
    stopTimeoutMs: 5000,
    finishTimeoutMs: 30_000,
    signal,
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

async function goneWithin(pid: number, timeoutMs: number): Promise<boolean> {
  const end = performance.now() + timeoutMs
  while (processAlive(pid)) {
    if (performance.now() > end) return false
    await delay(20)
  }
  return true
}

// The process's own counts add up, as its protocol promises: `received` is every count but `resized`.
function assertCountsAddUp(report: SourceRecording): void {
  const frames = report.ended?.frames
  assert.ok(frames !== undefined)
  const { received, resized: _resized, ...rest } = frames
  assert.equal(Object.values(rest).reduce((sum, value) => sum + value, 0), received, JSON.stringify(frames))
  const tally = report.frames
  const refused = Object.values(tally.refused).reduce((sum, value) => sum + value, 0)
  assert.equal(tally.delivered, tally.sent + tally.dropped + tally.notSent + tally.withheld + refused)
}

function keep(report: SourceRecording, frames: readonly CapturedFrame[]): void {
  const folder = process.env['RETEST_CAPTURE_PROOF_OUT']
  if (!folder || report.ended?.path === undefined) return
  mkdirSync(folder, { recursive: true })
  copyFileSync(report.ended.path, join(folder, `chrome-screencast.${report.ended.path.split('.').at(-1) ?? 'mp4'}`))
  const handedOver = frames.map((frame) => ({ timestampUs: frame.timestampUs, format: frame.format, bytes: frame.bytes.byteLength, identity: frame.identity }))
  writeFileSync(join(folder, 'chrome-screencast-report.json'), `${JSON.stringify({ report, handedOver }, null, 2)}\n`)
}

test('a few seconds of a Chrome page reach the media process through the frame source, each frame with its identity', async (t) => {
  const needs = mediaPrerequisites(t)
  if (needs === undefined) return
  const folder = await scratchFolder(t)
  const counter = frameCounter()
  const { page } = await chromePage(t, counter.watch)
  const media = await startMedia(t, needs)
  const { source, frames } = watched(page.frameSource(identity))
  assert.deepEqual(source.availability(), { available: true, mode: 'screencast' })
  const stop = new AbortController()
  const recording = recordSource(source, media, recordOptions(folder, 'chrome', stop.signal))
  const typed = await typeFor(page, 3000)
  stop.abort()
  const report = await recording
  t.diagnostic(`typed ${typed} times; ${JSON.stringify({ status: report.status, stoppedBy: report.stoppedBy, frames: report.frames, capture: report.capture, ended: report.ended })}`)
  keep(report, frames)

  assert.equal(report.status, 'ended')
  assert.equal(report.stoppedBy, 'signal')
  assert.equal(report.ended?.status, 'ok', report.ended?.message)
  assert.equal(report.capture?.mode, 'screencast')
  assert.deepEqual(report.identity, identity)
  assert.ok(report.frames.sent >= 2, `frames were sent: ${JSON.stringify(report.frames)}`)
  assert.equal(report.ended?.frames.received, report.frames.sent, 'every frame sent reached the process')
  assert.equal(report.capture?.delivered, report.frames.delivered)
  assertCountsAddUp(report)
  const counted = (report.capture?.delivered ?? 0) + (report.capture?.superseded ?? 0) + (report.capture?.dropped ?? 0)
  assert.equal(counter.count(), counted, 'every frame Chrome sent was counted once, delivered, superseded or dropped')
  // The process's own reply says what it wrote: the size it was asked for, frames in the video and a duration.
  assert.deepEqual([report.started?.width, report.started?.height, report.started?.fps], [800, 600, 10])
  assert.ok((report.ended?.outputFrames ?? 0) > 0 && (report.ended?.durationUs ?? 0) > 0, `the reply names a video: ${report.ended?.outputFrames} frames, ${report.ended?.durationUs} µs`)

  assert.equal(frames.length, report.frames.delivered)
  for (const frame of frames) {
    assert.deepEqual(frame.identity, identity)
    assert.equal(frame.format, 'jpeg')
    assert.deepEqual([...frame.bytes.subarray(0, 2)], [0xff, 0xd8], 'the frame is Chrome’s JPEG as it came')
  }
  const stamps = frames.map((frame) => frame.timestampUs)
  assert.deepEqual(stamps, [...stamps].sort((left, right) => left - right), 'timestamps never go back')

  const path = report.ended?.path
  assert.ok(path !== undefined && existsSync(path) && statSync(path).size > 0)
  const probe = await run(needs.ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,nb_read_frames', '-of', 'json', path])
  const stream: unknown = JSON.parse(probe.stdout)
  assert.match(JSON.stringify(stream), /"codec_name":"(h264|vp8)"/)
  assert.doesNotMatch(JSON.stringify(stream), /"nb_read_frames":"0"/)

  const sentBeforeClose = counter.count()
  const closed = await media.close(10_000)
  assert.deepEqual([closed.forced, closed.bye?.stopped], [false, 0])
  assert.equal(groupExists(report.started?.encoderPid ?? 0), false, 'the encoder is gone')
  assert.ok(await goneWithin(media.pid, 2000), 'the media process is gone')
  await typeFor(page, 500)
  assert.equal(counter.count(), sentBeforeClose, 'Chrome sends no more frames once capture stopped, though the page paints again')
  assert.deepEqual(readdirSync(folder).filter((name) => name.endsWith('.partial')), [])
})

test('a media process closed mid-capture stops the capture and leaves no process, no partial file and no screencast', async (t) => {
  const needs = mediaPrerequisites(t)
  if (needs === undefined) return
  const folder = await scratchFolder(t)
  const counter = frameCounter()
  const { page } = await chromePage(t, counter.watch)
  const media = await startMedia(t, needs)
  const recording = recordSource(page.frameSource(identity), media, recordOptions(folder, 'closed', new AbortController().signal))
  await typeFor(page, 1000)
  const closed = await media.close(10_000)
  const report = await recording
  t.diagnostic(JSON.stringify({ status: report.status, stoppedBy: report.stoppedBy, reason: report.reason, frames: report.frames, ended: report.ended?.status }))
  assert.equal(closed.forced, false)
  assert.equal(report.stoppedBy, 'recording', 'the recording ended first, and capture stopped with it')
  assert.equal(report.status, 'ended')
  assert.equal(report.ended?.status, 'stopped', report.ended?.message)
  assert.equal(report.ended?.path, undefined, 'no video is claimed')
  assert.ok(report.frames.delivered > 0)
  assertCountsAddUp(report)
  assert.equal(groupExists(report.started?.encoderPid ?? 0), false, 'the encoder is gone')
  assert.ok(await goneWithin(media.pid, 2000), 'the media process is gone')
  const sent = counter.count()
  await typeFor(page, 500)
  assert.equal(counter.count(), sent, 'Chrome sends no frames once capture stopped, though the page still paints')
  assert.deepEqual(readdirSync(folder), [], 'nothing was left in the output folder')
})

test('a page closed mid-capture ends the capture, and the frames that came are recorded', async (t) => {
  const needs = mediaPrerequisites(t)
  if (needs === undefined) return
  const folder = await scratchFolder(t)
  const counter = frameCounter()
  const { page } = await chromePage(t, counter.watch)
  const media = await startMedia(t, needs)
  const recording = recordSource(page.frameSource(identity), media, recordOptions(folder, 'page-closed', new AbortController().signal))
  await typeFor(page, 1000)
  await page.dispose(5000)
  const report = await recording
  t.diagnostic(JSON.stringify({ status: report.status, stoppedBy: report.stoppedBy, capture: report.capture, frames: report.frames, ended: report.ended?.status }))
  assert.equal(report.stoppedBy, 'source')
  assert.match(report.capture?.endedEarly ?? '', /^The page's session ended: /)
  assert.equal(report.ended?.status, 'ok', report.ended?.message)
  assertCountsAddUp(report)
  const closed = await media.close(10_000)
  assert.equal(closed.forced, false)
  assert.equal(groupExists(report.started?.encoderPid ?? 0), false)
  assert.ok(await goneWithin(media.pid, 2000))
  assert.deepEqual(readdirSync(folder).filter((name) => name.endsWith('.partial')), [])
})

test('a page records only as the session it was named, and a page not yet named records nothing', async (t) => {
  const neverStarted: MediaRecorder = {
    record: () => assert.fail('no recording is started for a page that may not be recorded'),
  }
  const other: RecordIdentity = { ...identity, app: 'phone', sessionId: formatSessionId(identity.attemptId, 'phone') }
  const { page } = await chromePage(t, () => undefined)
  const asOther = page.frameSource(other)
  assert.deepEqual(asOther.availability(), {
    available: false,
    reason: `This page is session ${identity.sessionId} of ${JSON.stringify(identity.testId)}, not ${other.sessionId} of ${JSON.stringify(identity.testId)}, so Retest records nothing of it as that session.`,
  })
  const refused = await recordSource(asOther, neverStarted, recordOptions(await scratchFolder(t), 'other', new AbortController().signal))
  assert.equal(refused.status, 'unavailable')
  assert.deepEqual(refused.identity, identity, 'the report names the session the page is')
  assert.throws(() => page.identify({ sessionId: other.sessionId, owner: { runId: 'run-1', testId: other.testId, attemptId: other.attemptId, app: other.app }, runtime: { kind: 'web', engine: 'chromium', product: 'Chrome', version: '0', executablePath: '/x', processIds: [1] } }), /This page is session capture1:web/)
  const { page: unnamed } = await chromePage(t, () => undefined, 'unnamed')
  assert.deepEqual(unnamed.frameSource(identity).availability(), { available: false, reason: `Retest has not named the session this page is, so it records nothing as ${identity.sessionId}.` })
})

// Where the ticker proofs keep their videos and reports when RETEST_CAPTURE_PROOF_OUT names a folder.
function keepTicker(name: string, report: SourceRecording, details: object): void {
  const folder = process.env['RETEST_CAPTURE_PROOF_OUT']
  if (!folder) return
  mkdirSync(folder, { recursive: true })
  if (report.ended?.path !== undefined) copyFileSync(report.ended.path, join(folder, `${name}.${report.ended.path.split('.').at(-1) ?? 'mp4'}`))
  writeFileSync(join(folder, `${name}-report.json`), `${JSON.stringify({ report, ...details }, null, 2)}\n`)
}

// A page that changes on every tick, named as the session `identity` is, and the size it captures at.
async function tickerPage(t: TestContext, needs: MediaPrerequisites, watch: (message: Record<string, unknown>) => void = () => undefined): Promise<{ page: ChromiumPage; size: { width: number; height: number } }> {
  const ticker = await tickerServer(t)
  const { page } = await chromePage(t, watch)
  const went = await page.execute({ kind: 'goto', url: ticker }, 10_000)
  assert.ok(went.ok, JSON.stringify(went))
  const size = await imageSize(needs.ffprobe, await page.screenshot(5000), 'png')
  return { page, size }
}

test('Chrome’s screencast of a page that changes on every tick: no frame shows a moment after it arrived, and each video frame shows the frame its time maps to', async (t) => {
  const needs = mediaPrerequisites(t)
  if (needs === undefined) return
  const folder = await scratchFolder(t)
  const counter = frameCounter()
  const { page, size } = await tickerPage(t, needs, counter.watch)
  const media = await startMedia(t, needs)
  const startedAt = performance.now()
  const clockZeroEpochMs = performance.timeOrigin + startedAt
  const stop = new AbortController()
  const { source, frames } = watched(page.frameSource(identity))
  const options: RecordSourceOptions = { ...recordOptions(folder, 'ticker', stop.signal), clock: microsecondsSince(startedAt), width: even(size.width), height: even(size.height), fps: 30 }
  const recording = recordSource(source, media, options)
  await delay(3000)
  stop.abort()
  const report = await recording
  const pictures = await decodeFrames(needs, frames)
  const ticker = tickerFrames(frames, pictures, clockZeroEpochMs)
  const ended = report.ended
  assert.ok(ended !== undefined, report.reason)
  assert.equal(ended.status, 'ok', ended.message)
  const video = await decodeVideo(needs, ended.path ?? '')
  const ids = shownFrameIds(ended, video.frames.length, options.fps)
  const against = videoAgainstTicks(video.frames, ids, ticker.ticks)
  const measured = { size, capture: report.capture, frames: report.frames, gaps: report.gaps, wire: counter.count(), distinctTicks: ticker.distinct, lagMs: spread(ticker.lagsMs), pausesMs: spread(pausesMs(frames)), video: { frames: video.frames.length, fps: video.fps, codec: video.codec, checked: against.checked, unmapped: against.unmapped.length }, evidence: ended.evidence, counts: ended.frames }
  t.diagnostic(JSON.stringify(measured))
  keepTicker('chrome-ticker', report, { measured, ticks: ticker.ticks, lagsMs: ticker.lagsMs })

  assert.equal(report.status, 'ended')
  assert.deepEqual(ticker.unreadable, [], 'every frame Chrome sent shows a tick that can be read')
  assert.deepEqual(ticker.future, [], 'no frame shows a moment after it reached Retest')
  assert.deepEqual(ticker.backwards, [], 'frames never go back in time')
  assert.ok(ticker.distinct >= 2, 'the frames show the page changing')
  assert.equal(ended.frames.received, report.frames.sent, 'every frame sent reached the process')
  assert.equal(ended.frameMapEntries, report.frames.sent, 'the frame map lists every frame')
  assert.deepEqual(ended.frameMap.map((entry) => entry.frameId), frames.map((_, index) => String(index + 1)), 'the frame map names the frames by their place in the order they were handed over')
  assert.deepEqual(against.mismatched, [], 'every video frame shows the tick of the frame its time maps to')
  assert.ok(against.checked > 0 && against.checked === video.frames.length - against.unmapped.length)
  assert.deepEqual(against.unmapped, [], 'the frame map accounts for every video frame')
  assert.deepEqual(ended.identity, { runId: 'run-1', ...identityWithoutLook() }, 'the recording carries the run and the session')
})

test('measured beside it: a Page.captureScreenshot loop on the same page is slower and each frame is a single capture, so the screencast stays Chrome’s mode', async (t) => {
  const needs = mediaPrerequisites(t)
  if (needs === undefined) return
  const { page } = await tickerPage(t, needs)
  const startedAt = performance.now()
  const clockZeroEpochMs = performance.timeOrigin + startedAt
  const clock = microsecondsSince(startedAt)
  const loop = new ScreenshotLoopSource({
    name: 'chromium',
    identity,
    unavailable: () => undefined,
    grab: async (timeoutMs) => ({ ok: true, format: 'png', bytes: await page.screenshot(timeoutMs) }),
    grabTimeoutMs: 5000,
  })
  const frames: CapturedFrame[] = []
  const started = await loop.start({ fps: 30, clock, deliver: (frame) => frames.push(frame), ended: () => undefined, timeoutMs: 5000 })
  assert.deepEqual(started, { ok: true, mode: 'screenshot-loop' })
  await delay(3000)
  const stats: CaptureStats = await loop.stop(5000)
  const ticker = tickerFrames(frames, await decodeFrames(needs, frames), clockZeroEpochMs)
  t.diagnostic(JSON.stringify({ stats, distinctTicks: ticker.distinct, lagMs: spread(ticker.lagsMs), pausesMs: spread(pausesMs(frames)) }))
  assert.deepEqual([ticker.unreadable, ticker.future, ticker.backwards], [[], [], []])
  assert.equal(stats.delivered, frames.length)
})

function identityWithoutLook(): RecordIdentity {
  const { observationId: _look, ...rest } = identity
  return rest
}


test('Chrome stops its real screencast during withholding and resumes with a new read window', async (t) => {
  const counter = frameCounter()
  const { page } = await chromePage(t, counter.watch)
  const source = page.frameSource(identity)
  const suspension = new CaptureSuspension()
  const frames: CapturedFrame[] = []
  const gaps: { reason: string }[] = []
  const clock = microsecondsSince(performance.now())
  const ended: string[] = []
  assert.equal((await source.start({ fps: 30, clock, timeoutMs: 5000, deliver: frame => frames.push(frame), ended: reason => ended.push(reason),
    gap: gap => gaps.push(gap), withheld: () => suspension.suspended, onWithholdingChange: listener => suspension.listen(listener) })).ok, true)
  t.after(() => source.stop(5000))
  await typeFor(page, 300)
  suspension.suspend()
  await delay(100) // Reconcile a frame already dispatched when the stream was stopped.
  const heldWire = counter.count()
  const heldDelivery = frames.length
  await typeFor(page, 350)
  assert.equal(counter.count(), heldWire, 'changing paints cannot produce new remote screencast frames while stopped')
  assert.equal(frames.length, heldDelivery)
  const resumedUs = clock()
  suspension.resume()
  await typeFor(page, 350)
  assert.ok(frames.length > heldDelivery, 'the real stream resumes')
  assert.ok(frames.slice(heldDelivery).every(frame => (frame.earliestUs ?? 0) >= resumedUs))
  assert.ok(gaps.some(gap => gap.reason === 'pixels_withheld'))
  assert.deepEqual(ended, [])
  const stats = await source.stop(5000)
  assert.deepEqual(stats.problems, [])
})
