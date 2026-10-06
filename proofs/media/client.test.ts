import type { ChildProcess } from 'node:child_process'
import type { TestContext } from 'node:test'
import type { Frame, LiveFrame, MediaProcessOptions, Recording, StartRecording } from '../../src/media/client.ts'
import type { RgbImage } from './png.ts'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { MediaProcess, MediaProcessError, MediaRecordingLostError, MediaRequestError, MediaVersionError, mediaArguments } from '../../src/media/client.ts'
import { MAX_FRAME_BYTES, MAX_FRAME_ID_CHARACTERS, MAX_ID_CHARACTERS, MAX_PATH_BYTES } from '../../src/media/protocol.ts'
import { decodePng, encodePng, solidImage } from './png.ts'
import { decodeAllFrames, decodeFrame, ffmpegPath, frameUntilPartial, groupAlive, mediaBinary, probeVideo, processAlive, proofIdentity, waitForFile, waitUntilGone } from './support.ts'

// Both throw at once, naming the missing prerequisite, so the file fails loudly rather than skipping.
const binary = mediaBinary()
const ffmpeg = ffmpegPath()
const stubbornPath = join(import.meta.dirname, 'stubborn-process.ts')
const childPath = join(import.meta.dirname, 'recording-child.ts')

const red = [220, 30, 30] as const
const green = [30, 200, 60] as const
const blue = [40, 60, 220] as const

async function scratch(t: TestContext): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'retest-media-client-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  return folder
}

async function startMedia(t: TestContext, options: Partial<MediaProcessOptions> = {}): Promise<MediaProcess> {
  const media = await MediaProcess.start({ executable: binary, args: mediaArguments({ ffmpeg }), startTimeoutMs: 5000, ...options })
  t.after(async () => {
    await media.close(5000)
    assert.equal(processAlive(media.pid), false, `media process ${media.pid} outlived its test`)
  })
  return media
}

async function startStandIn(t: TestContext, mode: string, protocol = '2'): Promise<MediaProcess> {
  const media = await MediaProcess.start({ executable: process.execPath, args: [stubbornPath, protocol, mode], startTimeoutMs: 5000 })
  t.after(async () => {
    await media.close(300)
    assert.equal(processAlive(media.pid), false, `stand-in ${media.pid} outlived its test`)
  })
  return media
}

// A start with the proofs' identity and the usual small size; `changes` override any of it.
function startOf(recordingId: string, output: string, changes: Partial<StartRecording> = {}): StartRecording {
  return { recordingId, identity: proofIdentity(recordingId), width: 64, height: 48, fps: 10, output, deadlineMs: 10_000, ...changes }
}

async function record(media: MediaProcess, output: string, changes: Partial<StartRecording> = {}): Promise<Recording> {
  const start = await media.record(startOf('r', output, changes), 5000)
  assert.equal(start.kind, 'started', JSON.stringify(start))
  assert.ok(start.kind === 'started')
  return start.recording
}

let frameNumber = 0

function frame(colour: readonly [number, number, number], timestampUs: number): Frame {
  frameNumber += 1
  return { frameId: `c${frameNumber}`, timestampUs, format: 'png', bytes: encodePng(solidImage(64, 48, colour)) }
}

// A JPEG of one colour, made by ffmpeg from a PNG, as a screencast would deliver it.
function jpegOf(width: number, height: number, colour: readonly [number, number, number]): Buffer {
  return execFileSync(ffmpeg, ['-v', 'error', '-f', 'png_pipe', '-i', 'pipe:0', '-q:v', '2', '-f', 'mjpeg', 'pipe:1'], { input: encodePng(solidImage(width, height, colour)) })
}

// ffmpeg, then a wait that ignores the end of its input: an encoder that never exits on its own. A stopped ffmpeg
// would not do: when its parent dies, the kernel sends a stopped orphaned group SIGHUP.
async function lingeringEncoder(folder: string): Promise<string> {
  const path = join(folder, 'ffmpeg-then-linger.sh')
  // Keep the shell's readable command unchanged. Start its waiting child before ffmpeg, so cleanup does not
  // manufacture a new, unrecorded descendant after the recorded parent has been signaled.
  await writeFile(path, `#!/bin/sh\ncase "$*" in\n  *pipe:0*) sleep 30 & lingering=$!; '${ffmpeg}' "$@"; wait "$lingering" ;;\n  *) exec '${ffmpeg}' "$@" ;;\nesac\n`, { mode: 0o755 })
  return path
}

type ChildFacts = { mediaPid: number; encoderPid: number; partialPath: string; framesPath: string }

// Runs `recording-child.ts`, which records through the client as a test run would, and reads the ids it prints.
function startRecordingChild(t: TestContext, output: string, mode: 'keep' | 'forget'): { child: ChildProcess; facts: Promise<ChildFacts>; printed: Promise<string> } {
  const child = spawn(process.execPath, ['--conditions=retest-source', childPath, binary, ffmpeg, output, mode], { stdio: ['ignore', 'pipe', 'inherit'] })
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  let text = ''
  const { promise: facts, resolve: foundFacts } = Promise.withResolvers<ChildFacts>()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    const before = text
    text += chunk
    if (!before.includes('\n') && text.includes('\n')) {
      const parsed: unknown = JSON.parse(text.slice(0, text.indexOf('\n')))
      assert.ok(typeof parsed === 'object' && parsed !== null && 'mediaPid' in parsed && 'encoderPid' in parsed && 'partialPath' in parsed && 'framesPath' in parsed, text)
      foundFacts({ mediaPid: Number(parsed.mediaPid), encoderPid: Number(parsed.encoderPid), partialPath: String(parsed.partialPath), framesPath: String(parsed.framesPath) })
    }
  })
  const printed = new Promise<string>((resolve) => child.on('close', () => resolve(text)))
  return { child, facts, printed }
}

