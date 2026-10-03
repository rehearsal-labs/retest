import type { ChildProcess } from 'node:child_process'
import type { TestContext } from 'node:test'
import type { MediaProcessOptions, Recording } from '../../src/media/client.ts'
import type { RgbImage } from './png.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { MediaProcess, MediaProcessError, MediaRecordingLostError, MediaRequestError, mediaArguments } from '../../src/media/client.ts'
import { MAX_FRAME_BYTES, MAX_ID_CHARACTERS } from '../../src/media/protocol.ts'
import { encodePng, solidImage } from './png.ts'
import { decodeFrame, ffmpegPath, frameUntilPartial, groupAlive, mediaBinary, probeVideo, processAlive, waitForFile, waitUntilGone } from './support.ts'

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

async function startStandIn(t: TestContext, mode: string, protocol = '1'): Promise<MediaProcess> {
  const media = await MediaProcess.start({ executable: process.execPath, args: [stubbornPath, protocol, mode], startTimeoutMs: 5000 })
  t.after(async () => {
    await media.close(300)
    assert.equal(processAlive(media.pid), false, `stand-in ${media.pid} outlived its test`)
  })
  return media
}

async function record(media: MediaProcess, output: string, size: { width: number; height: number } = { width: 64, height: 48 }): Promise<Recording> {
  const start = await media.record({ recordingId: 'r', ...size, fps: 10, output, deadlineMs: 10_000 }, 5000)
  assert.equal(start.kind, 'started', JSON.stringify(start))
  assert.ok(start.kind === 'started')
  return start.recording
}

function frame(colour: readonly [number, number, number], timestampUs: number) {
  return { timestampUs, format: 'png' as const, bytes: encodePng(solidImage(64, 48, colour)) }
}

// ffmpeg, then a wait that ignores the end of its input: an encoder that never exits on its own. A stopped ffmpeg
// would not do: when its parent dies, the kernel sends a stopped orphaned group SIGHUP.
async function lingeringEncoder(folder: string): Promise<string> {
  const path = join(folder, 'ffmpeg-then-linger.sh')
  await writeFile(path, `#!/bin/sh\ncase "$*" in\n  *pipe:0*) '${ffmpeg}' "$@"; exec sleep 30 ;;\n  *) exec '${ffmpeg}' "$@" ;;\nesac\n`, { mode: 0o755 })
  return path
}

type ChildFacts = { mediaPid: number; encoderPid: number; partialPath: string }

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
      assert.ok(typeof parsed === 'object' && parsed !== null && 'mediaPid' in parsed && 'encoderPid' in parsed && 'partialPath' in parsed, text)
      foundFacts({ mediaPid: Number(parsed.mediaPid), encoderPid: Number(parsed.encoderPid), partialPath: String(parsed.partialPath) })
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

test('the process greets with its protocol and version, and closes cleanly', async () => {
  const media = await MediaProcess.start({ executable: binary, args: mediaArguments({ ffmpeg }), startTimeoutMs: 5000 })
  assert.equal(media.hello.protocol, 1)
  assert.equal(media.hello.version, '0.1.0')
  assert.equal(media.hello.ffmpeg, ffmpeg)
  const exit = await media.close(5000)
  assert.deepEqual(exit, { code: 0, signal: null, forced: false, bye: { type: 'bye', stopped: 0 } })
  assert.equal(processAlive(media.pid), false)
})

test('timestamped frames become an H.264 video that holds each frame until the next', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t)
  const recording = await record(media, join(folder, 'colours'))
  assert.deepEqual([recording.started.codec, recording.started.container], ['h264', 'mp4'])
  assert.equal(recording.frame(frame(red, 0)), 'sent')
  assert.equal(recording.frame(frame(green, 200_000)), 'sent')
  assert.equal(recording.frame(frame(blue, 500_000)), 'sent')
  const ended = await recording.finish(15_000, 800_000)
  assert.equal(ended.status, 'ok', JSON.stringify(ended))
  assert.equal(ended.path, join(folder, 'colours.mp4'))
  assert.equal(ended.outputFrames, 8)
  assert.equal(ended.frames.shown, 3)
  const probe = await probeVideo(join(folder, 'colours.mp4'))
  assert.deepEqual([probe.codec, probe.width, probe.height, probe.framesDecoded], ['h264', 64, 48, 8])
  assert.ok(Math.abs(probe.durationSeconds - 0.8) < 0.05, `duration ${probe.durationSeconds}`)
  const expected = [[1, red], [3, green], [6, blue]] as const
  for (const [index, colour] of expected) {
    const decoded = await decodeFrame(join(folder, 'colours.mp4'), index, join(folder, `frame-${index}.png`))
    assertNear(averageColour(decoded), colour, `frame ${index}`)
  }
})

