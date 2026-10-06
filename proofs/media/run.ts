// The Rust media proof. Real Chrome screenshots of the task app, taken while a key is typed into it on every
// tick, stream to `retest-media`, which has ffmpeg write a video, while a live view of the recording runs. Every
// decoded video frame is then compared with the one screenshot its timestamp maps to, and with the screenshot the
// ending's frame map names for it; the recording's kept frames come back as the screenshots that were sent, and a
// screenshot becomes a thumbnail. After that: VP8 when libx264 is hidden, an encoder that is not ffmpeg,
// ffmpeg killed mid-recording, a forking wrapper around a stopped ffmpeg, a missed finishing deadline, the media
// process dying, a shutdown with a recording running and another finishing, and a check that nothing started
// here is left.
//
// Run from the repository root: node --conditions=retest-source proofs/media/run.ts
// Artifacts go to RETEST_MEDIA_PROOF_OUT, or a new folder in the temporary directory; the summary names it.

import type { OwnedPage } from '../../src/browser/contract.ts'
import type { Ended, FrameMapEntry, FrameOutcome, FrameSequence, LiveFrame, LiveWatch, MediaExit, Recording, RecordingStart, Thumbnail, WatchEnded } from '../../src/media/client.ts'
import type { RgbImage } from './png.ts'
import type { Box } from './support.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { startTaskApp } from '../../fixtures/task-app/server.ts'
import { launchBrowser } from '../../src/browser/launch.ts'
import { MediaProcess, MediaRecordingLostError, mediaArguments } from '../../src/media/client.ts'
import { encodeRequestHead } from '../../src/media/protocol.ts'
import { isArray } from '../../src/protocol/schema.ts'
import { browserPath } from '../../tests/support/test-browser.ts'
import { decodePng } from './png.ts'
import {
  changingBox,
  childrenOf,
  decodeAllFrames,
  differingPixels,
  ffmpegPath,
  groupMembers,
  lumaInBox,
  mediaBinary,
  proofIdentity,
  parseTimeOutput,
  probeVideo,
  processAlive,
  samePixels,
  waitForFile,
} from './support.ts'

const fps = 30
const tickMs = 1000 / fps
const viewport = { width: 800, height: 600 }
const captureMs = 3000
// A key on every tick, so neighbouring screenshots differ and the frame check can tell them apart.
const typed = 'release checklist ready for beta '.repeat(3)
// Screenshots overlap by at most this many, which keeps one tick's capture from waiting on the last.
const capturesInFlight = 2
// The density the frame check needs to mean anything: most ticks captured, and no pause of more than a few.
const minimumCaptures = 80
const largestGapTicks = 3
// Brightness must move this far, of 255, for a pixel of a decoded frame to count as different from a screenshot.
const pixelThreshold = 48
const answerMs = 5000
const finishMs = 30_000
// The live view watched during the main recording: small, and slower than the capture, so it skips frames.
const watchOptions = { maxWidth: 200, maxHeight: 200, maxFps: 10 }
const thumbnailSide = 200
// Just over one frame interval, so the jitter between real screenshots leaves some stretches to check.
const sequenceMinGapUs = 34_000

/** One screenshot: when it was asked for, and how many typed characters were certain before and possible after. */
type Capture = { index: number; timestampUs: number; png: Uint8Array; typedBefore: number; typedAfter: number }

type LiveRun = { captures: Capture[]; skippedTicks: number; outcomes: Record<FrameOutcome, number>; killedAtMs: number | undefined }

/** One video frame against the screenshot its timestamp maps to, and against every screenshot that differs from it. */
type FrameCheck = {
  videoFrame: number
  atSeconds: number
  expectedCapture: number
  expectedCapturedAtSeconds: number
  typedOnPage: string
  identicalCaptures: number[]
  differingFromExpected: number
  differingFromNearestOther: number
}

const pids = { media: new Set<number>(), encoders: new Set<number>() }