function averageColour(image: RgbImage): [number, number, number] {
  const sums = [0, 0, 0]
  for (let index = 0; index < image.rgb.length; index += 3) {
    for (let channel = 0; channel < 3; channel += 1) sums[channel] = (sums[channel] ?? 0) + (image.rgb[index + channel] ?? 0)
  }
  const pixels = image.rgb.length / 3
  return [Math.round((sums[0] ?? 0) / pixels), Math.round((sums[1] ?? 0) / pixels), Math.round((sums[2] ?? 0) / pixels)]
}

function assertNear(actual: readonly number[], expected: readonly number[], label: string): void {
  const off = actual.some((value, index) => Math.abs(value - (expected[index] ?? 0)) > 24)
  assert.ok(!off, `${label}: expected about ${expected.join(',')}, decoded ${actual.join(',')}`)
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => assert.fail(`settled with ${JSON.stringify(value)} instead of rejecting`),
    (error: unknown) => error,
  )
}

// Asks for frames until the process has kept `count`, since the encoder thread keeps each frame a moment after it
// arrives.
async function framesOnceKept(recording: Recording, count: number, request: Parameters<Recording['frames']>[0], shown = 0) {
  const end = performance.now() + 5000
  for (;;) {
    const sequence = await recording.frames(request, 5000)
    if (sequence.available >= count && sequence.frames.filter((frame) => frame.fate === 'shown').length >= shown) return sequence
    assert.ok(performance.now() < end, `only ${sequence.available} of ${count} frames were kept`)
    await delay(20)
  }
}

test('the process greets with its protocol, build and encoder, and closes cleanly', async (t) => {
  const media = await startMedia(t)
  assert.equal(media.hello.protocol, 2)
  assert.equal(media.hello.version, '0.1.0')
  assert.equal(media.hello.ffmpeg, ffmpeg)
  assert.match(media.hello.build.target, /^[a-z0-9_]+-[a-z0-9_]+-[a-z0-9_]+/)
  assert.equal(media.hello.build.profile, 'release')
  assert.match(media.hello.build.revision ?? '', /^[0-9a-f]{7,64}$/, 'a binary built from this checkout names its revision')
  const encoder = await media.ready(5000)
  assert.ok(encoder.state === 'ready', JSON.stringify(encoder))
  assert.deepEqual([encoder.codec, encoder.container, encoder.encoder], ['h264', 'mp4', 'libx264'])
  assert.deepEqual(encoder.encodedInput, ['png', 'jpeg'])
  assert.equal(await media.ready(1000), encoder, 'readiness keeps its completed answer')
  if (media.hello.encoder.state !== 'probing') assert.equal(media.hello.encoder, encoder, 'a completed greeting and readiness agree')
  const exit = await media.close(5000)
  assert.deepEqual(exit, { code: 0, signal: null, forced: false, bye: { type: 'bye', stopped: 0 } })
  assert.equal(processAlive(media.pid), false)
})

test('timestamped frames become an H.264 video that holds each frame until the next, mapped by frame id', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t)
  const recording = await record(media, join(folder, 'colours'))
  assert.deepEqual([recording.started.codec, recording.started.container, recording.started.route], ['h264', 'mp4', 'decoded'])
  assert.deepEqual(recording.identity, proofIdentity('r'))
  assert.equal(recording.frame({ ...frame(red, 0), frameId: 'red', actionId: 'a1' }), 'sent')
  assert.equal(recording.frame({ ...frame(green, 200_000), frameId: 'green', observationId: 'o2' }), 'sent')
  assert.equal(recording.frame({ ...frame(blue, 500_000), frameId: 'blue' }), 'sent')
  const ended = await recording.finish(15_000, 800_000)
  assert.equal(ended.status, 'ok', JSON.stringify(ended))
  assert.equal(ended.path, join(folder, 'colours.mp4'))
  assert.equal(ended.placedBy, 'link')
  assert.equal(ended.outputFrames, 8)
  assert.equal(ended.frames.shown, 3)
  assert.deepEqual(ended.identity, proofIdentity('r'))
  assert.deepEqual(ended.evidence, { status: 'complete', reasons: [] })
  assert.deepEqual(ended.frameMap, [
    { frameId: 'red', captureUs: 0, fate: 'shown', videoUs: 0, outputFrames: 2 },
    { frameId: 'green', captureUs: 200_000, fate: 'shown', videoUs: 200_000, outputFrames: 3 },
    { frameId: 'blue', captureUs: 500_000, fate: 'shown', videoUs: 500_000, outputFrames: 3 },
  ])
  const probe = await probeVideo(join(folder, 'colours.mp4'))
  assert.deepEqual([probe.codec, probe.width, probe.height, probe.framesDecoded], ['h264', 64, 48, 8])
  assert.ok(Math.abs(probe.durationSeconds - 0.8) < 0.05, `duration ${probe.durationSeconds}`)
  // Each frame the map names is at its video time in the decoded video.
  for (const entry of ended.frameMap) {
    const index = (entry.videoUs ?? 0) / 100_000
    const decoded = await decodeFrame(join(folder, 'colours.mp4'), index, join(folder, `frame-${index}.png`))
    const colour = entry.frameId === 'red' ? red : entry.frameId === 'green' ? green : blue
    assertNear(averageColour(decoded), colour, `frame ${index}, ${entry.frameId}`)
  }
  assert.equal(existsSync(join(folder, 'colours.frames')), true, 'kept frames stay until released')
  const released = await recording.release(5000)
  assert.deepEqual(released, { type: 'released', recordingId: 'r', reason: 'requested', removed: [join(folder, 'colours.frames')] })
  assert.equal(recording.released, true)
  assert.equal(existsSync(join(folder, 'colours.frames')), false)
})

