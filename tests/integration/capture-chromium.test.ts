import type { TestContext } from 'node:test'
import type { CaptureStart, CapturedFrame, FrameSource, MediaRecorder, RecordSourceOptions, SourceRecording } from '../../src/media/capture.ts'
import type { RecordIdentity } from '../../src/protocol/identity.ts'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { webRuntimeIdentity } from '../../src/browser/contract.ts'
import { ChromiumPage } from '../../src/browser/page.ts'
import { microsecondsSince, recordSource } from '../../src/media/capture.ts'
import { mediaArguments, MediaProcess } from '../../src/media/client.ts'
import { formatSessionId } from '../../src/protocol/evidence.ts'
import { groupExists, launchGated, openApp, scratchFolder, setupMs } from './browser-harness.ts'

// Chrome's screencast of one page, through the Chromium frame source, into the real media process: a plumbing proof
// that a session's frames reach a recording with their identity and their clock. It claims nothing about the video's
// quality, size or the time anything took. Set RETEST_CAPTURE_PROOF_OUT to keep the video and the process's reply.

const run = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, '../..')
const title = { by: 'testId', value: 'task-title' } as const
const identity: RecordIdentity = { testId: 'tests/integration/capture-chromium.test.ts > records', attemptId: 'capture1', app: 'web', sessionId: formatSessionId('capture1', 'web') }

type Prerequisites = { binary: string; ffmpeg: string; ffprobe: string }

function findOnPath(program: string): string | undefined {
  for (const folder of (process.env['PATH'] ?? '').split(delimiter)) {
    const candidate = join(folder, program)
    if (folder !== '' && existsSync(candidate)) return candidate
  }
  return undefined
}

// The media binary and ffmpeg this test needs. On macOS, where the media process is built and verified, a missing one
// fails the test with what to do; elsewhere the test is skipped by name.
function prerequisites(t: TestContext): Prerequisites | undefined {
  const binary = process.env['RETEST_MEDIA_BINARY'] || join(repositoryRoot, 'media', 'target', 'release', 'retest-media')
  const ffmpeg = process.env['RETEST_FFMPEG'] || findOnPath('ffmpeg')
  const ffprobe = ffmpeg === undefined ? undefined : [join(ffmpeg, '..', 'ffprobe'), findOnPath('ffprobe')].find((path) => path !== undefined && existsSync(path))
  const missing = [
    ...(existsSync(binary) ? [] : [`the media binary at ${binary}; build it with: cargo build --release --manifest-path media/Cargo.toml`]),
    ...(ffmpeg === undefined || !existsSync(ffmpeg) ? ['ffmpeg; install it or set RETEST_FFMPEG'] : []),
    ...(ffprobe === undefined ? ['ffprobe, which comes with ffmpeg'] : []),
  ]
  if (missing.length === 0 && ffmpeg !== undefined && ffprobe !== undefined) return { binary, ffmpeg, ffprobe }
  if (process.platform === 'darwin') assert.fail(`This test needs ${missing.join(', and ')}.`)
  t.skip(`needs ${missing.join(', and ')}`)
  return undefined
}

async function startMedia(t: TestContext, needs: Prerequisites): Promise<MediaProcess> {
  const media = await MediaProcess.start({ executable: needs.binary, args: mediaArguments({ ffmpeg: needs.ffmpeg }), startTimeoutMs: 10_000 })
  t.after(() => media.close(10_000))
  return media
}

/** A source that passes everything through and keeps what it handed over, for the test to read. */
function watched(source: FrameSource): { source: FrameSource; frames: CapturedFrame[] } {
  const frames: CapturedFrame[] = []
  const wrapper: FrameSource = {
    name: source.name,
    identity: source.identity,
    availability: () => source.availability(),
    start: (capture): Promise<CaptureStart> => source.start({ ...capture, deliver: (frame) => (frames.push(frame), capture.deliver(frame)) }),
    stop: (timeoutMs) => source.stop(timeoutMs),
  }
  return { source: wrapper, frames }
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
  assert.equal(tally.delivered, tally.sent + tally.dropped + tally.notSent + refused)
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
  const needs = prerequisites(t)
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
  const needs = prerequisites(t)
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
  const needs = prerequisites(t)
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
