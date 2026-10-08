import type { TestContext } from 'node:test'
import type { SessionIdentity } from '../../src/browser/contract.ts'
import type { CapturedFrame, StartCapture } from '../../src/media/capture.ts'
import type { NativeCaptureSession } from '../../src/native/capture.ts'
import type { NativeTools } from '../../src/native/processes.ts'
import type { AppProcessReading, CaptureSource, NativeCapture } from '../../src/native/session.ts'
import type { Failure } from '../../src/protocol/failures.ts'
import type { RecordIdentity } from '../../src/protocol/identity.ts'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { nativeCaptureTargetCheck, nativeFrameSource, sessionFrameSource, sessionRecordIdentity, simulatorDisplayFrameSource } from '../../src/native/capture.ts'
import { grabSimulatorDisplay } from '../../src/native/capture/simulator-display.ts'
import { systemTools } from '../../src/native/processes.ts'

const sessionIdentity: SessionIdentity = {
  sessionId: 'k3v9q0x2mb:phone',
  owner: { runId: 'run-7', testId: 'tests/phone.retest.ts > saves', attemptId: 'k3v9q0x2mb', app: 'phone' },
  runtime: { kind: 'ios-simulator', bundleId: 'dev.retest.fixtures.taskphone', appPath: '/tmp/TaskPhone.app', device: 'iPhone 17', runtime: '26.5', processIds: [] },
}
const identity: RecordIdentity = { testId: 'tests/phone.retest.ts > saves', attemptId: 'k3v9q0x2mb', app: 'phone', sessionId: 'k3v9q0x2mb:phone' }
const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3)

/** A session that answers captures as the test says, and counts them. */
class FakeSession implements NativeCaptureSession {
  readonly identity: SessionIdentity
  constructor(identity: SessionIdentity = sessionIdentity) { this.identity = identity }
  ended = false
  cancelled = false
  appStatus = { generation: 1, expectedRunning: true }
  readonly asked: { timeoutMs: number; source: CaptureSource | undefined }[] = []
  answer: () => { readonly ok: true; readonly capture: NativeCapture } | { readonly ok: false; readonly failure: Failure } = () => ({ ok: true, capture: captureOf(png) })

  capture(timeoutMs: number, options: { readonly source?: CaptureSource; readonly signal?: AbortSignal }): ReturnType<NativeCaptureSession['capture']> {
    this.asked.push({ timeoutMs, source: options.source })
    return Promise.resolve(this.answer())
  }
}

function captureOf(bytes: Uint8Array): NativeCapture {
  return { png: bytes, source: 'executor-screen', width: 1, height: 1, reference: { sessionId: identity.sessionId, instance: 'a1', generation: 1, observationId: 'o1' }, capturedAt: '2026-10-05T12:00:00.000Z' }
}

function capture(frames: CapturedFrame[], ended: string[] = []): StartCapture {
  let now = 0
  return { fps: 50, clock: () => (now += 1000), deliver: (frame) => frames.push(frame), ended: (reason) => ended.push(reason), timeoutMs: 1000 }
}