test('a program that is not ffmpeg ends the recording with its exit code and last lines', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t, { args: mediaArguments({ ffmpeg: '/bin/cat' }) })
  const start = await media.record({ recordingId: 'r', width: 64, height: 48, fps: 10, output: join(folder, 'never'), deadlineMs: 1000 }, 5000)
  assert.ok(start.kind === 'ended', JSON.stringify(start))
  assert.equal(start.ended.status, 'encoder_failed')
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
    media.record({ recordingId: 'odd', width: 63, height: 48, fps: 10, output: join(folder, 'odd'), deadlineMs: 1000 }, 5000),
    (error: unknown) => error instanceof MediaRequestError && error.reply.code === 'invalid_start' && /even/.test(error.message),
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
})

test('a media process that dies leaves its recordings rejected with the file their encoder finished', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t)
  const recording = await record(media, join(folder, 'orphaned'))
  await frameUntilPartial(recording, frame(red, 0).bytes)
  // The media process alone, as a crash would. Its encoder leads a group of its own and sees its input end.
  process.kill(media.pid, 'SIGKILL')
  const lost = await rejection(recording.ended)
  assert.ok(lost instanceof MediaRecordingLostError, String(lost))
  assert.match(lost.message, /signal SIGKILL/)
  assert.match(lost.message, /did not end: its encoder exited on its own, and it left/)
  assert.equal(lost.partialPath, `${recording.started.path}.partial`)
  assert.equal(existsSync(`${recording.started.path}.partial`), true)
  assert.equal(processAlive(recording.started.encoderPid), false)
  assert.equal(groupAlive(recording.started.encoderPid), false)
})

test('a media process that dies with its encoder wedged has the encoder group killed', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t, { args: mediaArguments({ ffmpeg: await lingeringEncoder(folder) }) })
  const recording = await record(media, join(folder, 'wedged'))
  await frameUntilPartial(recording, frame(red, 0).bytes)
  process.kill(media.pid, 'SIGKILL')
  const lost = await rejection(recording.ended)
  assert.ok(lost instanceof MediaRecordingLostError, String(lost))
  assert.match(lost.message, new RegExp(`did not end: its encoder's process group ${recording.started.encoderPid} was killed, and it left`))
  assert.equal(lost.partialPath, `${recording.started.path}.partial`, 'ffmpeg finished its file before the wrapper lingered')
  assert.equal(processAlive(recording.started.encoderPid), false, 'the encoder group was gone before the recording was rejected')
  assert.equal(groupAlive(recording.started.encoderPid), false)
})

test('a media process that dies has the encoder group killed even when its leader exited and a child lingers', async (t) => {
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
  assert.match(lost.message, new RegExp(`its encoder exited on its own, and its encoder's process group ${group} was killed, and it left`))
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
  assert.match(settled.message, new RegExp(`its encoder's process group ${recording.started.encoderPid} was killed`))
  assert.equal(settled.partialPath, `${recording.started.path}.partial`)
  assert.equal(existsSync(`${recording.started.path}.partial`), true, 'the file the orphaned encoder finished is named, and kept for the caller to judge')
  assert.equal(processAlive(recording.started.encoderPid), false, 'the encoder outlived close')
  assert.equal(groupAlive(recording.started.encoderPid), false)
})