async function main(): Promise<void> {
  const out = process.env['RETEST_MEDIA_PROOF_OUT'] || join(tmpdir(), `retest-media-proof-${process.pid}`)
  await mkdir(out, { recursive: true })
  const binary = mediaBinary()
  const ffmpeg = ffmpegPath()
  const summary: Record<string, unknown> = {
    artifacts: out,
    binary: { path: binary, bytes: statSync(binary).size },
    ffmpeg: { path: ffmpeg, version: firstLine(execFileSync(ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8' })) },
    browser: browserPath(),
  }
  summary['startup'] = await measureStartup(binary, ffmpeg, out)
  report('startup', summary['startup'])

  const app = await startTaskApp()
  const browser = await launchBrowser({ executablePath: browserPath(), logFile: join(out, 'browser.log'), headless: true })
  try {
    const page = await browser.newPage({ baseUrl: app.url, emulation: { viewport, deviceScaleFactor: 1, touch: false, isMobile: false } }, 10_000)
    const opened = await page.execute({ kind: 'goto', url: '/' }, 10_000)
    assert.ok(opened.ok, `the task app did not open: ${JSON.stringify(opened)}`)
    summary['browserVersion'] = `${browser.product} ${browser.version}`

    const live = await recordMain({ page, binary, ffmpeg, out })
    summary['recording'] = live.summary
    report('recording', live.summary)
    const replays = { binary, ffmpeg, out, captures: live.captures }

    summary['vp8'] = await recordVp8({ ...replays, sources: live.sources, box: live.box })
    report('vp8', summary['vp8'])
    summary['notFfmpeg'] = await encoderIsNotFfmpeg({ binary, out })
    report('notFfmpeg', summary['notFfmpeg'])
    summary['killed'] = await encoderKilled({ page, binary, ffmpeg, out })
    report('killed', summary['killed'])
    summary['forkingWrapper'] = await stoppedBehindAForkingWrapper(replays)
    report('forkingWrapper', summary['forkingWrapper'])
    summary['deadline'] = await deadlineMissed(replays)
    report('deadline', summary['deadline'])
    summary['mediaDies'] = await mediaProcessDies(replays)
    report('mediaDies', summary['mediaDies'])
    summary['shutdown'] = await shutdownWhileRecording(replays)
    report('shutdown', summary['shutdown'])
    summary['closeWhileFinishing'] = await closeWhileFinishing({ ...replays, sources: live.sources, box: live.box })
    report('closeWhileFinishing', summary['closeWhileFinishing'])

    await page.dispose(2000)
  } finally {
    await browser.close(5000)
    await app.close()
  }
  const left = [...pids.media, ...pids.encoders].filter(processAlive)
  const encoderGroups = [...pids.encoders].flatMap(groupMembers)
  summary['leftBehind'] = { mediaProcesses: pids.media.size, encoders: pids.encoders.size, stillRunning: left, encoderGroupMembers: encoderGroups, browserGroup: groupMembers(browser.pid) }
  report('leftBehind', summary['leftBehind'])
  assert.deepEqual(left, [], 'a media process or encoder outlived the proof')
  assert.deepEqual(encoderGroups, [], 'a process of an encoder group outlived the proof')
  assert.deepEqual(groupMembers(browser.pid), [], 'the browser outlived the proof')
  await writeFile(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`\nAll media proof checks passed. Summary: ${join(out, 'summary.json')}`)
}

// Two times per start: to the greeting, and to the first `started`, which waits for the background probe of
// ffmpeg.
async function measureStartup(binary: string, ffmpeg: string, out: string) {
  const greeted: number[] = []
  const firstStarted: number[] = []
  for (let run = 0; run < 10; run += 1) {
    const begin = performance.now()
    const media = await startMedia(binary, ffmpeg)
    greeted.push(performance.now() - begin)
    const recording = started(await media.record({ recordingId: `startup-${run}`, identity: proofIdentity(`startup-${run}`), ...viewport, fps, output: join(out, `startup-${run}`), deadlineMs: 1000 }, answerMs))
    firstStarted.push(performance.now() - begin)
    pids.encoders.add(recording.started.encoderPid)
    await closeClean(media)
    assert.equal((await recording.ended).status, 'stopped')
  }
  return { runs: greeted.length, toGreeting: spread(greeted), toFirstStarted: spread(firstStarted) }
}

type MainOptions = { page: OwnedPage; binary: string; ffmpeg: string; out: string }

async function recordMain({ page, binary, ffmpeg, out }: MainOptions) {
  const mediaTime = join(out, 'media-time.txt')
  const encoderTime = join(out, 'ffmpeg-time.txt')
  // `/usr/bin/time` forks ffmpeg, so this run also has the encoder behind a forking wrapper.
  const timedFfmpeg = script(join(out, 'ffmpeg-timed.sh'), `exec /usr/bin/time -l -a -o '${encoderTime}' '${ffmpeg}' "$@"\n`)
  const media = await MediaProcess.start({ executable: '/usr/bin/time', args: ['-l', '-o', mediaTime, binary, '--ffmpeg', timedFfmpeg], startTimeoutMs: 5000 })
  const mediaPid = childrenOf(media.pid)[0]
  assert.ok(mediaPid !== undefined, 'the timed media process has no child')
  pids.media.add(media.pid).add(mediaPid)
  const sampler = sampleResident(mediaPid)
  const recording = started(await media.record({ recordingId: 'main', identity: proofIdentity('main'), ...viewport, fps, output: join(out, 'recording'), deadlineMs: 10_000 }, answerMs))
  pids.encoders.add(recording.started.encoderPid)
  const framesPath = recording.started.framesPath
  assert.ok(framesPath !== undefined, 'the main recording keeps its frames')
  const liveFrames: LiveFrame[] = []
  const view = await recording.watch(watchOptions, (frame) => liveFrames.push(frame), answerMs)
  const capture = await captureWhileTyping(page, recording, { durationMs: captureMs })
  const viewEnded = await view.stop(answerMs)
  const ended = await recording.finish(finishMs, captureMs * 1000)
  const mediaCpu = cpuSeconds(mediaPid)
  const peakResidentBytes = sampler.stop()
  const firstUs = capture.captures[0]?.timestampUs ?? 0
  const lastUs = capture.captures.at(-1)?.timestampUs ?? 0
  const sequence = await recording.frames({ fromUs: firstUs, toUs: lastUs, maxFrames: 64, maxWidth: viewport.width, maxHeight: viewport.height, format: 'png', maxBytes: 48 * 1024 * 1024, minGapUs: sequenceMinGapUs }, finishMs)
  const smallSequence = await recording.frames({ fromUs: firstUs, toUs: lastUs, maxFrames: 4, maxWidth: thumbnailSide, maxHeight: thumbnailSide, format: 'png' }, finishMs)
  const thumbnail = await media.thumbnail({ output: join(out, 'thumbnail'), maxWidth: thumbnailSide, maxHeight: thumbnailSide, format: 'png' }, { format: 'png', bytes: capture.captures[0]?.png ?? new Uint8Array() }, answerMs)
  const exit = await closeClean(media)
  assert.equal(ended.status, 'ok', JSON.stringify(ended))
  assert.equal(existsSync(framesPath), false, 'the shutdown removed the kept frames')
  const density = checkDensity(capture.captures)
  assert.equal(capture.outcomes.dropped + capture.outcomes.closed + capture.outcomes.not_sent, 0, JSON.stringify(capture.outcomes))
  const { frames } = ended
  // The live view ran the whole time; these show it cost the recording nothing.
  assert.equal(frames.received, capture.captures.length)
  assert.equal(frames.shown + frames.superseded, capture.captures.length, 'every screenshot reached the video or was replaced on its own tick')
  assert.equal(frames.dropped + frames.outOfOrder + frames.outOfRange + frames.duplicate + frames.undecodable + frames.unprocessed, 0, JSON.stringify(frames))
  assert.deepEqual(ended.evidence, { status: 'complete', reasons: [] }, JSON.stringify(ended.encoder))
  assert.equal(ended.firstTimestampUs, capture.captures[0]?.timestampUs)
  assert.deepEqual(ended.identity, proofIdentity('main'))
  assert.equal(ended.frameMapEntries, capture.captures.length)
  assert.equal(ended.frameMapOmitted, 0)
  for (const each of capture.captures) {
    const mapped = ended.frameMap.find((entry) => entry.frameId === `capture-${each.index}`)
    assert.ok(mapped !== undefined, `capture ${each.index} is missing from the frame map`)
    assert.equal(mapped.captureUs, each.timestampUs)
    assert.ok(mapped.fate === 'shown' || mapped.fate === 'superseded', JSON.stringify(mapped))
  }
  const liveView = checkLiveView(liveFrames, viewEnded, view, capture.captures)
  const path = ended.path ?? ''
  const probe = await probeVideo(path)
  assert.deepEqual([probe.codec, probe.width, probe.height, probe.pixelFormat], ['h264', viewport.width, viewport.height, 'yuv420p'])
  // These two hold by construction: the end timestamp sets how many frames are written. They show the container
  // is whole and holds what was written, not that the capture kept pace.
  assert.equal(probe.framesDecoded, ended.outputFrames, 'ffprobe decodes as many frames as were written')
  assert.ok(Math.abs(probe.durationSeconds - ended.durationUs / 1_000_000) <= 0.05, `duration ${probe.durationSeconds} s`)
  const inputFolder = join(out, 'input')
  await mkdir(inputFolder, { recursive: true })
  for (const each of capture.captures) await writeFile(join(inputFolder, `${each.index}.png`), each.png)
  await writeFile(join(inputFolder, 'captures.json'), `${JSON.stringify(capture.captures.map(({ png, ...each }) => ({ ...each, byteLength: png.byteLength })), null, 2)}\n`)
  const sources = capture.captures.map((each) => decodePng(each.png))
  const box = changingBox(sources)
  assert.ok(box !== undefined, 'the page never changed while it was recorded')
  const order = await checkEveryFrame({ video: path, captures: capture.captures, sources, box, out, prefix: 'h264', frameMap: ended.frameMap })
  assert.equal(order.framesChecked, probe.framesDecoded, 'the whole decode checks every frame counted by ffprobe')
  const keptFrames = checkSequence({ sequence, small: smallSequence, captures: capture.captures, frameMap: ended.frameMap })
  const thumbnailCheck = await checkThumbnail(thumbnail, sources[0], out)
  const timed = parseTimeOutput(await readFile(mediaTime, 'utf8'))
  const encoderRuns = parseTimeOutput(await readFile(encoderTime, 'utf8'))
  const frameHeaderBytes = encodeRequestHead({ type: 'frame', recordingId: 'main', frameId: 'capture-89', timestampUs: captureMs * 1000, format: 'png' }, 1).byteLength
  const pngBytes = ended.bytesReceived / frames.received
  const summary = {
    video: { path, bytes: statSync(path).size, probe },
    ended,
    exit,
    captures: { count: capture.captures.length, skippedTicks: capture.skippedTicks, typedCharacters: capture.captures.at(-1)?.typedAfter ?? 0, outcomes: capture.outcomes, ...density },
    changingBox: box,
    frameOrder: order,
    liveView,
    keptFrames,
    thumbnail: thumbnailCheck,
    bytesPerFrame: {
      pngFromChrome: round(pngBytes),
      devtoolsBase64Derived: Math.ceil(pngBytes / 3) * 4,
      frameHeaderToMedia: frameHeaderBytes,
      rawToEncoderPerOutputFrame: ended.bytesToEncoder / ended.outputFrames,
      rawToEncoderPerSecond: Math.round(ended.bytesToEncoder / (ended.durationUs / 1_000_000)),
    },
    clientTraffic: media.traffic,
    resources: {
      mediaProcessCpuSecondsByPs: mediaCpu,
      mediaProcessPeakResidentBytesSampled: peakResidentBytes,
      timeOfMediaProcessIncludingChildren: timed.at(-1),
      timeOfEncoderRuns: encoderRuns,
      encoderRunForThisRecording: encoderRuns.at(-1),
    },
  }
  return { summary, captures: capture.captures, sources, box }
}

// The live view watched the whole capture: each frame it sent is one of the screenshots, newest first by sequence,
// fitted to the view and at most its rate; the totals it ended with agree with what arrived.
function checkLiveView(frames: LiveFrame[], ended: WatchEnded, view: LiveWatch, captures: Capture[]) {
  assert.deepEqual(view.options, { type: 'watching', recordingId: 'main', ...watchOptions })
  assert.equal(ended.reason, 'unwatched', JSON.stringify(ended))
  assert.ok(frames.length > 0, 'the live view sent no frame')
  assert.equal(ended.sent, frames.length, JSON.stringify(ended))
  assert.ok(frames.length <= Math.ceil((captureMs * watchOptions.maxFps) / 1000) + 1, `${frames.length} live frames in ${captureMs} ms at ${watchOptions.maxFps} a second`)
  const byId = new Map(captures.map((each) => [`capture-${each.index}`, each]))
  let lastSequence = 0
  let lastCaptureUs = -1
  for (const frame of frames) {
    const source = byId.get(frame.frameId)
    assert.ok(source !== undefined, `live frame ${frame.frameId} is no screenshot that was sent`)
    assert.equal(frame.captureUs, source.timestampUs)
    assert.ok(frame.sequence > lastSequence && frame.captureUs > lastCaptureUs, `live frames out of order at ${frame.frameId}`)
    lastSequence = frame.sequence
    lastCaptureUs = frame.captureUs
    assert.deepEqual([frame.width, frame.height, frame.format], [200, 150, 'jpeg'])
    assert.deepEqual([...frame.bytes.subarray(0, 2)], [0xff, 0xd8], 'a live frame is a JPEG')
    assert.equal(frame.bytes.byteLength, frame.byteLength)
  }
  return { sent: ended.sent, skipped: ended.skipped, dropped: ended.dropped, failed: ended.failed, firstFrame: frames[0]?.frameId, lastFrame: frames.at(-1)?.frameId }
}

type SequenceCheck = { sequence: FrameSequence; small: FrameSequence; captures: Capture[]; frameMap: FrameMapEntry[] }

// The ended recording's kept frames over the whole capture. At full size in their own format they come back as the
// very bytes that were sent; the frames left out by the cap are counted; the stretches without a kept frame are
// exactly the pauses between screenshots of at least the asked gap, worked out here from the timestamps.
function checkSequence({ sequence, small, captures, frameMap }: SequenceCheck) {
  const firstUs = captures[0]?.timestampUs ?? 0
  const lastUs = captures.at(-1)?.timestampUs ?? 0
  assert.deepEqual([sequence.status, sequence.recording, sequence.inInterval, sequence.available], ['ok', 'ended', captures.length, captures.length], JSON.stringify({ ...sequence, frames: sequence.frames.length }))
  const returned = Math.min(64, captures.length)
  assert.equal(sequence.frames.length, returned)
  assert.deepEqual(sequence.omitted, { byCount: captures.length - returned, byBytes: 0, undecodable: 0 })
  const byId = new Map(captures.map((each) => [`capture-${each.index}`, each]))
  const fates = new Map(frameMap.map((entry) => [entry.frameId, entry.fate]))
  let lastCaptureUs = -1
  for (const frame of sequence.frames) {
    const source = byId.get(frame.frameId)
    assert.ok(source !== undefined, `kept frame ${frame.frameId} is no screenshot that was sent`)
    assert.ok(frame.captureUs > lastCaptureUs, `kept frames repeat or go back at ${frame.frameId}`)
    lastCaptureUs = frame.captureUs
    assert.equal(frame.captureUs, source.timestampUs)
    assert.equal(frame.fate, fates.get(frame.frameId), `kept frame ${frame.frameId} and the frame map disagree`)
    assert.deepEqual([frame.width, frame.height, frame.sourceWidth, frame.sourceHeight, frame.format], [viewport.width, viewport.height, viewport.width, viewport.height, 'png'])
    assert.equal(Buffer.compare(Buffer.from(frame.bytes), Buffer.from(source.png)), 0, `kept frame ${frame.frameId} is not the screenshot that was sent`)
  }
  const bounds = [firstUs, ...captures.map((each) => each.timestampUs), lastUs]
  const expected = bounds.slice(1).flatMap((toUs, index) => {
    const fromUs = bounds[index] ?? 0
    return toUs - fromUs >= sequenceMinGapUs ? [[fromUs, toUs]] : []
  })
  assert.equal(sequence.stretchesFound, expected.length)
  assert.deepEqual(sequence.stretches.map((stretch) => [stretch.fromUs, stretch.toUs]), expected.slice(0, 64))
  for (const stretch of sequence.stretches) {
    assert.deepEqual(stretch.lost, { dropped: 0, undecodable: 0, outOfOrder: 0, outOfRange: 0, duplicate: 0, queued: 0, notStored: 0 })
    assert.deepEqual(stretch.captureGaps, [])
  }
  assert.equal(small.frames.length, 4)
  for (const frame of small.frames) {
    const image = decodePng(frame.bytes)
    assert.deepEqual([image.width, image.height, frame.width, frame.height], [200, 150, 200, 150], `fitted frame ${frame.frameId}`)
  }
  return { returned: sequence.frames.length, omittedByCount: sequence.omitted.byCount, payloadBytes: sequence.frames.reduce((total, frame) => total + frame.byteLength, 0), stretches: sequence.stretchesFound, fittedFrames: small.frames.map((frame) => frame.frameId) }
}

// A thumbnail of the first screenshot: fitted within its size with the proportions kept, a whole PNG on disk, and
// as bright on average as the screenshot it shrinks.
async function checkThumbnail(thumbnail: Thumbnail, source: RgbImage | undefined, out: string) {
  assert.equal(thumbnail.status, 'ok', JSON.stringify(thumbnail))
  assert.ok(source !== undefined)
  assert.deepEqual([thumbnail.path, thumbnail.width, thumbnail.height, thumbnail.sourceWidth, thumbnail.sourceHeight], [join(out, 'thumbnail.png'), 200, 150, viewport.width, viewport.height])
  const written = decodePng(await readFile(join(out, 'thumbnail.png')))
  assert.deepEqual([written.width, written.height], [200, 150])
  const whole = (image: RgbImage) => lumaInBox(image, { left: 0, top: 0, width: image.width, height: image.height })
  const mean = (values: Float32Array) => values.reduce((total, value) => total + value, 0) / values.length
  const [shrunk, original] = [mean(whole(written)), mean(whole(source))]
  assert.ok(Math.abs(shrunk - original) < 2, `the thumbnail's mean brightness ${round(shrunk)} is not the screenshot's ${round(original)}`)
  return { path: thumbnail.path, bytes: thumbnail.byteLength, meanBrightness: round(shrunk), screenshotMeanBrightness: round(original), placedBy: thumbnail.placedBy }
}

// The screenshots must cover the recording closely enough for the frame check to test timing: enough of them, the
// first at time zero, and no pause between two longer than `largestGapTicks`.
function checkDensity(captures: Capture[]) {
  const gapsMs = captures.slice(1).map((capture, index) => (capture.timestampUs - (captures[index]?.timestampUs ?? 0)) / 1000)
  const largestGapMs = Math.max(...gapsMs)
  const lastAtMs = ((captures.at(-1)?.timestampUs ?? 0) - (captures[0]?.timestampUs ?? 0)) / 1000
  assert.ok(captures.length >= minimumCaptures, `only ${captures.length} screenshots in ${captureMs} ms; the check needs ${minimumCaptures}`)
  assert.ok(largestGapMs <= largestGapTicks * tickMs, `screenshots paused for ${round(largestGapMs)} ms, more than ${largestGapTicks} ticks`)
  assert.ok(lastAtMs >= captureMs - largestGapTicks * tickMs, `the last screenshot came at ${round(lastAtMs)} ms`)
  return { largestGapMs: round(largestGapMs), lastCapturedAtMs: round(lastAtMs) }
}

async function captureWhileTyping(page: OwnedPage, recording: Recording, options: { durationMs: number; killEncoderAtMs?: number }): Promise<LiveRun> {
  const origin = performance.now()
  const microseconds = () => Math.round((performance.now() - origin) * 1000)
  const counts = { completed: 0, dispatched: 0 }
  const typing = typeOnEveryTick(page, origin, options.durationMs, counts)
  const captures: Capture[] = []
  const outcomes: Record<FrameOutcome, number> = { sent: 0, dropped: 0, closed: 0, not_sent: 0 }
  let inFlight = 0
  let skippedTicks = 0
  let killedAtMs: number | undefined
  let sending = Promise.resolve()
  for (let tick = 0; tick * tickMs < options.durationMs; tick += 1) {
    await sleepUntil(origin + tick * tickMs)
    if (options.killEncoderAtMs !== undefined && killedAtMs === undefined && performance.now() - origin >= options.killEncoderAtMs) {
      process.kill(recording.started.encoderPid, 'SIGKILL')
      killedAtMs = performance.now() - origin
    }
    if (inFlight >= capturesInFlight) {
      skippedTicks += 1
      continue
    }
    inFlight += 1
    const capture: Capture = { index: captures.length, timestampUs: microseconds(), png: new Uint8Array(), typedBefore: counts.completed, typedAfter: 0 }
    captures.push(capture)
    const shot = page.screenshot(2000).then((png) => {
      capture.png = png
      capture.typedAfter = counts.dispatched
      inFlight -= 1
    })
    // Frames go to the process in the order they were asked for, so their timestamps never go backwards.
    sending = sending.then(async () => {
      await shot
      outcomes[recording.frame({ frameId: `capture-${capture.index}`, timestampUs: capture.timestampUs, format: 'png', bytes: capture.png })] += 1
    })
  }
  await sending
  await typing
  return { captures, skippedTicks, outcomes, killedAtMs }
}

async function typeOnEveryTick(page: OwnedPage, origin: number, durationMs: number, counts: { completed: number; dispatched: number }): Promise<void> {
  for (const [index, character] of [...typed].entries()) {
    await sleepUntil(origin + tickMs * (index + 0.5))
    if (performance.now() - origin >= durationMs) return
    counts.dispatched += 1
    const key = character === ' ' ? 'Space' : character
    const result = await page.execute({ kind: 'press', locator: { by: 'testId', value: 'task-title' }, key }, 2000)
    assert.ok(result.ok, `typing ${key} failed: ${JSON.stringify(result)}`)
    counts.completed += 1
  }
}

type FrameCheckOptions = { video: string; captures: Capture[]; sources: RgbImage[]; box: Box; out: string; prefix: string; frameMap?: FrameMapEntry[] }

// Decodes every frame of the video and compares each with the one screenshot its timestamp maps to: the last
// whose tick is at or before the frame. That screenshot must match it better than every screenshot that differs
// from it in any pixel; screenshots with the same pixels cannot be told apart by any comparison, and are listed.
// With the ending's frame map, the screenshot it names for each video frame must be that very screenshot.
async function checkEveryFrame({ video, captures, sources, box, out, prefix, frameMap }: FrameCheckOptions) {
  const origin = captures[0]?.timestampUs ?? 0
  const tickOf = (capture: Capture) => Math.round(((capture.timestampUs - origin) * fps) / 1_000_000)
  const frames = await decodeAllFrames(video, join(out, `${prefix}-frames`), prefix)
  const mapped = frameMap === undefined ? undefined : videoFramesOf(frameMap)
  if (mapped !== undefined) assert.equal(mapped.size, frames.length, `the frame map places ${mapped.size} video frames; the video has ${frames.length}`)
  const lumas = sources.map((source) => lumaInBox(source, box))
  const identical = sources.map((source, index) => sources.flatMap((other, at) => (at === index || samePixels(source, other, box) ? [at] : [])))
  const checks: FrameCheck[] = frames.map((frame, videoFrame) => {
    const expected = captures.filter((capture) => tickOf(capture) <= videoFrame).at(-1)
    assert.ok(expected !== undefined, `no screenshot comes before video frame ${videoFrame}`)
    const luma = lumaInBox(frame, box)
    const differences = lumas.map((source) => differingPixels(luma, source, pixelThreshold))
    const twins = identical[expected.index] ?? [expected.index]
    const others = differences.filter((_, at) => !twins.includes(at))
    const check: FrameCheck = {
      videoFrame,
      atSeconds: videoFrame / fps,
      expectedCapture: expected.index,
      expectedCapturedAtSeconds: (expected.timestampUs - origin) / 1_000_000,
      typedOnPage: typedRange(expected),
      identicalCaptures: twins,
      differingFromExpected: differences[expected.index] ?? Infinity,
      differingFromNearestOther: others.length === 0 ? Infinity : Math.min(...others),
    }
    assert.ok(check.differingFromNearestOther > check.differingFromExpected, `video frame ${videoFrame} is not screenshot ${expected.index}: ${JSON.stringify(check)}`)
    if (mapped !== undefined) assert.equal(mapped.get(videoFrame), expected.index, `the frame map puts screenshot ${String(mapped.get(videoFrame))} at video frame ${videoFrame}; its timestamp puts screenshot ${expected.index} there`)
    return check
  })
  for (const check of checks.filter((_, index) => [0, 15, 45, 75, checks.length - 1].includes(index))) {
    const capture = captures[check.expectedCapture]
    if (capture !== undefined) await writeFile(join(out, `${prefix}-screenshot-${capture.index}.png`), capture.png)
  }
  const ticksSpanned = (indices: number[]) => {
    const ticks = indices.flatMap((index) => {
      const capture = captures[index]
      return capture === undefined ? [] : [tickOf(capture)]
    })
    return ticks.length === 0 ? 0 : Math.max(...ticks) - Math.min(...ticks)
  }
  return {
    framesChecked: checks.length,
    framesCheckedAgainstTheFrameMap: mapped === undefined ? 0 : checks.length,
    framesWhoseScreenshotHasIdenticalOthers: checks.filter((check) => check.identicalCaptures.length > 1).length,
    largestIdenticalSpanTicks: Math.max(...checks.map((check) => ticksSpanned(check.identicalCaptures))),
    largestDifferenceFromExpected: Math.max(...checks.map((check) => check.differingFromExpected)),
    smallestDifferenceFromAnother: Math.min(...checks.map((check) => check.differingFromNearestOther)),
    samples: checks.filter((_, index) => [0, 15, 45, 75, checks.length - 1].includes(index)),
  }
}

// Which screenshot each video frame shows, as the frame map says: every shown entry covers `outputFrames` frames
// from the frame at `videoUs`. No video frame may be claimed twice.
function videoFramesOf(frameMap: FrameMapEntry[]): Map<number, number> {
  const placed = new Map<number, number>()
  for (const entry of frameMap) {
    if (entry.fate !== 'shown') continue
    const index = Number(/^capture-(\d+)$/.exec(entry.frameId)?.[1])
    assert.ok(Number.isSafeInteger(index), `the frame map names ${entry.frameId}`)
    assert.ok(entry.videoUs !== undefined && entry.outputFrames !== undefined && entry.outputFrames > 0, JSON.stringify(entry))
    const first = Math.round((entry.videoUs * fps) / 1_000_000)
    for (let offset = 0; offset < entry.outputFrames; offset += 1) {
      assert.equal(placed.has(first + offset), false, `the frame map claims video frame ${first + offset} twice`)
      placed.set(first + offset, index)
    }
  }
  return placed
}

type ReplayOptions = { binary: string; ffmpeg: string; out: string; captures: Capture[] }

async function recordVp8({ binary, ffmpeg, out, captures, sources, box }: ReplayOptions & { sources: RgbImage[]; box: Box }) {
  // The real ffmpeg, with libx264 left out of its encoder list, so the process takes its VP8 route.
  const withoutX264 = script(
    join(out, 'ffmpeg-without-libx264.sh'),
    `if [ "$1" = "-encoders" ]; then\n  listing=$('${ffmpeg}' "$@") || exit $?\n  printf '%s\\n' "$listing" | grep -v ' libx264'\n  exit 0\nfi\nexec '${ffmpeg}' "$@"\n`,
  )
  const media = await startMedia(binary, withoutX264)
  const recording = started(await media.record({ recordingId: 'vp8', identity: proofIdentity('vp8'), ...viewport, fps, output: join(out, 'recording-vp8'), deadlineMs: 20_000, queueFrames: 128 }, answerMs))
  pids.encoders.add(recording.started.encoderPid)
  const ended = await replay(recording, captures)
  const exit = await closeClean(media)
  assert.equal(ended.status, 'ok', JSON.stringify(ended))
  assert.deepEqual([recording.started.codec, recording.started.container, recording.started.encoder], ['vp8', 'webm', 'libvpx'])
  const path = ended.path ?? ''
  const probe = await probeVideo(path)
  assert.equal(probe.codec, 'vp8')
  assert.match(probe.formatName, /webm/)
  assert.equal(probe.framesDecoded, ended.outputFrames)
  assert.ok(Math.abs(probe.durationSeconds - ended.durationUs / 1_000_000) <= 0.05, `duration ${probe.durationSeconds} s`)
  const order = await checkEveryFrame({ video: path, captures, sources, box, out, prefix: 'vp8', frameMap: ended.frameMap })
  assert.equal(order.framesChecked, probe.framesDecoded, 'the whole decode checks every frame counted by ffprobe')
  return { started: recording.started, ended, exit, video: { path, bytes: statSync(path).size, probe }, frameOrder: order, note: 'replayed screenshots of the live run, timestamps unchanged' }
}

async function encoderIsNotFfmpeg({ binary, out }: { binary: string; out: string }) {
  const media = await startMedia(binary, '/bin/cat')
  const start: RecordingStart = await media.record({ recordingId: 'cat', identity: proofIdentity('cat'), ...viewport, fps, output: join(out, 'recording-cat'), deadlineMs: 5000 }, answerMs)
  const exit = await closeClean(media)
  assert.ok(start.kind === 'ended', JSON.stringify(start))
  assert.equal(start.ended.status, 'encoder_failed')
  assert.equal(start.ended.encoder?.exitCode, 1)
  assert.equal(existsSync(join(out, 'recording-cat.mp4')), false)
  return { encoder: '/bin/cat', ended: start.ended, exit }
}

async function encoderKilled({ page, binary, ffmpeg, out }: MainOptions) {
  const media = await startMedia(binary, ffmpeg)
  const recording = started(await media.record({ recordingId: 'killed', identity: proofIdentity('killed'), ...viewport, fps, output: join(out, 'recording-killed'), deadlineMs: 10_000 }, answerMs))
  pids.encoders.add(recording.started.encoderPid)
  const origin = performance.now()
  let endedAtMs: number | undefined
  void recording.ended.then(() => {
    endedAtMs = performance.now() - origin
  })
  const live = await captureWhileTyping(page, recording, { durationMs: 1500, killEncoderAtMs: 750 })
  const ended = await recording.ended
  const finished = await recording.finish(finishMs)
  const exit = await closeClean(media)
  assert.equal(ended.status, 'encoder_failed', JSON.stringify(ended))
  assert.equal(ended.encoder?.signal, 9)
  assert.equal(finished, ended, 'finishing an ended recording returns its one ending')
  assert.ok(endedAtMs !== undefined && live.killedAtMs !== undefined && endedAtMs < 1500, 'the ending came before the capture stopped')
  assert.ok(live.outcomes.closed > 0, 'frames after the ending were refused')
  assert.equal(existsSync(join(out, 'recording-killed.mp4')), false)
  assert.equal(existsSync(join(out, 'recording-killed.mp4.partial')), false)
  return { ended, exit, killedAtMs: round(live.killedAtMs ?? 0), endedAtMs: round(endedAtMs ?? 0), outcomes: live.outcomes, encoderAlive: processAlive(recording.started.encoderPid) }
}

// ffmpeg behind a shell wrapper that forks it, stopped as a wedged encoder would be, then a finish with a short
// deadline: the deadline must end the recording and leave no process of the encoder's group.
async function stoppedBehindAForkingWrapper({ binary, ffmpeg, out, captures }: ReplayOptions) {
  const wrapper = script(join(out, 'ffmpeg-forking.sh'), `'${ffmpeg}' "$@"\n`)
  const media = await startMedia(binary, wrapper)
  const recording = started(await media.record({ recordingId: 'forking', identity: proofIdentity('forking'), ...viewport, fps, output: join(out, 'recording-forking'), deadlineMs: 300, queueFrames: 128 }, answerMs))
  const group = recording.started.encoderPid
  pids.encoders.add(group)
  for (const capture of captures) recording.frame({ frameId: `capture-${capture.index}`, timestampUs: capture.timestampUs, format: 'png', bytes: capture.png })
  const real = await waitForChild(group)
  pids.encoders.add(real)
  process.kill(real, 'SIGSTOP')
  const finishedAt = performance.now()
  const ended = await recording.finish(finishMs, captureMs * 1000)
  const endedAfterMs = performance.now() - finishedAt
  const groupAfterEnd = groupMembers(group)
  const exit = await closeClean(media)
  assert.equal(ended.status, 'deadline_exceeded', JSON.stringify(ended))
  assert.ok(endedAfterMs < 2000, `ended ${round(endedAfterMs)} ms after the finish`)
  assert.deepEqual(groupAfterEnd, [], 'a process of the encoder group outlived the deadline')
  assert.equal(processAlive(real), false, 'the stopped ffmpeg outlived the deadline')
  return { wrapperPid: group, ffmpegPid: real, endedAfterMs: round(endedAfterMs), ended, groupAfterEnd, exit }
}

async function deadlineMissed({ binary, ffmpeg, out, captures }: ReplayOptions) {
  const media = await startMedia(binary, ffmpeg)
  const recording = started(await media.record({ recordingId: 'deadline', identity: proofIdentity('deadline'), ...viewport, fps, output: join(out, 'recording-deadline'), deadlineMs: 50, queueFrames: 128 }, answerMs))
  pids.encoders.add(recording.started.encoderPid)
  // Make the missed deadline certain even when this input can encode within the bound on a quiet host.
  process.kill(recording.started.encoderPid, 'SIGSTOP')
  const ended = await replay(recording, captures)
  const exit = await closeClean(media)
  assert.equal(ended.status, 'deadline_exceeded', JSON.stringify(ended))
  assert.equal(ended.encoder?.signal, 9)
  assert.equal(existsSync(join(out, 'recording-deadline.mp4')), false)
  assert.equal(existsSync(join(out, 'recording-deadline.mp4.partial')), false)
  return { deadlineMs: 50, ended, exit, encoderAlive: processAlive(recording.started.encoderPid) }
}

// The media process killed on its own mid-recording, as a crash would. Its encoder sees its input end; the client
// gives it a moment, stops its group, and names the file it left.
async function mediaProcessDies({ binary, ffmpeg, out, captures }: ReplayOptions) {
  const media = await startMedia(binary, ffmpeg)
  const recording = started(await media.record({ recordingId: 'orphaned', identity: proofIdentity('orphaned'), ...viewport, fps, output: join(out, 'recording-orphaned'), deadlineMs: 10_000, queueFrames: 128 }, answerMs))
  pids.encoders.add(recording.started.encoderPid)
  for (const capture of captures) recording.frame({ frameId: `capture-${capture.index}`, timestampUs: capture.timestampUs, format: 'png', bytes: capture.png })
  // The encoder writing its container header is the sign that frames reached it.
  await waitForFile(`${recording.started.path}.partial`, 5000)
  process.kill(media.pid, 'SIGKILL')
  const lost = await recording.ended.then(
    (ended) => assert.fail(`the recording was given an ending the process never sent: ${JSON.stringify(ended)}`),
    (error: unknown) => error,
  )
  assert.ok(lost instanceof MediaRecordingLostError, String(lost))
  const exit = await media.exited
  assert.equal(exit.signal, 'SIGKILL')
  assert.equal(lost.partialPath, `${recording.started.path}.partial`)
  const partial = lost.partialPath === undefined ? undefined : await probeVideo(lost.partialPath)
  assert.ok(partial !== undefined)
  assert.ok(partial.framesDecoded > 0 && partial.durationSeconds > 0, 'the partial contains playable video frames')
  assert.ok(Math.abs(partial.durationSeconds - partial.framesDecoded / fps) <= 0.05, 'the partial duration matches its decoded frame count')
  const decoded = lost.partialPath === undefined ? [] : await decodeAllFrames(lost.partialPath, join(out, 'orphaned-frames'), 'orphaned')
  assert.equal(decoded.length, partial?.framesDecoded)
  // A crash may cut off the tail. Every decoded frame still has to match its capture.
  const sources = captures.map((capture) => decodePng(capture.png))
  const box = changingBox(sources)
  assert.ok(box !== undefined)
  const frameOrder = await checkEveryFrame({ video: lost.partialPath ?? '', captures, sources, box, out, prefix: 'orphaned-order' })
  assert.equal(frameOrder.framesChecked, partial.framesDecoded, 'the whole decode checks every frame counted by ffprobe')
  assert.equal(processAlive(recording.started.encoderPid), false)
  assert.deepEqual(groupMembers(recording.started.encoderPid), [])
  return { message: lost.message, partialPath: lost.partialPath, partial, frameOrder, exit }
}

async function shutdownWhileRecording({ binary, ffmpeg, out, captures }: ReplayOptions) {
  const media = await startMedia(binary, ffmpeg)
  const recording = started(await media.record({ recordingId: 'running', identity: proofIdentity('running'), ...viewport, fps, output: join(out, 'recording-running'), deadlineMs: 10_000 }, answerMs))
  pids.encoders.add(recording.started.encoderPid)
  for (const capture of captures.slice(0, 10)) recording.frame({ frameId: `capture-${capture.index}`, timestampUs: capture.timestampUs, format: 'png', bytes: capture.png })
  const exit = await closeClean(media)
  const ended = await recording.ended
  assert.equal(ended.status, 'stopped', JSON.stringify(ended))
  assert.equal(exit.bye?.stopped, 1)
  assert.equal(existsSync(join(out, 'recording-running.mp4')), false)
  return { ended, exit, encoderAlive: processAlive(recording.started.encoderPid) }
}

// A finish, then a close without waiting for the ending: the finishing recording completes within its deadline.
async function closeWhileFinishing({ binary, ffmpeg, out, captures, sources, box }: ReplayOptions & { sources: RgbImage[]; box: Box }) {
  const media = await startMedia(binary, ffmpeg)
  const recording = started(await media.record({ recordingId: 'finishing', identity: proofIdentity('finishing'), ...viewport, fps, output: join(out, 'recording-finishing'), deadlineMs: 10_000, queueFrames: 128 }, answerMs))
  pids.encoders.add(recording.started.encoderPid)
  for (const capture of captures) recording.frame({ frameId: `capture-${capture.index}`, timestampUs: capture.timestampUs, format: 'png', bytes: capture.png })
  const finishing = recording.finish(finishMs, captureMs * 1000)
  const exit = await closeClean(media)
  const ended = await finishing
  assert.equal(ended.status, 'ok', JSON.stringify(ended))
  assert.equal(exit.bye?.stopped, 0)
  const probe = await probeVideo(ended.path ?? '')
  assert.equal(probe.framesDecoded, ended.outputFrames)
  assert.ok(Math.abs(probe.durationSeconds - ended.durationUs / 1_000_000) <= 0.05, `duration ${probe.durationSeconds} s`)
  const frameOrder = await checkEveryFrame({ video: ended.path ?? '', captures, sources, box, out, prefix: 'finishing', frameMap: ended.frameMap })
  assert.equal(frameOrder.framesChecked, probe.framesDecoded, 'the whole decode checks every frame counted by ffprobe')
  return { ended, exit, probe, frameOrder }
}

async function replay(recording: Recording, captures: Capture[]): Promise<Ended> {
  for (const capture of captures) {
    const outcome = recording.frame({ frameId: `capture-${capture.index}`, timestampUs: capture.timestampUs, format: 'png', bytes: capture.png })
    assert.equal(outcome, 'sent')
  }
  return recording.finish(finishMs, captureMs * 1000)
}

async function startMedia(binary: string, ffmpeg: string): Promise<MediaProcess> {
  const media = await MediaProcess.start({ executable: binary, args: mediaArguments({ ffmpeg }), startTimeoutMs: 5000 })
  pids.media.add(media.pid)
  return media
}

// Shuts the process down and checks it went on its own, leaving nothing in its process group.
async function closeClean(media: MediaProcess): Promise<MediaExit> {
  const exit = await media.close(15_000)
  assert.deepEqual([exit.code, exit.signal, exit.forced], [0, null, false], `the media process did not exit cleanly: ${JSON.stringify(exit)}`)
  assert.deepEqual(groupMembers(media.pid), [], 'the media process left processes in its group')
  return exit
}

async function waitForChild(pid: number): Promise<number> {
  const end = performance.now() + 5000
  for (;;) {
    const child = childrenOf(pid)[0]
    if (child !== undefined) return child
    assert.ok(performance.now() < end, `process ${pid} started no child`)
    await delay(10)
  }
}

function started(start: RecordingStart): Recording {
  assert.ok(start.kind === 'started', `the recording did not start: ${JSON.stringify(start)}`)
  return start.recording
}

function script(path: string, body: string): string {
  writeFileSync(path, `#!/bin/sh\n${body}`)
  chmodSync(path, 0o755)
  return path
}

// Samples a process's resident memory every 50 ms until stopped, and returns the largest sample in bytes.
function sampleResident(pid: number): { stop: () => number } {
  let peak = 0
  const timer = setInterval(() => {
    try {
      const kilobytes = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim())
      peak = Math.max(peak, kilobytes * 1024)
    } catch {
      // The process ended between samples; the peak so far stands.
    }
  }, 50)
  return {
    stop: () => {
      clearInterval(timer)
      return peak
    },
  }
}

// The process's own processor time, user and system, as ps reports it: `0:01.23` or `1:02:03.45`.
function cpuSeconds(pid: number): number {
  const time = execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  return time.split(':').reduce((total, part) => total * 60 + Number(part), 0)
}

function spread(values: number[]) {
  const sorted = [...values].sort((one, other) => one - other)
  return { firstMs: round(values[0] ?? 0), minMs: round(sorted[0] ?? 0), medianMs: round(sorted[Math.floor(sorted.length / 2)] ?? 0), maxMs: round(sorted.at(-1) ?? 0) }
}

function typedRange(capture: Capture): string {
  const before = JSON.stringify(typed.slice(0, capture.typedBefore).slice(-12))
  if (capture.typedAfter === capture.typedBefore) return `${capture.typedBefore} keys, ending ${before}`
  return `${capture.typedBefore} to ${capture.typedAfter} keys, ending ${before} or ${JSON.stringify(typed.slice(0, capture.typedAfter).slice(-12))}`
}

async function sleepUntil(at: number): Promise<void> {
  const wait = at - performance.now()
  if (wait > 0) await delay(wait)
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? ''
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

function report(name: string, value: unknown): void {
  console.log(`\n== ${name}\n${JSON.stringify(value, (key, item: unknown) => (key === 'stderr' && isArray(item) ? item.slice(-5) : key === 'identicalCaptures' && isArray(item) && item.length > 4 ? `${item.length} captures` : item), 2)}`)
}

await main()