// A stand-in for xcrun: a script that runs `body` with simctl's arguments, the output path being the sixth.
async function fakeXcrun(t: TestContext, body: string): Promise<{ tools: NativeTools; calls: string }> {
  const folder = await mkdtemp(join(tmpdir(), 'retest-fake-xcrun-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const calls = join(folder, 'calls.txt')
  const script = join(folder, 'xcrun')
  await writeFile(script, `#!/bin/sh\necho "$@" >> '${calls}'\n${body}\n`)
  await chmod(script, 0o755)
  return { tools: { ...systemTools, xcrun: script }, calls }
}

describe('a native session’s own captures as a screenshot loop', () => {
  test('frames are the session’s PNG, untouched, with the session’s own identity, from the source named', async () => {
    const session = new FakeSession()
    const source = sessionFrameSource(session, identity, 'executor-screen')
    assert.deepEqual([source.name, source.availability()], ['executor-screen', { available: true, mode: 'screenshot-loop' }])
    const frames: CapturedFrame[] = []
    assert.deepEqual(await source.start(capture(frames)), { ok: true, mode: 'screenshot-loop' })
    const stats = await source.stop(1000)
    assert.equal(frames[0]?.bytes, png, 'the same bytes the session handed out')
    assert.deepEqual([frames[0]?.format, frames[0]?.identity], ['png', identity])
    assert.equal(frames[0]?.identity.observationId, undefined, 'a native session’s own reference id is never the frame’s look id')
    assert.deepEqual(session.asked[0], { timeoutMs: 1000, source: 'executor-screen' })
    assert.equal(stats.mode, 'screenshot-loop')
  })

  test('a session that is another session gives a source that is unavailable, naming the session it is', () => {
    const source = sessionFrameSource(new FakeSession(), { ...identity, app: 'desk', sessionId: 'k3v9q0x2mb:desk' }, 'executor-screen')
    assert.deepEqual(source.availability(), { available: false, reason: 'This native session is k3v9q0x2mb:phone of "tests/phone.retest.ts > saves", not k3v9q0x2mb:desk of "tests/phone.retest.ts > saves", so Retest records nothing of it as that session.' })
    assert.deepEqual(source.identity, identity, 'the source names the session it is')
  })

  test('a session that is over or cancelled cannot be captured, and one that ends while capture runs ends it', async () => {
    const over = new FakeSession()
    over.ended = true
    assert.deepEqual(sessionFrameSource(over, identity, 'executor-screen').availability(), { available: false, reason: 'The native session is over, so there is nothing more to capture.' })
    const cancelled = new FakeSession()
    cancelled.cancelled = true
    assert.deepEqual(sessionFrameSource(cancelled, identity, 'window-crop').availability(), { available: false, reason: 'The native session was cancelled, so nothing more is captured.' })
    for (const ending of ['lost', 'ended'] as const) {
      const session = new FakeSession()
      const source = sessionFrameSource(session, identity, 'executor-screen')
      const ended: string[] = []
      assert.equal((await source.start(capture([], ended))).ok, true)
      if (ending === 'lost') session.answer = () => ({ ok: false, failure: { class: 'session_lost', message: 'The session is lost: the executor is gone.' } })
      else session.ended = true
      await new Promise((resolve) => setTimeout(resolve, 60))
      const stats = await source.stop(1000)
      assert.equal(ended.length, 1, `a session ${ending} ends capture once`)
      assert.equal(stats.dropped, 0)
    }
  })

  test('a capture the session fails, such as a window another lies over, is a dropped frame named, and capture goes on', async () => {
    const session = new FakeSession()
    const source = sessionFrameSource(session, identity, 'window-crop')
    const frames: CapturedFrame[] = []
    assert.equal((await source.start(capture(frames))).ok, true)
    session.answer = () => ({ ok: false, failure: { class: 'not_actionable', message: 'Another window lies over the app’s window, so Retest captured nothing.' } })
    await new Promise((resolve) => setTimeout(resolve, 60))
    session.answer = () => ({ ok: true, capture: captureOf(png) })
    await new Promise((resolve) => setTimeout(resolve, 60))
    const stats = await source.stop(1000)
    assert.ok(stats.dropped >= 1 && stats.delivered >= 2, JSON.stringify(stats))
    assert.equal(stats.problems[0], 'Another window lies over the app’s window, so Retest captured nothing.')
    assert.equal(stats.endedEarly, undefined)
  })

  test('the record identity comes from the session itself', () => {
    assert.deepEqual(sessionRecordIdentity(sessionIdentity), identity)
    assert.ok(Object.isFrozen(sessionRecordIdentity(sessionIdentity)))
  })
})

describe('the simulator’s display read through simctl', () => {
  test('the file simctl wrote is handed back as it is, asked for in the format named, and its folder removed', async (t) => {
    const { tools, calls } = await fakeXcrun(t, `printf '\\377\\330\\377\\340rest' > "$6"`)
    const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith('retest-display-')))
    const taken = await grabSimulatorDisplay({ tools, udid: 'UDID-1', format: 'jpeg', timeoutMs: 5000, signal: new AbortController().signal })
    assert.ok(taken.ok, JSON.stringify(taken))
    assert.deepEqual([...taken.bytes.subarray(0, 4)], [0xff, 0xd8, 0xff, 0xe0])
    assert.match(await readFile(calls, 'utf8'), /^simctl io UDID-1 screenshot --type=jpeg \S+display\.jpg\n$/)
    const after = (await readdir(tmpdir())).filter((name) => name.startsWith('retest-display-') && !before.has(name))
    assert.deepEqual(after, [], 'nothing is left in the temporary folder')
  })

  test('simctl failing, or writing something that is not the format asked for, is a failed read that says so', async (t) => {
    const failing = await fakeXcrun(t, `echo 'Invalid device: UDID-1' >&2; exit 164`)
    assert.deepEqual(await grabSimulatorDisplay({ tools: failing.tools, udid: 'UDID-1', format: 'png', timeoutMs: 5000, signal: new AbortController().signal }), { ok: false, problem: 'xcrun simctl io screenshot ended with exit code 164: Invalid device: UDID-1' })
    const wrong = await fakeXcrun(t, `printf 'GIF89a' > "$6"`)
    assert.deepEqual(await grabSimulatorDisplay({ tools: wrong.tools, udid: 'UDID-1', format: 'png', timeoutMs: 5000, signal: new AbortController().signal }), { ok: false, problem: 'xcrun simctl io screenshot wrote a file that is not a PNG.' })
  })

  test('a simulator display source hands over simctl’s JPEG untouched, and a session that ends while simctl runs ends capture', async (t) => {
    const { tools } = await fakeXcrun(t, `printf '\\377\\330\\377\\333' > "$6"`)
    const session = new FakeSession()
    const source = simulatorDisplayFrameSource({ session, udid: 'UDID-1', tools, format: 'jpeg' }, identity)
    assert.deepEqual([source.name, source.availability()], ['simulator-display', { available: true, mode: 'screenshot-loop' }])
    const frames: CapturedFrame[] = []
    const ended: string[] = []
    assert.deepEqual(await source.start(capture(frames, ended)), { ok: true, mode: 'screenshot-loop' })
    assert.deepEqual([frames[0]?.format, [...(frames[0]?.bytes ?? [])]], ['jpeg', [0xff, 0xd8, 0xff, 0xdb]])
    assert.equal(session.asked.length, 0, 'the display is read without the session’s request queue')
    session.ended = true
    await new Promise((resolve) => setTimeout(resolve, 200))
    const stats = await source.stop(5000)
    assert.deepEqual(ended, ["The simulator-display capture's target ended: The native session is over, so there is nothing more to capture."])
    assert.equal(stats.endedEarly, ended[0])
  })
})

