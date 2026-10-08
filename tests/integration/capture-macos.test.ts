import type { TaskService } from '../../fixtures/cross-platform/service/task-service.ts'
import type { CaptureStats, CapturedFrame, RecordSourceOptions } from '../../src/media/capture.ts'
import type { MacosAppRuntime } from '../../src/native/macos-app.ts'
import type { DecodedPng } from '../../src/native/png.ts'
import type { NativeAppSession, ProcessReading } from '../../src/native/session.ts'
import type { ExecutorSession, Rect, RequestBounds } from '../../src/native/webdriver-client.ts'
import type { RecordIdentity } from '../../src/protocol/identity.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { startTaskService } from '../../fixtures/cross-platform/service/task-service.ts'
import { microsecondsSince, recordSource } from '../../src/media/capture.ts'
import { mediaArguments, MediaProcess } from '../../src/media/client.ts'
import { NativeInteractionSession } from '../../src/native/interaction-session.ts'
import { MacosDesktop, windowsOnScreen } from '../../src/native/macos-app.ts'
import { decodePng } from '../../src/native/png.ts'
import { listProcesses, systemTools } from '../../src/native/processes.ts'
import { decodeFrames, decodeVideo, imageSize, matchVideo, mediaPrerequisites, pausesMs, shownFrameIds, spread, watched } from './capture-proof.ts'
import { executorBuild, mainScreen, nativeSkipReason, processesWith, taskDeskApp } from './native-harness.ts'

// Frames of a real macOS app into the real media process, with the macOS runner and TaskDesk: the app's own window
// image, first with a window of this test's own over it, then as a screenshot loop through the session's lane, measured
// while TaskDesk is typed into, recorded through `recordSource`, and the video decoded by ffmpeg and checked frame by
// frame against the frames that went in. The image needs Screen Recording permission for the app the test runs under.
// Takes the desktop: run only under the heavy gate lock. Skipped by name on a machine without the pinned Xcode,
// Automation Mode without a dialog or TaskDesk's build, or with a TaskDesk already running. Set RETEST_CAPTURE_PROOF_OUT
// to keep the video and report.

const skip = (await nativeSkipReason('macos')) ?? ((await processesWith('/TaskDesk.app/Contents/MacOS/TaskDesk')).length > 0 ? 'TaskDesk is already running; this test never touches a copy it did not start' : undefined)
const actionMs = 20_000
const owner = { runId: 'capture-macos', testId: 'tests/integration/capture-macos.test.ts > records', attemptId: 'capture3', app: 'desk' }
const identity: RecordIdentity = { testId: owner.testId, attemptId: owner.attemptId, app: owner.app, sessionId: 'capture3:desk' }
const redact = (text: string): string => text
// TaskDesk's window, near the top left of the screen, away from the centre where another app's window may float.
const windowFrame = '20,60,700,480'
const deskFrame: Rect = { x: 20, y: 60, width: 700, height: 480 }
// A window of this test's own over part of TaskDesk's window, in screen points.
const overlayFrame: Rect = { x: 400, y: 300, width: 120, height: 80 }

type Typing = { readonly fills: number; readonly failed: string[]; readonly durationsMs: number[] }

// A borderless magenta window of a process this test starts, at layer 1000 as another app's floating window is, over
// `frame`. It takes no clicks and no focus, and closes itself after a minute should the test not end it first.
async function openOverlay(frame: Rect): Promise<{ readonly pid: number; close(): Promise<void> }> {
  const script = [
    "ObjC.import('Cocoa')",
    '$.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyAccessory)',
    'const height = $.NSScreen.mainScreen.frame.size.height',
    `const window = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(${frame.x}, height - ${frame.y + frame.height}, ${frame.width}, ${frame.height}), $.NSWindowStyleMaskBorderless, $.NSBackingStoreBuffered, false)`,
    'window.backgroundColor = $.NSColor.colorWithSRGBRedGreenBlueAlpha(1, 0, 1, 1)',
    'window.opaque = true',
    'window.hasShadow = false',
    'window.ignoresMouseEvents = true',
    'window.level = 1000',
    'window.orderFrontRegardless',
    '$.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(60))',
  ].join('\n')
  const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { stdio: 'ignore' })
  const exited = once(child, 'exit')
  const close = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    await exited
  }
  const pid = child.pid
  if (pid === undefined) throw new Error('The overlay process started without a pid.')
  const until = performance.now() + 10_000
  while (performance.now() < until) {
    const windows = await windowsOnScreen(systemTools, { timeoutMs: 5000 })
    if (typeof windows !== 'string' && windows.some((entry) => entry.pid === pid && entry.layer === 1000)) return { pid, close }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await close()
  throw new Error('The overlay window was not on screen within 10 s.')
}