test('JPEG frames on the encoded route reach ffmpeg undecoded and decode to the same timeline', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t)
  const recording = await record(media, join(folder, 'encoded'), { encodedFormat: 'jpeg' })
  assert.deepEqual([recording.started.route, recording.started.encodedFormat], ['encoded', 'jpeg'])
  const frames = [jpegOf(64, 48, red), jpegOf(64, 48, green), jpegOf(64, 48, blue)]
  assert.equal(recording.frame({ frameId: 'red', timestampUs: 0, format: 'jpeg', bytes: frames[0] ?? Buffer.alloc(0) }), 'sent')
  assert.equal(recording.frame({ frameId: 'green', timestampUs: 200_000, format: 'jpeg', bytes: frames[1] ?? Buffer.alloc(0) }), 'sent')
  // A PNG on a JPEG route is converted, never dropped.
  assert.equal(recording.frame({ frameId: 'blue', timestampUs: 500_000, format: 'png', bytes: encodePng(solidImage(64, 48, blue)) }), 'sent')
  const ended = await recording.finish(15_000, 800_000)
  assert.equal(ended.status, 'ok', JSON.stringify(ended))
  assert.deepEqual(ended.evidence, { status: 'complete', reasons: [] }, JSON.stringify(ended.encoder))
  const jpegBytes = (frames[0]?.byteLength ?? 0) * 2 + (frames[1]?.byteLength ?? 0) * 3
  assert.ok(ended.bytesToEncoder > jpegBytes && ended.bytesToEncoder < 64 * 48 * 3, `the encoder read images, not raw pixels: ${ended.bytesToEncoder} bytes`)
  const probe = await probeVideo(join(folder, 'encoded.mp4'))
  assert.deepEqual([probe.codec, probe.width, probe.height, probe.framesDecoded], ['h264', 64, 48, 8])
  const decoded = await decodeAllFrames(join(folder, 'encoded.mp4'), join(folder, 'decoded'), 'frame')
  const expected = [red, red, green, green, green, blue, blue, blue]
  decoded.forEach((image, index) => assertNear(averageColour(image), expected[index] ?? red, `encoded frame ${index}`))
})

test('a capture gap the client reports is named in the ending', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t)
  const recording = await record(media, join(folder, 'gap'))
  recording.frame(frame(red, 0))
  assert.equal(recording.captureGap({ fromUs: 100_000, toUs: 400_000, reason: 'dialog_open' }), true)
  assert.throws(() => recording.captureGap({ fromUs: 0, toUs: 1, reason: 'Free text' }), RangeError)
  assert.throws(() => recording.captureGap({ fromUs: 5, toUs: 1, reason: 'backwards' }), RangeError)
  recording.frame(frame(green, 500_000))
  const ended = await recording.finish(15_000, 600_000)
  assert.equal(ended.status, 'ok', JSON.stringify(ended))
  assert.deepEqual(ended.captureGaps, [{ fromUs: 100_000, toUs: 400_000, reason: 'dialog_open' }])
  assert.deepEqual(ended.evidence, { status: 'partial', reasons: ['capture_gaps'] })
  assert.equal(recording.captureGap({ fromUs: 0, toUs: 1, reason: 'late' }), false, 'nothing is sent for an ended recording')
})

test('frames come back from a running and an ended recording, with the stretches that had none', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t)
  const recording = await record(media, join(folder, 'sequence'))
  recording.frame({ ...frame(red, 0), frameId: 'one', actionId: 'click-1' })
  recording.frame({ ...frame(green, 100_000), frameId: 'two' })
  recording.frame({ ...frame(blue, 1_500_000), frameId: 'three' })
  // Keeping the third image precedes writing the second image to ffmpeg. Wait for both earlier frames to be
  // shown before asserting their exact fates; the last frame stays pending until another frame or finish.
  const running = await framesOnceKept(recording, 3, { fromUs: 0, toUs: 2_000_000, maxFrames: 8, maxWidth: 32, maxHeight: 32, format: 'png' }, 2)
  assert.equal(running.status, 'ok', JSON.stringify(running))
  assert.equal(running.recording, 'running')
  assert.deepEqual(running.frames.map((each) => [each.frameId, each.fate, each.width, each.height]), [
    ['one', 'shown', 32, 24],
    ['two', 'shown', 32, 24],
    ['three', 'pending', 32, 24],
  ])
  assert.equal(running.frames[0]?.actionId, 'click-1')
  assertNear(averageColour(decodePng(running.frames[1]?.bytes ?? new Uint8Array())), green, 'the second kept frame')
  assert.deepEqual(running.stretches.map((stretch) => [stretch.fromUs, stretch.toUs]), [[100_000, 1_500_000], [1_500_000, 2_000_000]], 'stretches without a kept frame are named')
  const one = await recording.frames({ fromUs: 0, toUs: 2_000_000, maxFrames: 1, maxWidth: 16, maxHeight: 16 }, 5000)
  assert.equal(one.frames.length, 1)
  assert.equal(one.omitted.byCount, 2, 'frames left out by the cap are counted, not hidden')
  await recording.finish(15_000, 1_600_000)
  const ended = await recording.frames({ fromUs: 0, toUs: 2_000_000, maxFrames: 8, maxWidth: 16, maxHeight: 16 }, 5000)
  assert.equal(ended.recording, 'ended')
  assert.deepEqual(ended.frames.map((each) => each.fate), ['shown', 'shown', 'shown'])
  await recording.release(5000)
  const released = await recording.frames({ fromUs: 0, toUs: 2_000_000, maxFrames: 8, maxWidth: 16, maxHeight: 16 }, 5000)
  assert.equal(released.status, 'released')
  await assert.rejects(media.frames('nobody', { fromUs: 0, toUs: 1, maxFrames: 1, maxWidth: 1, maxHeight: 1 }, 5000), (error: unknown) => error instanceof MediaRequestError && error.reply.code === 'unknown_recording')
  await assert.rejects(recording.frames({ fromUs: 5, toUs: 1, maxFrames: 1, maxWidth: 1, maxHeight: 1 }, 5000), RangeError)
  await assert.rejects(recording.frames({ fromUs: 0, toUs: 1, maxFrames: 65, maxWidth: 1, maxHeight: 1 }, 5000), RangeError)
})