test('the native hook uses display capture outside the session queue and retains the driver failure', async () => {
  const session = new FakeSession()
  let direct = 0
  const source = nativeFrameSource(session, identity, () => { direct += 1; return Promise.resolve({ status: 'answered', value: png, durationMs: 1 }) }, () => Promise.resolve(undefined))
  const frames: CapturedFrame[] = []
  assert.equal((await source.start(capture(frames))).ok, true)
  await source.stop(1000)
  assert.equal(direct, 1)
  assert.equal(session.asked.length, 0)
  assert.equal(frames[0]?.bytes, png)
  const failed = nativeFrameSource(session, identity, () => Promise.resolve({ status: 'failed', failure: { class: 'not_actionable', message: 'the display could not be read' }, input: 'not_sent' }), () => Promise.resolve(undefined))
  const start = await failed.start(capture([]))
  assert.equal(start.ok, false)
  if (!start.ok) assert.match(start.reason, /the display could not be read/)
})

test('a native source ends when its app stops or its launch changes, including while suspended', async () => {
  for (const change of ['stopped', 'relaunched'] as const) {
    const session = new FakeSession()
    const frames: CapturedFrame[] = []
    const reasons: string[] = []
    let suspended = false
    const source = sessionFrameSource(session, identity, 'executor-screen')
    assert.equal((await source.start({ ...capture(frames, reasons), withheld: () => suspended })).ok, true)
    suspended = true
    if (change === 'stopped') session.appStatus.expectedRunning = false
    else session.appStatus.generation += 1
    await new Promise((resolve) => setTimeout(resolve, 60))
    const stats = await source.stop(1000)
    assert.equal(reasons.length, 1)
    assert.match(reasons[0] ?? '', change === 'stopped' ? /no longer expects its app/ : /app launch changed/)
    assert.equal(frames.length, 1)
    assert.equal(stats.dropped, 0)
    assert.equal(stats.endedEarly, reasons[0])
  }
})

test('a native display source confirms the app before and after pixels, withholding images when confirmation fails', async () => {
  for (const failAt of [1, 2]) {
    const session = new FakeSession()
    let checks = 0
    let grabs = 0
    const frames: CapturedFrame[] = []
    const source = nativeFrameSource(session, identity,
      () => { grabs += 1; return Promise.resolve({ status: 'answered', value: png, durationMs: 1 }) },
      () => { checks += 1; return Promise.resolve(checks === failAt ? { problem: 'The app process could not be confirmed.', gone: true } : undefined) })
    const start = await source.start(capture(frames))
    assert.equal(start.ok, false)
    if (!start.ok) assert.match(start.reason, /app process could not be confirmed/)
    assert.equal(grabs, failAt - 1)
    assert.equal(frames.length, 0)
    await source.stop(1000)
  }
})