// The share of pixels inside `area`, in image pixels, that are the overlay's magenta, allowing for the display's colour space.
function magentaShare(image: DecodedPng, area: Rect): number {
  let magenta = 0
  for (let row = area.y; row < area.y + area.height; row += 1) {
    for (let column = area.x; column < area.x + area.width; column += 1) {
      const offset = (row * image.width + column) * image.channels
      const [red = 0, green = 0, blue = 0] = image.pixels.subarray(offset, offset + 3)
      if (red > 200 && green < 100 && blue > 200) magenta += 1
    }
  }
  return magenta / (area.width * area.height)
}

function scaled(area: Rect, scale: number): Rect {
  return { x: Math.round(area.x * scale), y: Math.round(area.y * scale), width: Math.round(area.width * scale), height: Math.round(area.height * scale) }
}

// Reads the app's tree until it holds the app's window, failing with what it last read after `timeoutMs`.
async function windowInTree(session: NativeAppSession, timeoutMs: number): Promise<void> {
  const until = performance.now() + timeoutMs
  let seen = 'nothing was read'
  while (performance.now() < until) {
    const tree = await session.readSource(Math.max(1, Math.floor(until - performance.now())))
    if (tree.ok && tree.tree.source.window !== undefined) return
    seen = tree.ok ? 'a tree with no window frame' : tree.failure.message
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`TaskDesk's window was not in its tree within ${timeoutMs} ms: ${seen}`)
}

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