test('a start and a finish pending when the process dies reject with how it ended', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t)
  const recording = await record(media, join(folder, 'pending'))
  await frameUntilPartial(recording, frame(red, 0).bytes)
  // Stopped first, so neither request is read before the kill.
  process.kill(media.pid, 'SIGSTOP')
  const finishing = recording.finish(5000)
  const starting = media.record({ recordingId: 'next', width: 64, height: 48, fps: 10, output: join(folder, 'next'), deadlineMs: 1000 }, 5000)
  process.kill(media.pid, 'SIGKILL')
  const start = await rejection(starting)
  assert.ok(start instanceof MediaProcessError && !(start instanceof MediaRecordingLostError), String(start))
  assert.match(start.message, /the media process ended with signal SIGKILL/)
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
  await assert.rejects(media.record({ recordingId: 'late', width: 64, height: 48, fps: 10, output: join(folder, 'late'), deadlineMs: 1000 }, 5000), /closing/)
  const exit = await closing
  assert.deepEqual([exit.code, exit.forced, exit.bye?.stopped], [0, false, 1])
  const ended = await recording.ended
  assert.equal(ended.status, 'stopped', JSON.stringify(ended))
  assert.equal(ended.frames.received, 1, 'the frame sent while closing never reached the process')
  assert.equal(groupAlive(recording.started.encoderPid), false, 'the stopped recording left its encoder group running')
  assert.equal(existsSync(`${recording.started.path}.partial`), false)
  await assert.rejects(media.record({ recordingId: 'later', width: 64, height: 48, fps: 10, output: join(folder, 'later'), deadlineMs: 1000 }, 5000), /has ended with exit code 0/)
})

test('a signal that ends this process mid-recording leaves no media process, encoder or file', async (t) => {
  const folder = await scratch(t)
  const { child, facts } = startRecordingChild(t, join(folder, 'signalled'), 'keep')
  const { mediaPid, encoderPid, partialPath } = await facts
  assert.equal(existsSync(partialPath), true)
  child.kill('SIGTERM')
  await new Promise<void>((resolve) => child.on('close', () => resolve()))
  assert.equal(child.signalCode, 'SIGTERM')
  // The media process reads the end of its input and shuts down on its own, stopping the recording.
  await waitUntilGone(mediaPid, 5000)
  await waitUntilGone(encoderPid, 2000)
  assert.equal(groupAlive(encoderPid), false)
  assert.equal(existsSync(partialPath), false, 'the stopped recording left its file')
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
  await assert.rejects(media.record({ recordingId: 'r', width: 64, height: 48, fps: 10, output, deadlineMs: 1000 }, 50), /did not answer the start of r within 50 ms/)
  // The stand-in writes the encoder's pid as it answers, 300 ms after the start.
  await waitForFile(`${output}.pid`, 2000)
  const encoderPid = Number(await readFile(`${output}.pid`, 'utf8'))
  t.after(() => {
    if (processAlive(encoderPid)) process.kill(encoderPid, 'SIGKILL')
  })
  await delay(100)
  assert.equal(processAlive(encoderPid), true, 'the stand-in started no encoder')
  await assert.rejects(media.record({ recordingId: 'r', width: 64, height: 48, fps: 10, output, deadlineMs: 1000 }, 50), /already started/)
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
  await assert.rejects(media.record({ recordingId: 'r', width: 64, height: 48, fps: 10, output: '/tmp/never', deadlineMs: 1000 }, 50), /the pipe to the media process broke: .*EPIPE/)
  assert.equal(processAlive(media.pid), true, 'the stand-in is still running; only its input is closed')
})