test('a native capture that returns after the app ends never delivers those pixels', async () => {
  const session = new FakeSession()
  session.answer = () => { session.appStatus.expectedRunning = false; return { ok: true, capture: captureOf(png) } }
  const frames: CapturedFrame[] = []
  const source = sessionFrameSource(session, identity, 'executor-screen')
  const start = await source.start(capture(frames))
  assert.equal(start.ok, false)
  assert.equal(frames.length, 0)
  await source.stop(1000)
  const cancelled = new FakeSession()
  let asked = 0
  const direct = nativeFrameSource(cancelled, identity,
    () => { asked += 1; return Promise.resolve({ status: 'answered', value: png, durationMs: 1 }) },
    () => { cancelled.cancelled = true; return Promise.resolve(undefined) })
  assert.equal((await direct.start(capture([]))).ok, false)
  assert.equal(asked, 0, 'no pixel command is issued after cancellation during the target check')
  await direct.stop(1000)
})

test('the macOS hook keeps the checked window route and confirms the app around its returned bytes', async () => {
  const session = new FakeSession({ ...sessionIdentity, runtime: { kind: 'macos', bundleId: 'dev.retest.fixtures.taskdesk', appPath: '/tmp/TaskDesk.app', processIds: [] } })
  let checks = 0
  let display = 0
  const source = nativeFrameSource(session, identity,
    () => { display += 1; return Promise.resolve({ status: 'answered', value: png, durationMs: 1 }) },
    () => { checks += 1; return Promise.resolve(undefined) })
  const frames: CapturedFrame[] = []
  assert.equal(source.name, 'window-crop')
  assert.equal((await source.start(capture(frames))).ok, true)
  await source.stop(1000)
  assert.equal(display, 0, 'the simulator display route is never asked on macOS')
  assert.equal(checks, 2)
  assert.equal(session.asked[0]?.source, 'window-crop')
  assert.equal(frames[0]?.bytes, png, 'the checked window PNG is forwarded unchanged')
  session.answer = () => ({ ok: false, failure: { class: 'not_actionable', message: 'A window covers the app, so no pixels are captured.' } })
  const covered = nativeFrameSource(session, identity, () => Promise.reject(new Error('not the macOS route')), () => Promise.resolve(undefined))
  const refused = await covered.start(capture([]))
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.match(refused.reason, /A window covers the app/)
  await covered.stop(1000)
})

const desk = { pid: 41, command: '/tmp/TaskDesk.app/Contents/MacOS/TaskDesk', startedAt: 'Thu Oct 8 10:00:00 2026' }
const running: AppProcessReading = { ok: true, running: true, pids: [41], processes: [desk] }
const unread: AppProcessReading = { ok: false, problem: 'lsappinfo find did not finish in time and was ended' }
const unreadProblem = 'The frame source could not confirm its app processes: lsappinfo find did not finish in time and was ended'
const deskRuntime: SessionIdentity['runtime'] = { kind: 'macos', bundleId: 'dev.retest.fixtures.taskdesk', appPath: '/tmp/TaskDesk.app', processIds: [] }

test('a window capture gives its commands its time less the image\'s grace and the reply margin, 4000 ms of a whole 5000', async () => {
  // A start's first capture is given its whole budget up to a capture's 5000 ms; under 1.5 s the commands get 500 ms, or all of it under that.
  for (const [startMs, commandMs] of [[20_000, 4000], [5000, 4000], [3000, 2000], [1000, 500], [200, 200]] as const) {
    const session = new FakeSession({ ...sessionIdentity, runtime: deskRuntime })
    const source = nativeFrameSource(session, identity, () => Promise.reject(new Error('not the macOS route')), () => Promise.resolve(undefined))
    assert.deepEqual(await source.start({ ...capture([]), timeoutMs: startMs }), { ok: true, mode: 'screenshot-loop' })
    await source.stop(1000)
    const asked = session.asked[0]?.timeoutMs ?? 0
    assert.ok(asked <= commandMs && asked >= commandMs - 5, `a start of ${startMs} ms gave the capture ${asked} ms, not ${commandMs}`)
  }
})