describe('capture of a real macOS app into the real media process, with TaskDesk', { skip }, () => {
  let desktop: MacosDesktop
  let app: MacosAppRuntime
  let service: TaskService
  let logs: string
  let executable: string
  let interaction: NativeInteractionSession
  let session: NativeAppSession
  let executor: ExecutorSession

  before(async () => {
    logs = await mkdtemp(join(tmpdir(), 'retest-capture-macos-'))
    executable = join(await realpath(taskDeskApp), 'Contents', 'MacOS', 'TaskDesk')
    service = await startTaskService({ port: 0, syncDelayMs: 100 })
    const build = await executorBuild('mac2', logs)
    const started = await MacosDesktop.start({ build, tools: systemTools, redact, logFolder: logs, timeoutMs: 180_000 })
    if (!started.ok) throw new Error(started.failure.message)
    desktop = started.desktop
    const openedApp = await desktop.openApp(taskDeskApp)
    if (!openedApp.ok) throw new Error(openedApp.failure.message)
    app = openedApp.runtime
    const opened = await app.openSession({ owner, launch: { arguments: ['-reset', '-serviceURL', service.url, '-windowFrame', windowFrame], environment: {} }, redact }, 30_000)
    if (!opened.ok) throw new Error(opened.failure.message)
    session = opened.session
    executor = opened.executor
    assert.equal((await opened.session.launch(60_000)).result.ok, true, 'launch')
    const processes = async (bounds: RequestBounds): Promise<ProcessReading> => {
      try {
        const pids = (await listProcesses(systemTools, bounds.timeoutMs)).filter((entry) => entry.command === executable || entry.command.startsWith(`${executable} `)).map((entry) => entry.pid)
        return { ok: true, running: pids.length > 0, pids }
      } catch (error) {
        return { ok: false, problem: String(error) }
      }
    }
    interaction = new NativeInteractionSession({ session: opened.session, client: opened.client, executor: opened.executor, redact, processes, tools: systemTools })
  })

  after(async () => {
    try {
      await interaction?.dispose(60_000)
      await desktop?.close(60_000)
      assert.deepEqual(await processesWith(executable), [], 'no TaskDesk is left')
    } finally {
      await service?.close()
      const kept = process.env['RETEST_CAPTURE_PROOF_OUT']
      if (kept !== undefined && logs !== undefined) await cp(logs, join(kept, 'macos-runtime-logs'), { recursive: true })
      await rm(logs, { recursive: true, force: true })
    }
  })

  test('with a window of another process over TaskDesk\'s window, the capture is TaskDesk\'s window alone', async (t) => {
    // TaskDesk's window comes into its tree a few seconds after the launch, and the capture is asked for once it is there.
    await windowInTree(session, 20_000)
    const overlay = await openOverlay(overlayFrame)
    // Whatever happened in the test, the overlay goes and TaskDesk is in front again for the typing that follows.
    t.after(async () => {
      await overlay.close()
      const activated = await session.activate(20_000)
      if (!activated.result.ok) throw new Error(`TaskDesk could not be brought to the front again: ${activated.result.failure.message}`)
    })
    // The runner's display capture shows the overlay over TaskDesk, so the window's image has something to leave out.
    // It holds other apps' windows, so it stays in memory and only this share of it is kept.
    const display = await executor.screenshot({ timeoutMs: 20_000 })
    if (display.status !== 'answered') throw new Error(`The runner's display capture did not answer (${display.status}).`)
    const onScreen = decodePng(display.value)
    const displayScale = onScreen.width / (await mainScreen()).width
    const onDisplay = magentaShare(onScreen, scaled(overlayFrame, displayScale))
    assert.ok(onDisplay > 0.9, `the overlay shows over TaskDesk on the display: ${onDisplay} of its pixels are magenta`)
    const shot = await session.capture(30_000)
    if (!shot.ok) throw new Error(shot.failure.message)
    const image = decodePng(shot.capture.png)
    const scale = image.width / deskFrame.width
    assert.ok(Number.isInteger(scale) && scale >= 1 && image.height === deskFrame.height * scale, `the image is TaskDesk's ${deskFrame.width}x${deskFrame.height}-point window at a whole scale, not ${image.width}x${image.height}`)
    const inWindow = magentaShare(image, scaled({ ...overlayFrame, x: overlayFrame.x - deskFrame.x, y: overlayFrame.y - deskFrame.y }, scale))
    const kept = process.env['RETEST_CAPTURE_PROOF_OUT']
    if (kept !== undefined) {
      await mkdir(kept, { recursive: true })
      await writeFile(join(kept, 'macos-window-under-overlay.png'), shot.capture.png)
      await writeFile(join(kept, 'macos-window-under-overlay.json'), `${JSON.stringify({ deskFrame, overlayFrame, overlayPid: overlay.pid, displayScale, magentaOnDisplay: onDisplay, image: { width: image.width, height: image.height, channels: image.channels }, magentaInWindowImage: inWindow }, null, 2)}\n`)
    }
    assert.equal(inWindow, 0, 'no pixel of the overlay is in the window\'s image')
  })

  test('the window\'s image, measured while TaskDesk is typed into, then recorded: every video frame shows the frame its time maps to', async (t) => {
    const needs = mediaPrerequisites(t)
    if (needs === undefined) return
    const baseline = await typeFor(interaction, 4000)
    assert.deepEqual(baseline.failed, [])
    const measuredSource = interaction.frameSource(identity)
    const looked: CapturedFrame[] = []
    const ended: string[] = []
    const started = await measuredSource.start({ fps: 30, clock: microsecondsSince(performance.now()), deliver: (frame) => looked.push(frame), ended: (reason) => ended.push(reason), timeoutMs: 20_000 })
    t.after(() => measuredSource.stop(20_000))
    t.diagnostic(JSON.stringify({ captureStart: started }))
    const keptRefusal = process.env['RETEST_CAPTURE_PROOF_OUT']
    if (!started.ok && keptRefusal !== undefined) {
      await mkdir(keptRefusal, { recursive: true })
      await writeFile(join(keptRefusal, 'macos-refusal.json'), `${JSON.stringify({ start: started, stats: await measuredSource.stop(20_000) }, null, 2)}\n`)
    }
    assert.deepEqual(started, { ok: true, mode: 'screenshot-loop' })
    const typing = await typeFor(interaction, 4000)
    const stats: CaptureStats = await measuredSource.stop(20_000)
    assert.deepEqual(typing.failed, [], 'every fill went while capture ran')
    assert.deepEqual(ended, [])
    const size = looked[0] === undefined ? undefined : await imageSize(needs.ffprobe, looked[0].bytes, 'png')
    assert.ok(size !== undefined && stats.delivered >= 2, JSON.stringify(stats))

    const folder = await mkdtemp(join(tmpdir(), 'retest-capture-macos-video-'))
    t.after(() => rm(folder, { recursive: true, force: true }))
    const media = await MediaProcess.start({ executable: needs.binary, args: mediaArguments({ ffmpeg: needs.ffmpeg }), startTimeoutMs: 10_000 })
    t.after(() => media.close(10_000))
    const { source, frames } = watched(interaction.frameSource(identity))
    const keptFrames = process.env['RETEST_CAPTURE_PROOF_OUT']
    const stop = new AbortController()
    const options: RecordSourceOptions = { recordingId: 'macos', runId: owner.runId, output: join(folder, 'macos'), width: size.width - (size.width % 2), height: size.height - (size.height % 2), fps: 10, deadlineMs: 30_000, clock: microsecondsSince(performance.now()), startTimeoutMs: 20_000, stopTimeoutMs: 20_000, finishTimeoutMs: 40_000, signal: stop.signal }
    const recording = recordSource(source, media, options)
    t.after(async () => {
      stop.abort()
      await recording
      if (keptFrames === undefined) return
      const raw = join(keptFrames, 'raw')
      await mkdir(raw, { recursive: true })
      for (const [index, frame] of frames.entries()) await writeFile(join(raw, `${index + 1}.png`), frame.bytes)
      await writeFile(join(raw, 'frames.json'), `${JSON.stringify(frames.map((frame, index) => ({ file: `${index + 1}.png`, timestampUs: frame.timestampUs, earliestUs: frame.earliestUs, identity: frame.identity })), null, 2)}\n`)
    })
    const recorded = await typeFor(interaction, 5000)
    stop.abort()
    const report = await recording
    const ending = report.ended
    assert.ok(ending !== undefined, report.reason)
    assert.equal(ending.status, 'ok', ending.message)
    const video = await decodeVideo(needs, ending.path ?? '')
    const ids = shownFrameIds(ending, video.frames.length, options.fps)
    const pictures = await decodeFrames(needs, frames, { width: options.width, height: options.height })
    const matched = matchVideo(video.frames, pictures, ids, { timestampsUs: frames.map(frame => frame.timestampUs), fps: options.fps })
    const measured = { size, loop: stats, baselineFillMs: spread(baseline.durationsMs), capturedFillMs: spread(typing.durationsMs), capture: report.capture, frames: report.frames, gaps: report.gaps, recordedFills: recorded.fills, video: { frames: video.frames.length, fps: video.fps, codec: video.codec }, counts: ending.frames, evidence: ending.evidence, pausesMs: spread(pausesMs(frames)) }
    t.diagnostic(JSON.stringify(measured))
    const kept = process.env['RETEST_CAPTURE_PROOF_OUT']
    if (kept) {
      await mkdir(kept, { recursive: true })
      if (ending.path !== undefined) await copyFile(ending.path, join(kept, `macos-window-crop.${ending.path.split('.').at(-1) ?? 'mp4'}`))
      await writeFile(join(kept, 'macos-window-crop-report.json'), `${JSON.stringify({ measured, margins: matched.matched, frameMap: ending.frameMap }, null, 2)}\n`)
    }

    assert.deepEqual(recorded.failed, [])
    assert.equal(report.source, 'window-crop')
    assert.deepEqual(ending.identity, { runId: owner.runId, ...identity })
    assert.equal(ending.frames.received, report.frames.sent)
    assert.deepEqual(matched.unmapped, [], 'the frame map accounts for every video frame')
    for (const entry of matched.matched) {
      if (entry.nearestOther === undefined) continue
      assert.ok(entry.own < entry.nearestOther, `video frame ${entry.video} is closer to frame ${entry.frame + 1} (${entry.own}) than to any other frame that differs (${entry.nearestOther})`)
    }
  })
})