test('a thumbnail is written fitted within its size, and a failure is named', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t)
  const made = await media.thumbnail({ output: join(folder, 'shot'), maxWidth: 32, maxHeight: 32, format: 'png' }, { format: 'png', bytes: encodePng(solidImage(64, 48, green)) }, 5000)
  assert.equal(made.status, 'ok', JSON.stringify(made))
  assert.deepEqual([made.path, made.width, made.height, made.sourceWidth, made.sourceHeight], [join(folder, 'shot.png'), 32, 24, 64, 48])
  const written = decodePng(await readFile(join(folder, 'shot.png')))
  assert.deepEqual([written.width, written.height], [32, 24])
  assertNear(averageColour(written), green, 'the thumbnail')
  const again = await media.thumbnail({ output: join(folder, 'shot'), maxWidth: 32, maxHeight: 32, format: 'png' }, { format: 'png', bytes: encodePng(solidImage(64, 48, green)) }, 5000)
  assert.equal(again.status, 'output_in_use')
  const garbage = await media.thumbnail({ output: join(folder, 'garbage'), maxWidth: 32, maxHeight: 32, format: 'jpeg' }, { format: 'png', bytes: Buffer.from('not a png') }, 5000)
  assert.equal(garbage.status, 'undecodable')
  await assert.rejects(media.thumbnail({ output: join(folder, 'big'), maxWidth: 5000, maxHeight: 32, format: 'png' }, { format: 'png', bytes: encodePng(solidImage(2, 2, red)) }, 5000), RangeError)
})

test('a live view hands over the newest frame, and stopping it ends it with its totals', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t)
  const recording = await record(media, join(folder, 'live'))
  const seen: LiveFrame[] = []
  const view = await recording.watch({ maxWidth: 32, maxHeight: 32, maxFps: 20 }, (live) => seen.push(live), 5000)
  assert.deepEqual(view.options, { type: 'watching', recordingId: 'r', maxWidth: 32, maxHeight: 32, maxFps: 20 })
  await assert.rejects(recording.watch({ maxWidth: 32, maxHeight: 32, maxFps: 20 }, () => {}, 5000), /already has a live view/)
  for (let index = 0; index < 10; index += 1) {
    recording.frame({ ...frame(index % 2 === 0 ? red : blue, index * 100_000), frameId: `l${index}` })
    await delay(60)
  }
  const ended = await view.stop(5000)
  assert.equal(ended.reason, 'unwatched')
  assert.ok(seen.length > 0, 'no live frame came')
  assert.equal(ended.sent, seen.length, JSON.stringify(ended))
  for (const live of seen) {
    assert.match(live.frameId, /^l\d$/)
    assert.deepEqual([live.width, live.height, live.format], [32, 24, 'jpeg'])
    assert.deepEqual([...live.bytes.subarray(0, 2)], [0xff, 0xd8])
  }
  // A watcher that throws stops its view; the recording goes on.
  const throwing = await recording.watch({ maxWidth: 16, maxHeight: 16, maxFps: 20 }, () => {
    throw new Error('the watcher is gone')
  }, 5000)
  recording.frame({ ...frame(green, 2_000_000), frameId: 'after' })
  const stopped = await throwing.ended
  assert.equal(stopped.reason, 'unwatched')
  recording.frame({ ...frame(green, 2_100_000), frameId: 'later' })
  const result = await recording.finish(15_000)
  assert.equal(result.status, 'ok')
  assert.equal(result.frames.received, 12)
})

test('what a lost recording left can be listed and removed, so the output can be used again', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t)
  const output = join(folder, 'lost')
  await writeFile(`${output}.mp4.partial`, 'half a video')
  await writeFile(`${output}.frames`, 'kept frames')
  await assert.rejects(media.record(startOf('r', output), 5000), (error: unknown) => error instanceof MediaRequestError && error.reply.code === 'output_in_use')
  const listed = await media.leftovers(output, { remove: false }, 5000)
  assert.deepEqual(listed.files.map((file) => [file.path, file.kind]), [[`${output}.mp4.partial`, 'video_partial'], [`${output}.frames`, 'frame_store']])
  assert.equal(listed.removed, false)
  const removed = await media.leftovers(output, { remove: true }, 5000)
  assert.equal(removed.removed, true)
  assert.equal(existsSync(`${output}.mp4.partial`), false)
  const start = await media.record(startOf('r', output), 5000)
  assert.equal(start.kind, 'started')
  const busy = await media.leftovers(output, { remove: true }, 5000)
  assert.equal(busy.status, 'in_use')
})

