import type { TestContext } from 'node:test'
import type { TaskService } from '../../fixtures/cross-platform/service/task-service.ts'
import type { CaptureStats, CapturedFrame, FrameSource, RecordSourceOptions } from '../../src/media/capture.ts'
import type { NativeCaptureSession } from '../../src/native/capture.ts'
import type { ProcessReading } from '../../src/native/session.ts'
import type { RequestBounds } from '../../src/native/webdriver-client.ts'
import type { RecordIdentity } from '../../src/protocol/identity.ts'
import assert from 'node:assert/strict'
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { startTaskService } from '../../fixtures/cross-platform/service/task-service.ts'
import { microsecondsSince, recordSource } from '../../src/media/capture.ts'
import { mediaArguments, MediaProcess } from '../../src/media/client.ts'
import { sessionFrameSource, simulatorDisplayFrameSource } from '../../src/native/capture.ts'
import { grabSimulatorDisplay } from '../../src/native/capture/simulator-display.ts'
import { NativeInteractionSession } from '../../src/native/interaction-session.ts'
import { IosSimulatorRuntime, simulatorAppProcesses } from '../../src/native/ios-simulator.ts'
import { commandOf, OwnedProcess, systemTools } from '../../src/native/processes.ts'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'
import { decodeFrames, decodeVideo, differingPixels, imageSize, matchVideo, mediaPrerequisites, pausesMs, shownFrameIds, spread, watched } from './capture-proof.ts'
import { executorBuild, nativeSkipReason, taskPhoneApp } from './native-harness.ts'
import { assertQueuedNativeCaptureDeadline } from './native-capture-deadline-fixture.ts'

// Frames of the real iOS simulator into the real media process, with WebDriverAgent and TaskPhone: the capture routes
// the simulator offers, measured while TaskPhone is typed into, the one chosen recorded through `recordSource`, and the
// video decoded by ffmpeg and checked frame by frame against the frames that went in. Takes a simulator: run only under
// the heavy gate lock. Skipped by name on a machine without the pinned Xcode, the iOS 26.5 runtime or TaskPhone's build.
// Set RETEST_CAPTURE_PROOF_OUT to keep the videos and reports.

const skip = await nativeSkipReason('ios-simulator')
const actionMs = 20_000
const owner = { runId: 'capture-ios', testId: 'tests/integration/capture-ios.test.ts > records', attemptId: 'capture2', app: 'phone' }
const identity: RecordIdentity = { testId: owner.testId, attemptId: owner.attemptId, app: owner.app, sessionId: 'capture2:phone' }
const redact = (text: string): string => text

/** How each fill went while a capture ran, or with none. */
type Typing = { readonly fills: number; readonly failed: string[]; readonly durationsMs: number[] }

/** Types into TaskPhone's account field again and again for `milliseconds`, timing each fill. */
async function typeFor(interaction: NativeInteractionSession, milliseconds: number): Promise<Typing> {
  const end = performance.now() + milliseconds
  const durationsMs: number[] = []
  const failed: string[] = []
  let fills = 0
  while (performance.now() < end) {
    fills += 1
    const started = performance.now()
    const filled = await interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'account-field' }, value: `Release checklist ${fills}` }, actionMs)
    durationsMs.push(Math.round(performance.now() - started))
    if (!filled.result.ok) failed.push(filled.result.failure.message)
  }
  return { fills, failed, durationsMs }
}

/** The session the executor-screen route captures through: the interaction's own lane, between its actions. */
function laneSession(interaction: NativeInteractionSession): NativeCaptureSession {
  return {
    get identity() {
      return interaction.session.identity
    },
    get ended() {
      return interaction.session.ended
    },
    get cancelled() {
      return interaction.session.cancelled
    },
    get appStatus() {
      return interaction.session.appStatus
    },
    capture: (timeoutMs, options) => interaction.capture(timeoutMs, options.source === undefined ? {} : { source: options.source }),
  }
}

/** Whether every frame starts as its format's files do. */
function wellFormed(frames: readonly CapturedFrame[]): boolean {
  return frames.every((frame) => (frame.format === 'png' ? frame.bytes[0] === 0x89 && frame.bytes[1] === 0x50 : frame.bytes[0] === 0xff && frame.bytes[1] === 0xd8))
}