test('a recording start asks again within its budget when a process reading could not be taken, on either route', async () => {
  for (const runtime of [sessionIdentity.runtime, deskRuntime]) {
    for (const unreadAt of [1, 2]) {
      const session = new FakeSession({ ...sessionIdentity, runtime })
      let readings = 0
      let displayed = 0
      const check = nativeCaptureTargetCheck({ processState: () => { readings += 1; return Promise.resolve(readings === unreadAt ? unread : running) } }, (entry) => entry.pid === 41)
      const source = nativeFrameSource(session, identity, () => { displayed += 1; return Promise.resolve({ status: 'answered', value: png, durationMs: 1 }) }, check)
      const frames: CapturedFrame[] = []
      assert.deepEqual(await source.start(capture(frames)), { ok: true, mode: 'screenshot-loop' }, `${source.name}, reading ${unreadAt} unread`)
      const stats = await source.stop(1000)
      assert.equal(frames.length, 1)
      assert.equal(frames[0]?.bytes, png)
      assert.equal(stats.dropped, 1)
      assert.deepEqual(stats.problems, [unreadProblem])
      assert.equal(displayed + session.asked.length, unreadAt, 'the pixels taken before a failed reading are asked for again, never handed over')
    }
    const session = new FakeSession({ ...sessionIdentity, runtime })
    let readings = 0
    let displayed = 0
    const check = nativeCaptureTargetCheck({ processState: () => { readings += 1; return Promise.resolve(unread) } }, (entry) => entry.pid === 41)
    const source = nativeFrameSource(session, identity, () => { displayed += 1; return Promise.resolve({ status: 'answered', value: png, durationMs: 1 }) }, check)
    const frames: CapturedFrame[] = []
    const asked = performance.now()
    assert.deepEqual(await source.start({ ...capture(frames), timeoutMs: 200 }), { ok: false, reason: `The first ${source.name} capture failed: ${unreadProblem}` })
    assert.ok(performance.now() - asked >= 199, 'the start asks again until its own budget is spent')
    assert.ok(readings > 1, `the start asked ${readings} times`)
    assert.equal(displayed + session.asked.length, 0, 'no pixels are asked for while the app is unconfirmed')
    assert.equal(frames.length, 0)
    await source.stop(1000)
  }
})

test('a process reading that could not be taken drops that frame and capture goes on, while a reading that the app is gone ends it', async () => {
  const endings: readonly { readonly reading: AppProcessReading; readonly reason: string }[] = [
    { reading: { ok: true, running: false, pids: [], processes: [] }, reason: 'The frame source\'s app processes are no longer running.' },
    { reading: { ok: true, running: true, pids: [52], processes: [{ ...desk, pid: 52 }] }, reason: 'The frame source found an app process outside this session\'s current launch, so it captures nothing.' },
  ]
  for (const ending of endings) {
    const session: FakeSession = new FakeSession({ ...sessionIdentity, runtime: deskRuntime })
    // Readings queued here answer the next checks in order; once they are used up, `steady` answers.
    const next: AppProcessReading[] = []
    let steady: AppProcessReading = running
    const check = nativeCaptureTargetCheck({ processState: () => Promise.resolve(next.shift() ?? steady) }, (entry) => entry.pid === 41)
    const source = nativeFrameSource(session, identity, () => Promise.reject(new Error('not the macOS route')), check)
    const frames: CapturedFrame[] = []
    const ended: string[] = []
    assert.equal((await source.start(capture(frames, ended))).ok, true)
    next.push(unread)
    await until(() => frames.length >= 2 || ended.length > 0, 'a frame after a reading that failed before the pixels')
    assert.deepEqual(ended, [], 'a reading that failed before the pixels does not end capture')
    next.push(running, unread)
    await until(() => frames.length >= 3 || ended.length > 0, 'a frame after a reading that failed after the pixels')
    assert.deepEqual(ended, [], 'a reading that failed after the pixels does not end capture')
    assert.equal(session.asked.length, frames.length + 1, 'the pixels taken before a failed reading are never handed over')
    steady = ending.reading
    await until(() => ended.length > 0, 'capture to end')
    const stats = await source.stop(1000)
    assert.deepEqual(ended, [`The window-crop capture's target ended: ${ending.reason}`])
    assert.equal(stats.endedEarly, ended[0])
    assert.equal(stats.dropped, 2)
    assert.equal(stats.delivered, frames.length)
    assert.deepEqual(stats.problems, [unreadProblem, unreadProblem])
  }
})

// Waits on the loop's own cadence until `condition` holds, failing with `what` after two seconds.
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 2000
  while (!condition()) {
    if (performance.now() > deadline) assert.fail(`Timed out waiting for ${what}.`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