test('a program that is not ffmpeg ends the recording with its exit code and last lines', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t, { args: mediaArguments({ ffmpeg: '/bin/cat' }) })
  const encoder = await media.ready(5000)
  assert.equal(encoder.state, 'failed', JSON.stringify(encoder))
  const start = await media.record(startOf('r', join(folder, 'never'), { deadlineMs: 1000 }), 5000)
  assert.ok(start.kind === 'ended', JSON.stringify(start))
  assert.equal(start.ended.status, 'encoder_failed')
  assert.deepEqual(start.ended.evidence, { status: 'unavailable', reasons: ['encoder_failed'] })
  assert.equal(start.ended.encoder?.exitCode, 1)
  assert.match(start.ended.encoder?.stderr.join('\n') ?? '', /cat/)
  const exit = await media.close(5000)
  assert.deepEqual([exit.code, exit.forced, exit.bye?.stopped], [0, false, 0])
})

test('a missing binary fails to start and says so', async () => {
  await assert.rejects(
    MediaProcess.start({ executable: '/no/such/retest-media', startTimeoutMs: 5000 }),
    (error: unknown) => error instanceof MediaProcessError && /could not be started/.test(error.message),
  )
})

test('a start the process refuses rejects with its reason', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t)
  await assert.rejects(
    media.record(startOf('odd', join(folder, 'odd'), { width: 63, deadlineMs: 1000 }), 5000),
    (error: unknown) => error instanceof MediaRequestError && error.reply.code === 'invalid_start' && error.reply.request === 'start' && /even/.test(error.message),
  )
})

test('frames after finishing are refused here, and finishing twice gives the one ending', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t)
  const recording = await record(media, join(folder, 'twice'))
  recording.frame(frame(red, 0))
  const first = recording.finish(15_000)
  assert.equal(recording.frame(frame(green, 100_000)), 'closed')
  const second = recording.finish(15_000)
  const [one, two] = await Promise.all([first, second])
  assert.equal(one, two)
  assert.equal(one.frames.received, 1)
})

test('an encoder killed mid-recording ends the recording before it is finished, and its file goes', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t)
  const recording = await record(media, join(folder, 'killed'))
  const sent = await frameUntilPartial(recording, frame(red, 0).bytes)
  process.kill(recording.started.encoderPid, 'SIGKILL')
  for (let index = sent; index < sent + 8; index += 1) recording.frame(frame(blue, index * 100_000))
  const ended = await recording.ended
  assert.equal(ended.status, 'encoder_failed', JSON.stringify(ended))
  assert.equal(ended.encoder?.signal, 9)
  assert.equal(recording.frame(frame(blue, 20_000_000)), 'closed')
  assert.equal(await recording.finish(5000), ended)
  assert.equal(existsSync(join(folder, 'killed.mp4')), false)
  assert.equal(existsSync(join(folder, 'killed.mp4.partial')), false, 'the file the encoder had begun was removed')
  const kept = await recording.frames({ fromUs: 0, toUs: 10_000_000, maxFrames: 4, maxWidth: 8, maxHeight: 8 }, 5000)
  assert.ok(kept.available > 0, 'frames taken before the encoder died are still kept')
  assert.equal(kept.recording, 'ended')
  assert.deepEqual(kept.frames.filter((each) => each.fate === 'pending'), [], 'an ended recording has no frame still to be placed')
})

test('a media process that dies leaves its recordings rejected with the file their encoder finished, and its kept frames removed', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t)
  const recording = await record(media, join(folder, 'orphaned'))
  await frameUntilPartial(recording, frame(red, 0).bytes)
  const framesPath = recording.started.framesPath ?? ''
  assert.equal(existsSync(framesPath), true)
  // The media process alone, as a crash would. Its encoder leads a group of its own and sees its input end.
  process.kill(media.pid, 'SIGKILL')
  const lost = await rejection(recording.ended)
  assert.ok(lost instanceof MediaRecordingLostError, String(lost))
  assert.match(lost.message, /signal SIGKILL/)
  assert.match(lost.message, /did not end: its recorded encoder processes exited on their own, and it left .*; its kept frames were removed/)
  assert.equal(lost.partialPath, `${recording.started.path}.partial`)
  assert.equal(existsSync(`${recording.started.path}.partial`), true)
  assert.equal(existsSync(framesPath), false, 'the dead process\'s working file is gone')
  assert.equal(processAlive(recording.started.encoderPid), false)
  assert.equal(groupAlive(recording.started.encoderPid), false)
})

test('a media process that dies with its encoder wedged has the encoder stopped', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t, { args: mediaArguments({ ffmpeg: await lingeringEncoder(folder) }) })
  const recording = await record(media, join(folder, 'wedged'))
  await frameUntilPartial(recording, frame(red, 0).bytes)
  process.kill(media.pid, 'SIGKILL')
  const lost = await rejection(recording.ended)
  assert.ok(lost instanceof MediaRecordingLostError, String(lost))
  assert.match(lost.message, /did not end: its recorded encoder processes were stopped, and it left/)
  assert.equal(lost.partialPath, `${recording.started.path}.partial`, 'ffmpeg finished its file before the wrapper lingered')
  assert.equal(processAlive(recording.started.encoderPid), false, 'the encoder was gone before the recording was rejected')
  assert.equal(groupAlive(recording.started.encoderPid), false)
})

test('a media process that dies has the encoder stopped even when its leader exited and a child lingers', async (t) => {
  const folder = await scratch(t)
  // A wrapper that leaves a child in the encoder's group and then becomes ffmpeg, so the group's leader exits on
  // its own when its input ends while the child goes on: the shape of an ffmpeg that forks a helper.
  const forking = join(folder, 'ffmpeg-with-a-child.sh')
  await writeFile(forking, `#!/bin/sh\ncase "$*" in\n  *pipe:0*) sleep 30 & exec '${ffmpeg}' "$@" ;;\n  *) exec '${ffmpeg}' "$@" ;;\nesac\n`, { mode: 0o755 })
  const media = await startMedia(t, { args: mediaArguments({ ffmpeg: forking }) })
  const recording = await record(media, join(folder, 'forked'))
  const group = recording.started.encoderPid
  await frameUntilPartial(recording, frame(red, 0).bytes)
  process.kill(media.pid, 'SIGKILL')
  const lost = await rejection(recording.ended)
  assert.ok(lost instanceof MediaRecordingLostError, String(lost))
  assert.match(lost.message, /its recorded encoder processes were stopped, and it left/)
  assert.equal(processAlive(group), false)
  assert.equal(groupAlive(group), false, 'the lingering child outlived the recording')
})