async function keep(name: string, details: object, video?: string): Promise<void> {
  const folder = process.env['RETEST_CAPTURE_PROOF_OUT']
  if (!folder) return
  await mkdir(folder, { recursive: true })
  if (video !== undefined) await copyFile(video, join(folder, `${name}.${video.split('.').at(-1) ?? 'mp4'}`))
  await writeFile(join(folder, `${name}-report.json`), `${JSON.stringify(details, null, 2)}\n`)
}

test('a confirmed queued capture timeout is retained and the source recovers without an early loss', assertQueuedNativeCaptureDeadline)

describe('capture of the real iOS simulator into the real media process, with TaskPhone', { skip }, () => {
  let runtime: IosSimulatorRuntime
  let service: TaskService
  let logs: string
  let interaction: NativeInteractionSession

  before(async () => {
    logs = await mkdtemp(join(tmpdir(), 'retest-capture-ios-'))
    service = await startTaskService({ port: 0, syncDelayMs: 100 })
    const build = await executorBuild('webdriveragent', logs)
    const started = await IosSimulatorRuntime.start({ target: { appPath: taskPhoneApp, device: 'iPhone 17', runtime: '26.5' }, build, tools: systemTools, redact, logFolder: logs, timeoutMs: 600_000 })
    if (!started.ok) throw new Error(started.failure.message)
    runtime = started.runtime
    const opened = await runtime.openSession({ owner, launch: { arguments: ['-reset', '-serviceURL', service.url], environment: {} }, redact }, 30_000)
    if (!opened.ok) throw new Error(opened.failure.message)
    assert.equal((await opened.session.install({ appPath: taskPhoneApp }, 120_000)).result.ok, true, 'install')
    assert.equal((await opened.session.launch(120_000)).result.ok, true, 'launch')
    const processes = (bounds: RequestBounds): Promise<ProcessReading> => simulatorAppProcesses(systemTools, runtime.udid, runtime.bundle.bundleId, bounds)
    interaction = new NativeInteractionSession({ session: opened.session, client: opened.client, executor: opened.executor, redact, processes })
  })

  after(async () => {
    try {
      await interaction?.dispose(60_000)
      await runtime?.close(180_000)
    } finally {
      await service?.close()
      const kept = process.env['RETEST_CAPTURE_PROOF_OUT']
      if (kept !== undefined && logs !== undefined) await cp(logs, join(kept, 'ios-runtime-logs'), { recursive: true })
      await rm(logs, { recursive: true, force: true })
    }
  })

  test('the routes the simulator offers, measured while TaskPhone is typed into, and what each costs the actions', async (t) => {
    const needs = mediaPrerequisites(t)
    if (needs === undefined) return
    const baseline = await typeFor(interaction, 4000)
    assert.deepEqual(baseline.failed, [])
    const routes: [string, FrameSource][] = [
      ['executor-screen, through the session’s lane', sessionFrameSource(laneSession(interaction), identity, 'executor-screen')],
      ['simulator-display, JPEG from simctl', simulatorDisplayFrameSource({ session: interaction.session, udid: runtime.udid, tools: systemTools, format: 'jpeg' }, identity)],
      ['simulator-display, PNG from simctl', simulatorDisplayFrameSource({ session: interaction.session, udid: runtime.udid, tools: systemTools, format: 'png' }, identity)],
    ]
    const measured: object[] = [{ route: 'no capture', fillMs: spread(baseline.durationsMs), fills: baseline.fills }]
    for (const [route, source] of routes) {
      await t.test(route, async (routeTest) => {
        const startedAt = performance.now()
        const frames: CapturedFrame[] = []
        const ended: string[] = []
        const started = await source.start({ fps: 30, clock: microsecondsSince(startedAt), deliver: (frame) => frames.push(frame), ended: (reason) => ended.push(reason), timeoutMs: 10_000 })
        routeTest.after(() => source.stop(10_000))
        assert.deepEqual(started, { ok: true, mode: 'screenshot-loop' }, route)
        const typing = await typeFor(interaction, 4000)
        const stats: CaptureStats = await source.stop(10_000)
        const size = frames[0] === undefined ? undefined : await imageSize(needs.ffprobe, frames[0].bytes, frames[0].format)
        const bytes = spread(frames.map((frame) => frame.bytes.byteLength))
        measured.push({ route, stats, size, bytes, pausesMs: spread(pausesMs(frames)), fillMs: spread(typing.durationsMs), fills: typing.fills })
        await keep('ios-routes', { measured })
        assert.deepEqual(typing.failed, [], `${route}: every fill went while capture ran`)
        assert.ok(typing.durationsMs.every((duration) => duration < actionMs), `${route}: no fill outlasted its budget`)
        assert.deepEqual(ended, [], `${route}: capture ran to its stop`)
        assert.ok(stats.delivered >= 2 && stats.delivered === frames.length, `${route}: ${JSON.stringify(stats)}`)
        assert.ok(wellFormed(frames), `${route}: every frame is the target's own image`)
        assert.ok(frames.every((frame) => frame.identity.sessionId === identity.sessionId && frame.identity.observationId === undefined))
      })
    }
    t.diagnostic(JSON.stringify(measured))
    await keep('ios-routes', { measured })
  })

  async function recordDisplay(t: TestContext, route: 'session-hook' | 'direct-simctl'): Promise<void> {
    const artifactName = route === 'session-hook' ? 'ios-simulator-display' : 'ios-simulator-candidate'
    const needs = mediaPrerequisites(t)
    if (needs === undefined) return
    const folder = await mkdtemp(join(tmpdir(), 'retest-capture-ios-video-'))
    t.after(() => rm(folder, { recursive: true, force: true }))
    const probe = await grabSimulatorDisplay({ tools: systemTools, udid: runtime.udid, format: 'png', timeoutMs: 10_000, signal: new AbortController().signal })
    assert.ok(probe.ok, probe.ok ? '' : probe.problem)
    const size = await imageSize(needs.ffprobe, probe.bytes, 'png')
    const media = await MediaProcess.start({ executable: needs.binary, args: mediaArguments({ ffmpeg: needs.ffmpeg }), startTimeoutMs: 10_000 })
    t.after(() => media.close(10_000))
    const { source, frames } = watched(route === 'session-hook' ? interaction.frameSource(identity) : simulatorDisplayFrameSource({ session: interaction.session, udid: runtime.udid, tools: systemTools, format: 'png' }, identity))
    const stop = new AbortController()
    const options: RecordSourceOptions = { recordingId: 'ios', runId: owner.runId, output: join(folder, 'ios'), width: size.width, height: size.height, fps: 10, deadlineMs: 30_000, clock: microsecondsSince(performance.now()), startTimeoutMs: 10_000, stopTimeoutMs: 10_000, finishTimeoutMs: 40_000, signal: stop.signal }
    const recording = recordSource(source, media, options)
    t.after(async () => { stop.abort(); await recording })
    const typing = await typeFor(interaction, 5000)
    stop.abort()
    const report = await recording
    const kept = process.env['RETEST_CAPTURE_PROOF_OUT']
    if (kept !== undefined) {
      const captured = join(kept, `${artifactName}-frames`)
      await mkdir(captured, { recursive: true })
      for (const [index, frame] of frames.entries()) await writeFile(join(captured, `${index + 1}.${frame.format}`), frame.bytes)
      await keep(`${artifactName}-raw`, { report, handedOver: frames.map((frame) => ({ identity: frame.identity, timestampUs: frame.timestampUs, earliestUs: frame.earliestUs, format: frame.format, byteLength: frame.bytes.byteLength })) })
    }
    const ended = report.ended
    assert.ok(ended !== undefined, report.reason)
    assert.equal(ended.status, 'ok', ended.message)
    const video = await decodeVideo(needs, ended.path ?? '')
    const ids = shownFrameIds(ended, video.frames.length, options.fps)
    const pictures = await decodeFrames(needs, frames, size)
    const matched = matchVideo(video.frames, pictures, ids, { timestampsUs: frames.map(frame => frame.timestampUs), fps: options.fps })
    const margins = matched.matched.map((entry) => ({ own: entry.own, nearestOther: entry.nearestOther ?? null }))
    // Keep the first failed comparison's actual source differences. This explains a tie without changing the check.
    const firstFailure = matched.matched.find((entry) => entry.nearestOther !== undefined && entry.own >= entry.nearestOther)
    let strictFailure: object | undefined
    if (firstFailure !== undefined) {
      const expected = pictures[firstFailure.frame]
      const output = video.frames[firstFailure.video]
      if (expected !== undefined && output !== undefined) {
        const otherIndex = pictures.findIndex((other, index) => index !== firstFailure.frame && differingPixels(expected, other, 0) > 0 && differingPixels(output, other) === firstFailure.nearestOther)
        const other = pictures[otherIndex]
        if (other !== undefined) {
          let changedPixels = 0
          let maxDelta = 0
          let left = size.width
          let top = size.height
          let right = -1
          let bottom = -1
          for (let index = 0; index < expected.pixels.length; index++) {
            const delta = Math.abs((expected.pixels[index] ?? 0) - (other.pixels[index] ?? 0))
            if (delta === 0) continue
            changedPixels += 1
            maxDelta = Math.max(maxDelta, delta)
            const x = index % size.width
            const y = Math.floor(index / size.width)
            left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y)
          }
          strictFailure = { videoFrame: firstFailure.video, mappedFrame: firstFailure.frame + 1, otherFrame: otherIndex + 1, videoToMapped: firstFailure.own, videoToOther: firstFailure.nearestOther, sourceDifference: { changedPixels, maxDelta, pixelsOver48: differingPixels(expected, other), bounds: { left, top, right, bottom } } }
          t.diagnostic(JSON.stringify({ strictFailure }))
        }
      }
    }
    const measured = { size, capture: report.capture, frames: report.frames, gaps: report.gaps, fills: typing.fills, fillMs: spread(typing.durationsMs), video: { frames: video.frames.length, fps: video.fps, codec: video.codec }, counts: ended.frames, evidence: ended.evidence, pausesMs: spread(pausesMs(frames)) }
    t.diagnostic(JSON.stringify(measured))
    await keep(artifactName, { report, measured, margins, strictFailure, frameMap: ended.frameMap, handedOver: frames.map((frame) => ({ identity: frame.identity, timestampUs: frame.timestampUs, earliestUs: frame.earliestUs, format: frame.format, byteLength: frame.bytes.byteLength })) }, ended.path)

    assert.deepEqual(typing.failed, [])
    assert.equal(report.status, 'ended')
    assert.equal(report.capture?.mode, 'screenshot-loop')
    assert.equal(report.source, 'simulator-display')
    assert.deepEqual(ended.identity, { runId: owner.runId, ...identity })
    assert.equal(ended.frames.received, report.frames.sent, 'every frame sent reached the process')
    assert.equal(ended.frames.resized, 0, 'the recording is the display’s own size, so no frame was resized')
    assert.deepEqual(ended.frameMap.map((entry) => entry.frameId), frames.map((_, index) => String(index + 1)))
    assert.deepEqual(matched.unmapped, [], 'the frame map accounts for every video frame')
    assert.ok(new Set(pictures.map((picture) => picture.pixels.join(','))).size >= 2, 'the frames show the screen changing')
    for (const entry of matched.matched) {
      if (entry.nearestOther === undefined) continue
      assert.ok(entry.own < entry.nearestOther, `video frame ${entry.video} is closer to frame ${entry.frame + 1} (${entry.own} pixels differ) than to any other frame that differs (${entry.nearestOther})`)
    }
  }

  test('the simulator display, recorded through recordSource: every video frame shows the frame its time maps to, and the recording names the run and the session', (t) => recordDisplay(t, 'session-hook'))

  test('direct simctl PNG recording retains every strict comparison for diagnosis', (t) => recordDisplay(t, 'direct-simctl'))

  test('the simulator’s own recording exists, but it is encoded by the simulator with no frame times on the run’s clock, so it is not a capture mode', async (t) => {
    const needs = mediaPrerequisites(t)
    if (needs === undefined) return
    const folder = await mkdtemp(join(tmpdir(), 'retest-capture-ios-record-'))
    t.after(() => rm(folder, { recursive: true, force: true }))
    const path = join(folder, 'simulator.mp4')
    const args = ['simctl', 'io', runtime.udid, 'recordVideo', '--codec=h264', '--force', path]
    const recorder = await OwnedProcess.start({ command: systemTools.xcrun, args, logFile: join(folder, 'recorder.log'), hiddenVariables: systemTools.hiddenVariables })
    t.after(async () => { assert.deepEqual(await recorder.stop(0), []); assert.equal(await recorder.processesRemain(), false) })
    const reading = await commandOf(systemTools, recorder.pid)
    assert.equal(reading.state, 'present')
    await keep('ios-recorder-process', { pid: recorder.pid, command: systemTools.xcrun, args, reading })
    const recorded = new OwnedProcessGroup(recorder.pid)
    assert.deepEqual(recorded.capture(), [])
    let said = await readFile(recorder.logFile, 'utf8')
    const startedBy = performance.now() + 15_000
    while (!said.includes('Recording started') && performance.now() < startedBy) { await sleep(50); said = await readFile(recorder.logFile, 'utf8') }
    const recordingStartedAfterMs = Math.round(15_000 - (startedBy - performance.now()))
    assert.ok(said.includes('Recording started'), `simctl said: ${said}`)
    const typing = await typeFor(interaction, 3000)
    assert.deepEqual(recorded.signal('SIGINT'), [])
    const ending = await recorder.waitForExit(30_000)
    if (ending === undefined) assert.deepEqual(recorded.signal('SIGKILL'), [])
    const code = ending?.code ?? 'late'
    said = await readFile(recorder.logFile, 'utf8')
    assert.equal(code, 0, `simctl said: ${said}`)
    const video = await decodeVideo(needs, path)
    const measured = { recordingStartedAfterMs, fills: typing.fills, decodedFrames: video.frames.length, fps: video.fps, codec: video.codec, files: await readdir(folder) }
    t.diagnostic(JSON.stringify(measured))
    await keep('ios-simulator-recording', { measured }, path)
    assert.ok(video.frames.length > 0)
  })

  test('the real app termination ends its display source while the session remains open', async (t) => {
    const source = interaction.frameSource(identity)
    const frames: CapturedFrame[] = []
    const reasons: string[] = []
    t.after(async () => {
      await source.stop(5000)
      if (!interaction.session.ended && !interaction.session.appStatus.expectedRunning) assert.equal((await interaction.launch(120_000)).result.ok, true, 'relaunch for the following close proof')
    })
    assert.deepEqual(await source.start({ fps: 30, timeoutMs: 10_000, clock: microsecondsSince(performance.now()), deliver: (frame) => frames.push(frame), ended: (reason) => reasons.push(reason) }), { ok: true, mode: 'screenshot-loop' })
    assert.equal((await interaction.terminate(30_000)).result.ok, true)
    assert.equal(interaction.session.ended, false, 'termination does not close the session')
    const endedBy = performance.now() + 5000
    while (reasons.length === 0 && performance.now() < endedBy) await sleep(20)
    const stoppedAt = performance.now()
    const stats = await source.stop(5000)
    const stopMs = performance.now() - stoppedAt
    assert.ok(stopMs < 5100)
    assert.equal(reasons.length, 1)
    assert.match(reasons[0] ?? '', /app processes are no longer running|no longer expects its app/)
    const delivered = frames.length
    await sleep(100)
    assert.equal(frames.length, delivered)
    assert.ok(stats.endedEarly !== undefined)
    await keep('ios-display-terminate', { reasons, delivered, stopMs, stats })
  })

  test('the real session close ends its running display source with a reason and no later frame', async (t) => {
    const source = interaction.frameSource(identity)
    const frames: CapturedFrame[] = []
    const reasons: string[] = []
    assert.deepEqual(await source.start({ fps: 30, timeoutMs: 10_000, clock: microsecondsSince(performance.now()), deliver: (frame) => frames.push(frame), ended: (reason) => reasons.push(reason) }), { ok: true, mode: 'screenshot-loop' })
    t.after(() => source.stop(5000))
    await interaction.dispose(60_000)
    const endedBy = performance.now() + 5000
    while (reasons.length === 0 && performance.now() < endedBy) await sleep(20)
    const stoppedAt = performance.now()
    const stats = await source.stop(5000)
    const stopMs = performance.now() - stoppedAt
    assert.ok(stopMs < 5100)
    assert.equal(reasons.length, 1)
    assert.ok(stats.endedEarly !== undefined)
    const delivered = frames.length
    await sleep(100)
    assert.equal(frames.length, delivered)
    await keep('ios-display-close', { reasons, delivered, stopMs, stats })
  })
})