test('an id or a frame the process could not take is refused before anything is sent', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t)
  const longId = 'x'.repeat(MAX_ID_CHARACTERS + 1)
  await assert.rejects(media.record({ recordingId: longId, width: 64, height: 48, fps: 10, output: join(folder, 'long'), deadlineMs: 1000 }, 5000), RangeError)
  const hugeId = 'é'.repeat(70_000)
  await assert.rejects(media.record({ recordingId: hugeId, width: 64, height: 48, fps: 10, output: join(folder, 'huge'), deadlineMs: 1000 }, 5000), RangeError)
  assert.equal(media.traffic.headerBytes, 0, 'a refused start was written')
  const okId = 'é'.repeat(MAX_ID_CHARACTERS)
  const start = await media.record({ recordingId: okId, width: 64, height: 48, fps: 10, output: join(folder, 'longest'), deadlineMs: 1000 }, 5000)
  assert.ok(start.kind === 'started', JSON.stringify(start))
  const tooLarge = { timestampUs: 0, format: 'png' as const, bytes: new Uint8Array(MAX_FRAME_BYTES + 1) }
  assert.throws(() => start.recording.frame(tooLarge), RangeError)
  assert.throws(() => media.sendFrame(okId, tooLarge), RangeError)
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
  assert.deepEqual([media.errors[0]?.recordingId, media.errors[0]?.code], ['nobody-6', 'unknown_recording'])
})

test('numbers the process could not read are refused before they are sent', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t)
  await assert.rejects(media.record({ recordingId: 'ntsc', width: 64, height: 48, fps: 29.97, output: join(folder, 'ntsc'), deadlineMs: 1000 }, 5000), RangeError)
  const recording = await record(media, join(folder, 'fraction'))
  assert.throws(() => recording.frame({ ...frame(red, 0), timestampUs: 1.5 }), RangeError)
  await assert.rejects(recording.finish(5000, -1), RangeError)
  assert.equal(media.traffic.framesSent, 0)
})

test('a start or a finish with no answer in time rejects, and the recording can still end later', async (t) => {
  const stubborn = await startStandIn(t, 'stubborn')
  const folder = await scratch(t)
  await assert.rejects(
    stubborn.record({ recordingId: 'r', width: 64, height: 48, fps: 10, output: join(folder, 'unanswered'), deadlineMs: 1000 }, 200),
    /did not answer the start of r within 200 ms/,
  )
  const media = await startMedia(t)
  const start = await media.record({ recordingId: 'slow', width: 64, height: 48, fps: 10, output: join(folder, 'slow-finish'), deadlineMs: 600 }, 5000)
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
    media.record({ recordingId: 'second', width: 64, height: 48, fps: 10, output: join(folder, 'shared'), deadlineMs: 1000 }, 5000),
    (error: unknown) => error instanceof MediaRequestError && error.reply.code === 'output_in_use' && error.reply.message === `recording r is writing ${join(folder, 'shared.mp4')}`,
  )
})

test('frames sent faster than the pipe drains are dropped here and counted', async (t) => {
  const folder = await scratch(t)
  const media = await startMedia(t, { maxPendingBytes: 1024 * 1024 })
  const recording = await record(media, join(folder, 'flood'), { width: 512, height: 512 })
  // Stored without compression, each frame is about 786 kB, so the pipe cannot take forty in one go.
  const bytes = encodePng(solidImage(512, 512, green), 0)
  const outcomes = Array.from({ length: 40 }, (_, index) => recording.frame({ timestampUs: index * 100_000, format: 'png', bytes }))
  const sent = outcomes.filter((outcome) => outcome === 'sent').length
  const dropped = outcomes.filter((outcome) => outcome === 'dropped').length
  assert.ok(dropped > 0 && sent > 0, `sent ${sent}, dropped ${dropped}`)
  assert.deepEqual([media.traffic.framesSent, media.traffic.framesDropped], [sent, dropped])
  const ended = await recording.finish(60_000)
  assert.equal(ended.status, 'ok', JSON.stringify(ended))
  assert.equal(ended.frames.received, sent, 'the process read every frame this client sent')
})

test('close kills a process that will not exit', async () => {
  const media = await MediaProcess.start({ executable: process.execPath, args: [stubbornPath, '1'], startTimeoutMs: 5000 })
  const exit = await media.close(300)
  assert.deepEqual([exit.forced, exit.signal], [true, 'SIGKILL'])
  assert.equal(processAlive(media.pid), false)
})

test('a process speaking another protocol version is refused', async () => {
  await assert.rejects(
    MediaProcess.start({ executable: process.execPath, args: [stubbornPath, '2'], startTimeoutMs: 5000 }),
    (error: unknown) => error instanceof MediaProcessError && /speaks media protocol 2; this client speaks 1/.test(error.message),
  )
})