test('a forced close stops the encoders of the recordings a stalled process left, before it returns', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t, { args: mediaArguments({ ffmpeg: await lingeringEncoder(folder) }) })
  const recording = await record(media, join(folder, 'stalled'))
  await frameUntilPartial(recording, frame(red, 0).bytes)
  let settled: unknown
  recording.ended.then(
    (ended) => assert.fail(`the recording was given an ending the process never sent: ${JSON.stringify(ended)}`),
    (error: unknown) => {
      settled = error
    },
  )
  // A media process that no longer reads: a close has to kill it.
  process.kill(media.pid, 'SIGSTOP')
  const exit = await media.close(300)
  assert.deepEqual([exit.forced, exit.signal, exit.bye], [true, 'SIGKILL', undefined])
  assert.ok(settled instanceof MediaRecordingLostError, `the recording was not rejected before close returned: ${String(settled)}`)
  assert.match(settled.message, /its recorded encoder processes were stopped/)
  assert.equal(settled.partialPath, `${recording.started.path}.partial`)
  assert.equal(existsSync(`${recording.started.path}.partial`), true, 'the file the orphaned encoder finished is named, and kept for the caller to judge')
  assert.equal(processAlive(recording.started.encoderPid), false, 'the encoder outlived close')
  assert.equal(groupAlive(recording.started.encoderPid), false)
})

test('a start, a finish and a job pending when the process dies reject with how it ended', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t)
  const recording = await record(media, join(folder, 'pending'))
  await frameUntilPartial(recording, frame(red, 0).bytes)
  // Stopped first, so no request is read before the kill.
  process.kill(media.pid, 'SIGSTOP')
  const finishing = recording.finish(5000)
  const starting = media.record(startOf('next', join(folder, 'next'), { deadlineMs: 1000 }), 5000)
  const thumbnail = media.thumbnail({ output: join(folder, 'thumb'), maxWidth: 8, maxHeight: 8, format: 'png' }, { format: 'png', bytes: frame(red, 0).bytes }, 5000)
  process.kill(media.pid, 'SIGKILL')
  const start = await rejection(starting)
  assert.ok(start instanceof MediaProcessError && !(start instanceof MediaRecordingLostError), String(start))
  assert.match(start.message, /the media process ended with signal SIGKILL/)
  assert.match(String(await rejection(thumbnail)), /the media process ended with signal SIGKILL/)
  const finish = await rejection(finishing)
  assert.ok(finish instanceof MediaRecordingLostError, String(finish))
  assert.equal(finish.recordingId, 'r')
  assert.equal(processAlive(recording.started.encoderPid), false)
})

test('nothing asked of an ended or closing process waits forever', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t)
  const recording = await record(media, join(folder, 'closing'))
  recording.frame(frame(red, 0))
  const closing = media.close(5000)
  assert.equal(recording.frame(frame(green, 100_000)), 'not_sent')
  await assert.rejects(media.record(startOf('late', join(folder, 'late'), { deadlineMs: 1000 }), 5000), /closing/)
  const exit = await closing
  assert.deepEqual([exit.code, exit.forced, exit.bye?.stopped], [0, false, 1])
  const ended = await recording.ended
  assert.equal(ended.status, 'stopped', JSON.stringify(ended))
  assert.equal(ended.frames.received, 1, 'the frame sent while closing never reached the process')
  assert.equal(groupAlive(recording.started.encoderPid), false, 'the stopped recording left its encoder group running')
  assert.equal(existsSync(`${recording.started.path}.partial`), false)
  assert.equal(existsSync(join(folder, 'closing.frames')), false, 'the shutdown removed the kept frames')
  await assert.rejects(media.record(startOf('later', join(folder, 'later'), { deadlineMs: 1000 }), 5000), /has ended with exit code 0/)
})

test('a signal that ends this process mid-recording leaves no media process, encoder or file', async (t) => {
  const folder = await scratch(t)
  const { child, facts } = startRecordingChild(t, join(folder, 'signalled'), 'keep')
  const { mediaPid, encoderPid, partialPath, framesPath } = await facts
  assert.equal(existsSync(partialPath), true)
  assert.equal(existsSync(framesPath), true)
  child.kill('SIGTERM')
  await new Promise<void>((resolve) => child.on('close', () => resolve()))
  assert.equal(child.signalCode, 'SIGTERM')
  // The media process reads the end of its input and shuts down on its own, stopping the recording.
  await waitUntilGone(mediaPid, 5000)
  await waitUntilGone(encoderPid, 2000)
  assert.equal(groupAlive(encoderPid), false)
  assert.equal(existsSync(partialPath), false, 'the stopped recording left its file')
  assert.equal(existsSync(framesPath), false, 'the shutdown removed the kept frames')
  assert.equal(existsSync(join(folder, 'signalled.mp4')), false)
})

test('a forgotten close does not keep this process alive once its recordings are done', async (t) => {
  const folder = await scratch(t)
  const { child, facts, printed } = startRecordingChild(t, join(folder, 'forgotten'), 'forget')
  const { mediaPid, encoderPid } = await facts
  const exited = await Promise.race([printed.then(() => true), delay(5000).then(() => false)])
  assert.ok(exited, `the child is still running ${5000} ms after its recording ended; the media process keeps it alive`)
  assert.deepEqual([child.exitCode, child.signalCode], [0, null])
  assert.match(await printed, /"ended":"ok"/)
  await waitUntilGone(mediaPid, 5000)
  assert.equal(processAlive(encoderPid), false)
  assert.equal(existsSync(join(folder, 'forgotten.mp4')), true)
})

test('a start answered after its timeout is finished, and its encoder is stopped if the process then dies', async (t) => {
  const folder = await scratch(t)
  const media = await startStandIn(t, 'late-start')
  const output = join(folder, 'late')
  await assert.rejects(media.record(startOf('r', output, { deadlineMs: 1000 }), 50), /did not answer the start of r within 50 ms/)
  // The stand-in writes the encoder's pid as it answers, 300 ms after the start.
  await waitForFile(`${output}.pid`, 2000)
  const encoderPid = Number(await readFile(`${output}.pid`, 'utf8'))
  t.after(() => {
    if (processAlive(encoderPid)) process.kill(encoderPid, 'SIGKILL')
  })
  await delay(100)
  assert.equal(processAlive(encoderPid), true, 'the stand-in started no encoder')
  await assert.rejects(media.record(startOf('r', output, { deadlineMs: 1000 }), 50), /already started/)
  process.kill(media.pid, 'SIGKILL')
  const exit = await media.exited
  assert.equal(exit.signal, 'SIGKILL')
  await waitUntilGone(encoderPid, 2500)
  assert.equal(groupAlive(encoderPid), false)
})

test('a frame sent after the pipe to the process broke is not sent, and a start says why', async (t) => {
  const media = await startStandIn(t, 'close-input')
  await delay(300)
  // Nothing can know the pipe is broken until a write fails; this one is handed to the pipe and lost.
  assert.equal(media.sendFrame('r', frame(red, 0)), 'sent')
  await delay(100)
  assert.equal(media.sendFrame('r', frame(red, 100_000)), 'not_sent')
  assert.equal(media.traffic.framesSent, 1)
  await assert.rejects(media.record(startOf('r', '/tmp/never', { deadlineMs: 1000 }), 50), /the pipe to the media process broke: .*EPIPE/)
  assert.equal(processAlive(media.pid), true, 'the stand-in is still running; only its input is closed')
})

test('an id or a frame the process could not take is refused before anything is sent', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t)
  const longId = 'x'.repeat(MAX_ID_CHARACTERS + 1)
  await assert.rejects(media.record(startOf(longId, join(folder, 'long'), { deadlineMs: 1000 }), 5000), RangeError)
  const hugeId = 'é'.repeat(70_000)
  await assert.rejects(media.record(startOf(hugeId, join(folder, 'huge'), { deadlineMs: 1000 }), 5000), RangeError)
  await assert.rejects(media.record(startOf('ctl', join(folder, 'ctl'), { identity: { ...proofIdentity('ctl'), testId: 'a\nb' } }), 5000), /control character/)
  await assert.rejects(media.record(startOf('empty', join(folder, 'empty'), { identity: { ...proofIdentity('empty'), runId: '' } }), 5000), /runId is empty/)
  // An output this long would carry the header past the process's limit, which ends every recording.
  const hugeOutput = join(folder, 'o'.repeat(70_000))
  await assert.rejects(media.record(startOf('huge-output', hugeOutput, { deadlineMs: 1000 }), 5000), (error: unknown) => error instanceof RangeError && /output path has 70\d{3} bytes/.test(error.message))
  await assert.rejects(media.thumbnail({ output: hugeOutput, maxWidth: 8, maxHeight: 8, format: 'png' }, { format: 'png', bytes: frame(red, 0).bytes }, 5000), RangeError)
  await assert.rejects(media.leftovers(hugeOutput, { remove: false }, 5000), RangeError)
  assert.equal(media.traffic.headerBytes, 0, 'a refused start was written')
  // An output at the process's own limit reaches it and is answered; the process goes on.
  const longestOutput = `/${'é'.repeat((MAX_PATH_BYTES - 2) / 2)}x`
  assert.equal(Buffer.byteLength(longestOutput), MAX_PATH_BYTES)
  await assert.rejects(media.record(startOf('longest-output', longestOutput, { deadlineMs: 1000 }), 5000), MediaRequestError)
  const listed = await media.leftovers(longestOutput, { remove: false }, 5000)
  assert.equal(listed.status, 'ok', JSON.stringify(listed))
  const okId = 'é'.repeat(MAX_ID_CHARACTERS)
  const start = await media.record(startOf(okId, join(folder, 'longest'), { deadlineMs: 1000 }), 5000)
  assert.ok(start.kind === 'started', JSON.stringify(start))
  const tooLarge = { frameId: 'big', timestampUs: 0, format: 'png' as const, bytes: new Uint8Array(MAX_FRAME_BYTES + 1) }
  assert.throws(() => start.recording.frame(tooLarge), RangeError)
  assert.throws(() => media.sendFrame(okId, tooLarge), RangeError)
  assert.throws(() => start.recording.frame({ ...frame(red, 0), frameId: 'f'.repeat(MAX_FRAME_ID_CHARACTERS + 1) }), RangeError)
  assert.throws(() => start.recording.frame({ ...frame(red, 0), frameId: '' }), RangeError)
  assert.throws(() => start.recording.frame({ ...frame(red, 0), observationId: 'o\u0000' }), RangeError)
  assert.equal(media.traffic.framesSent, 0)
  assert.equal(start.recording.frame(frame(red, 0)), 'sent')
  const ended = await start.recording.finish(15_000)
  assert.equal(ended.status, 'ok', JSON.stringify(ended))
})

test('errors nobody waited for are kept to the newest 64', async (t) => {
  const media = await startMedia(t)
  for (let index = 0; index < 70; index += 1) assert.equal(media.sendFrame(`nobody-${index}`, frame(red, 0)), 'sent')
  const end = performance.now() + 5000
  while (media.errors.at(-1)?.recordingId !== 'nobody-69') {
    assert.ok(performance.now() < end, `only ${media.errors.length} errors arrived: ${JSON.stringify(media.errors.at(-1))}`)
    await delay(10)
  }
  assert.equal(media.errors.length, 64)
  assert.deepEqual([media.errors[0]?.recordingId, media.errors[0]?.code, media.errors[0]?.request], ['nobody-6', 'unknown_recording', 'frame'])
})

test('numbers the process could not read are refused before they are sent', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t)
  await assert.rejects(media.record(startOf('ntsc', join(folder, 'ntsc'), { fps: 29.97, deadlineMs: 1000 }), 5000), RangeError)
  const recording = await record(media, join(folder, 'fraction'))
  assert.throws(() => recording.frame({ ...frame(red, 0), timestampUs: 1.5 }), RangeError)
  await assert.rejects(recording.finish(5000, -1), RangeError)
  assert.equal(media.traffic.framesSent, 0)
})

test('a start or a finish with no answer in time rejects, and the recording can still end later', async (t) => {
  const stubborn = await startStandIn(t, 'stubborn')
  const folder = await scratch(t)
  await assert.rejects(stubborn.record(startOf('r', join(folder, 'unanswered'), { deadlineMs: 1000 }), 200), /did not answer the start of r within 200 ms/)
  await assert.rejects(stubborn.ready(200), /did not say whether its encoder is ready within 200 ms/)
  await assert.rejects(stubborn.leftovers(join(folder, 'x'), { remove: false }, 200), /did not answer the leftovers/)
  const media = await startMedia(t)
  const start = await media.record(startOf('slow', join(folder, 'slow-finish'), { deadlineMs: 600 }), 5000)
  assert.ok(start.kind === 'started', JSON.stringify(start))
  const recording = start.recording
  recording.frame(frame(red, 0))
  await delay(200)
  process.kill(recording.started.encoderPid, 'SIGSTOP')
  await assert.rejects(recording.finish(200), /did not end within 200 ms of its finish/)
  const ended = await recording.ended
  assert.equal(ended.status, 'deadline_exceeded', JSON.stringify(ended))
})

test('a second recording cannot write where the first does', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t)
  await record(media, join(folder, 'shared'))
  await assert.rejects(
    media.record(startOf('second', join(folder, 'shared'), { deadlineMs: 1000 }), 5000),
    (error: unknown) => error instanceof MediaRequestError && error.reply.code === 'output_in_use' && error.reply.message === `recording r is writing ${join(folder, 'shared.mp4')}`,
  )
})

test('frames sent faster than the pipe drains are dropped here and counted', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t, { maxPendingBytes: 1024 * 1024 })
  const recording = await record(media, join(folder, 'flood'), { width: 512, height: 512 })
  // Stored without compression, each frame is about 786 kB, so the pipe cannot take forty in one go.
  const bytes = encodePng(solidImage(512, 512, green), 0)
  const outcomes = Array.from({ length: 40 }, (_, index) => recording.frame({ frameId: `flood-${index}`, timestampUs: index * 100_000, format: 'png', bytes }))
  const sent = outcomes.filter((outcome) => outcome === 'sent').length
  const dropped = outcomes.filter((outcome) => outcome === 'dropped').length
  assert.ok(dropped > 0 && sent > 0, `sent ${sent}, dropped ${dropped}`)
  assert.deepEqual([media.traffic.framesSent, media.traffic.framesDropped], [sent, dropped])
  const ended = await recording.finish(60_000)
  assert.equal(ended.status, 'ok', JSON.stringify(ended))
  assert.equal(ended.frames.received, sent, 'the process read every frame this client sent')
})

test('close kills a process that will not exit', async () => {
  const media = await MediaProcess.start({ executable: process.execPath, args: [stubbornPath, '2'], startTimeoutMs: 5000 })
  const exit = await media.close(300)
  assert.deepEqual([exit.forced, exit.signal], [true, 'SIGKILL'])
  assert.equal(processAlive(media.pid), false)
})

test('a binary speaking another protocol version is refused by name, with what to install', async () => {
  await assert.rejects(
    MediaProcess.start({ executable: process.execPath, args: [stubbornPath, '1'], startTimeoutMs: 5000 }),
    (error: unknown) =>
      error instanceof MediaVersionError &&
      error.binaryProtocol === 1 &&
      error.binaryVersion === '0.0.0-stub' &&
      /is retest-media 0\.0\.0-stub, which speaks media protocol 1; this Retest needs one that speaks media protocol 2: build the matching binary from this Retest with: cargo build --release --manifest-path media\/Cargo\.toml$/.test(error.message),
  )
  await assert.rejects(
    MediaProcess.start({ executable: process.execPath, args: [stubbornPath, '3'], startTimeoutMs: 5000, installHint: 'run retest install media' }),
    (error: unknown) => error instanceof MediaVersionError && error.binaryProtocol === 3 && error.message.endsWith('media protocol 2: run retest install media'),
  )
})

test('a folder of leftovers that is not a file is left alone', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t)
  const output = join(folder, 'odd')
  await mkdir(`${output}.mp4.partial`)
  const removed = await media.leftovers(output, { remove: true }, 5000)
  assert.deepEqual([removed.files, removed.skipped, removed.removed], [[], [`${output}.mp4.partial`], true])
  assert.equal(existsSync(`${output}.mp4.partial`), true)
})
