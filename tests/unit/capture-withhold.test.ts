import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { ChromiumFrameSource } from '../../src/browser/capture.ts'
import { WebKitFrameSource } from '../../src/browser/webkit/capture.ts'
import type { PageProxyEvent } from '../../src/browser/webkit/connection.ts'
import { FirefoxFrameSource } from '../../src/browser/firefox/capture.ts'
import { CaptureSuspension, ScreenshotLoopSource, microsecondsSince } from '../../src/media/capture.ts'
import type { CapturedFrame, SourceGap, StartCapture } from '../../src/media/capture.ts'
import { systemTools } from '../../src/native/processes.ts'
import { nativeFrameSource, sessionFrameSource, simulatorDisplayFrameSource } from '../../src/native/capture.ts'
import type { NativeCaptureSession, NativeTargetProblem } from '../../src/native/capture.ts'
import type { SessionIdentity } from '../../src/browser/contract.ts'
import { PolicedSource } from '../../src/runner/policed-source.ts'
import { PixelCapturePolicy, defaultAppPixelRules } from '../../src/media/policy.ts'

const identity = { testId: 'withhold', attemptId: 'a1', app: 'web', sessionId: 'a1:web' }
const png = Uint8Array.of(137, 80, 78, 71)
function run(suspension: CaptureSuspension, frames: CapturedFrame[] = [], gaps: SourceGap[] = []): StartCapture & { onWithholdingChange: (listener: (held: boolean) => void) => () => void } {
  return { fps: 100, clock: microsecondsSince(performance.now()), timeoutMs: 100,
    deliver: frame => frames.push(frame), ended: () => undefined, gap: gap => gaps.push(gap),
    withheld: () => suspension.suspended, onWithholdingChange: listener => suspension.listen(listener) }
}
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

for (const engine of ['chromium', 'webkit'] as const) {
  test(`${engine} stops pixel requests and acknowledgements while withheld, then restarts`, async () => {
    let running = false
    let reads = 0
    let receive: ((params: unknown) => void) | undefined
    let proxyReceive: ((event: PageProxyEvent) => void) | undefined
    const commands: string[] = []
    const command = async (method: string): Promise<object> => {
      commands.push(method)
      if (method.endsWith('startScreencast')) running = true
      if (method.endsWith('stopScreencast')) running = false
      return method.startsWith('Screencast.start') ? { generation: 1 } : {}
    }
    const source = engine === 'chromium' ? new ChromiumFrameSource({
      id: 'c', detachReason: undefined, blockReason: undefined, send: command,
      on: (_method, listener) => { receive = listener; return () => { receive = undefined } }, onDetach: () => () => undefined,
    }, identity) : new WebKitFrameSource({
      screen: { viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 }, lostReason: undefined, proxy: command,
      onPageProxyEvent: listener => { proxyReceive = listener; return () => { proxyReceive = undefined } }, onLost: () => () => undefined,
    }, identity)
    const arrive = (): void => {
      const params = { sessionId: 1, data: Buffer.from(png).toString('base64') }
      receive?.(params); proxyReceive?.({ method: 'Screencast.screencastFrame', params })
    }
    const request = (): void => { if (running) { reads += 1; arrive() } }
    const suspension = new CaptureSuspension()
    const frames: CapturedFrame[] = []
    const gaps: SourceGap[] = []
    try {
      assert.equal((await source.start(run(suspension, frames, gaps))).ok, true)
      request()
      suspension.suspend()
      await turn()
      const before = reads
      const ackCount = commands.filter(method => method.endsWith('FrameAck')).length
      for (let tick = 0; tick < 4; tick++) request()
      arrive() // A capture dispatched before stop reached the target arrives during withholding.
      assert.equal(reads, before, 'the target cannot read new pixels while its screencast is stopped')
      assert.equal(commands.filter(method => method.endsWith('FrameAck')).length, ackCount, 'no ack permits another capture during withholding')
      assert.equal(frames.length, 1, 'the already dispatched capture is discarded')
      suspension.resume()
      await turn()
      await delay(20)
      request()
      assert.equal(reads, before + 1, 'capture resumes after the stop reply')
      assert.equal(commands.filter(method => method.endsWith('startScreencast')).length, 2)
      assert.ok(gaps.some(gap => gap.reason === 'pixels_withheld'), 'the paused stretch remains evidence loss')
    } finally { await source.stop(100) }
  })

  test(`${engine} starts no screencast while initially withheld`, async () => {
    const commands: string[] = []
    const send = async (method: string): Promise<object> => { commands.push(method); return method.startsWith('Screencast.start') ? { generation: 1 } : {} }
    const source = engine === 'chromium' ? new ChromiumFrameSource({ id: 'c', detachReason: undefined, blockReason: undefined, send, on: () => () => undefined, onDetach: () => () => undefined }, identity)
      : new WebKitFrameSource({ screen: { viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 }, lostReason: undefined, proxy: send, onPageProxyEvent: () => () => undefined, onLost: () => () => undefined }, identity)
    const suspension = new CaptureSuspension(); suspension.suspend()
    try { assert.equal((await source.start(run(suspension))).ok, true); assert.deepEqual(commands, []) }
    finally { await source.stop(100) }
  })
}

function nativeSession(platform: 'ios-simulator' | 'macos', asked: () => void): NativeCaptureSession {
  const runtime: SessionIdentity['runtime'] = platform === 'ios-simulator'
    ? { kind: platform, bundleId: 'fixture', appPath: '/fixture.app', device: 'phone', runtime: '26', processIds: [] }
    : { kind: platform, bundleId: 'fixture', appPath: '/fixture.app', processIds: [] }
  return { identity: { sessionId: identity.sessionId, owner: { runId: 'r', ...identity }, runtime }, ended: false, cancelled: false, appStatus: { generation: 1, expectedRunning: true },
    capture: async () => { asked(); return { ok: true, capture: { png, source: 'window-crop', width: 1, height: 1, capturedAt: '', reference: { sessionId: identity.sessionId, instance: 'i', generation: 1, observationId: 'o' } } } } }
}
for (const platform of ['ios-simulator', 'macos'] as const) {
  test(`${platform} rechecks withholding between its target check and pixel request`, async () => {
    let requests = 0
    const checked = Promise.withResolvers<NativeTargetProblem | undefined>()
    const suspension = new CaptureSuspension()
    const source = nativeFrameSource(nativeSession(platform, () => requests++), identity,
      async () => { requests++; return { status: 'answered', value: png, durationMs: 0 } }, () => checked.promise)
    const starting = source.start(run(suspension))
    suspension.suspend()
    checked.resolve(undefined)
    try { await starting; assert.equal(requests, 0, 'the target check returning cannot authorize pixels after withholding opened') }
    finally { await source.stop(100) }
  })
}

test('a Mac window crop asks the shared display policy before pixels when another session is withheld', async () => {
  let requests = 0
  const session = nativeSession('macos', () => requests++)
  const policy = new PixelCapturePolicy({ rules: () => defaultAppPixelRules, clock: microsecondsSince(performance.now()) })
  const source = new PolicedSource({ open: () => nativeFrameSource(session, identity, async () => { throw new Error('Mac must use crop') }, async () => undefined),
    judge: policy, suspension: new CaptureSuspension(), clock: microsecondsSince(performance.now()), stopTimeoutMs: 100 })
  const suspension = new CaptureSuspension()
  try {
    assert.equal((await source.start(run(suspension))).ok, true)
    policy.beginSecretEntry({ identity: { ...identity, app: 'other', sessionId: 'a1:other' }, secret: 'named', field: 'f', fact: { kind: 'unread', reason: 'no field read' } })
    const before = requests
    await delay(65)
    assert.equal(requests, before, 'a crop on the shared display must ask for no images while any session is withheld')
  } finally { await source.stop(100) }
})

for (const route of ['firefox', 'screenshot-loop', 'executor-screen', 'window-crop', 'simulator-display'] as const) {
  test(`${route} asks for no images on withheld ticks`, async () => {
    let requests = 0
    const session = nativeSession('ios-simulator', () => requests++)
    const source = route === 'firefox' ? new FirefoxFrameSource({ identity, lostReason: undefined, screenshot: async () => { requests++; return png } }, identity)
      : route === 'executor-screen' || route === 'window-crop' ? sessionFrameSource(session, identity, route)
      : route === 'simulator-display' ? simulatorDisplayFrameSource({ session, udid: 'stand-in', format: 'png', tools: { ...systemTools, get xcrun() { requests++; return '/never-called' } } }, identity)
      : new ScreenshotLoopSource({ name: 'chromium', identity, unavailable: () => undefined, grabTimeoutMs: 100, grab: async () => { requests++; return { ok: true, format: 'png', bytes: png } } })
    const suspension = new CaptureSuspension(); suspension.suspend()
    try { assert.equal((await source.start(run(suspension))).ok, true); await delay(45); assert.equal(requests, 0) }
    finally {
      const stats = await source.stop(100)
      assert.equal(stats.captureMs, undefined, 'withheld ticks attempt no grabs')
      assert.deepEqual(stats.problems, [])
    }
  })
}

test('an in-flight screenshot arriving after a closed withheld stretch is discarded and named withheld', async () => {
  const answer = Promise.withResolvers<{ ok: true; format: 'png'; bytes: Uint8Array }>()
  const source = new ScreenshotLoopSource({ name: 'firefox', identity, unavailable: () => undefined, grabTimeoutMs: 100, grab: () => answer.promise })
  const suspension = new CaptureSuspension()
  const frames: CapturedFrame[] = []
  const gaps: SourceGap[] = []
  const starting = source.start(run(suspension, frames, gaps))
  suspension.suspend(); suspension.resume(); answer.resolve({ ok: true, format: 'png', bytes: png })
  try { await starting; assert.deepEqual(frames, []); assert.ok(gaps.some(gap => gap.reason === 'pixels_withheld')) }
  finally { await source.stop(100) }
})


test('withholding does not hide an in-flight target-loss failure', async () => {
  const answer = Promise.withResolvers<{ ok: false; problem: string; lost: true }>()
  const source = new ScreenshotLoopSource({ name: 'firefox', identity, unavailable: () => undefined, grabTimeoutMs: 100, grab: () => answer.promise })
  const suspension = new CaptureSuspension()
  const reasons: string[] = []
  const starting = source.start({ ...run(suspension), ended: reason => reasons.push(reason) })
  suspension.suspend(); answer.resolve({ ok: false, problem: 'target connection lost', lost: true })
  try { assert.equal((await starting).ok, false); assert.match(reasons.join(' '), /target connection lost/) }
  finally { assert.match((await source.stop(100)).endedEarly ?? '', /target connection lost/) }
})

test('PolicedSource sends the source stop as withholding opens, before resume is requested', async () => {
  let stops = 0
  const source = new PolicedSource({ open: () => ({ name: 'chromium', identity, availability: () => ({ available: true, mode: 'screencast' }),
    start: async () => ({ ok: true, mode: 'screencast' }), stop: async () => { stops++; return { mode: 'screencast', requestedFps: 10, delivered: 0, dropped: 0, superseded: 0, problems: [] } } }),
    suspension: new CaptureSuspension(), clock: () => 0, stopTimeoutMs: 100 })
  await source.start(run(new CaptureSuspension()))
  source.withhold()
  try { assert.equal(stops, 1, 'stop dispatch cannot wait until resume') }
  finally { await source.stop(100) }
})

for (const engine of ['chromium', 'webkit'] as const) {
  test(`${engine} retains an unconfirmed pause and refuses to restart`, async () => {
    const commands: string[] = []
    const send = async (method: string): Promise<object> => {
      commands.push(method)
      if (method.endsWith('stopScreencast')) throw new Error('stop reply lost')
      return method.startsWith('Screencast.start') ? { generation: 1 } : {}
    }
    const source = engine === 'chromium' ? new ChromiumFrameSource({ id: 'c', detachReason: undefined, blockReason: undefined, send, on: () => () => undefined, onDetach: () => () => undefined }, identity)
      : new WebKitFrameSource({ screen: { viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 }, lostReason: undefined, proxy: send, onPageProxyEvent: () => () => undefined, onLost: () => () => undefined }, identity)
    const suspension = new CaptureSuspension()
    const reasons: string[] = []
    await source.start({ ...run(suspension), ended: reason => reasons.push(reason) })
    suspension.suspend(); await turn(); suspension.resume(); await turn()
    const stats = await source.stop(100)
    assert.equal(commands.filter(method => method.endsWith('startScreencast')).length, 1)
    assert.match(stats.problems.join(' '), /stop reply lost/)
    assert.match(reasons.join(' '), /withholding could not confirm stopped pixel capture; remote capture is unknown/)
    assert.doesNotMatch(reasons.join(' '), /page.*ended/)
  })

  test(`${engine} does not acknowledge an in-flight frame if withholding opens during final stop`, async () => {
    const stopped = Promise.withResolvers<object>()
    let receive: ((params: unknown) => void) | undefined
    let proxyReceive: ((event: PageProxyEvent) => void) | undefined
    let acknowledgements = 0
    const send = async (method: string): Promise<object> => {
      if (method.endsWith('FrameAck')) acknowledgements++
      if (method.endsWith('stopScreencast')) return stopped.promise
      return method.startsWith('Screencast.start') ? { generation: 1 } : {}
    }
    const source = engine === 'chromium' ? new ChromiumFrameSource({ id: 'c', detachReason: undefined, blockReason: undefined, send, on: (_method, listener) => { receive = listener; return () => undefined }, onDetach: () => () => undefined }, identity)
      : new WebKitFrameSource({ screen: { viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 }, lostReason: undefined, proxy: send, onPageProxyEvent: listener => { proxyReceive = listener; return () => undefined }, onLost: () => () => undefined }, identity)
    const suspension = new CaptureSuspension()
    const frames: CapturedFrame[] = []
    await source.start(run(suspension, frames))
    const stopping = source.stop(100)
    suspension.suspend()
    const params = { sessionId: 1, data: Buffer.from(png).toString('base64') }
    receive?.(params); proxyReceive?.({ method: 'Screencast.screencastFrame', params })
    stopped.resolve({})
    await stopping
    assert.equal(acknowledgements, 0)
    assert.deepEqual(frames, [])
  })
}


test('a refused withheld-gap callback is retained without delivering the in-flight pixels', async () => {
  const answer = Promise.withResolvers<{ ok: true; format: 'png'; bytes: Uint8Array }>()
  const source = new ScreenshotLoopSource({ name: 'firefox', identity, unavailable: () => undefined, grabTimeoutMs: 100, grab: () => answer.promise })
  const suspension = new CaptureSuspension()
  const frames: CapturedFrame[] = []
  const starting = source.start({ ...run(suspension, frames), gap: () => { throw new Error('gap receiver unavailable') } })
  suspension.suspend(); answer.resolve({ ok: true, format: 'png', bytes: png })
  assert.equal((await starting).ok, true)
  const stats = await source.stop(100)
  assert.deepEqual(frames, [])
  assert.match(stats.problems.join(' '), /gap receiver unavailable/)
})

for (const engine of ['chromium', 'webkit'] as const) {
  test(`${engine} stop keeps its own budget while the withholding stop is unanswered`, async () => {
    const send = async (method: string): Promise<object> => {
      if (method.endsWith('stopScreencast')) return new Promise(() => undefined)
      return method.startsWith('Screencast.start') ? { generation: 1 } : {}
    }
    const source = engine === 'chromium' ? new ChromiumFrameSource({ id: 'c', detachReason: undefined, blockReason: undefined, send, on: () => () => undefined, onDetach: () => () => undefined }, identity)
      : new WebKitFrameSource({ screen: { viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 }, lostReason: undefined, proxy: send, onPageProxyEvent: () => () => undefined, onLost: () => () => undefined }, identity)
    const suspension = new CaptureSuspension()
    await source.start({ ...run(suspension), timeoutMs: 1000 })
    suspension.suspend()
    const started = performance.now()
    const stats = await source.stop(20)
    assert.ok(performance.now() - started < 500, 'the separate pause budget cannot hold final stop past its own budget')
    assert.ok(stats.problems.length > 0, 'an unanswered remote pause remains unknown')
  })
}

test('an in-flight Mac crop rejected by another session’s closed stretch records a withheld gap', async () => {
  const session = nativeSession('macos', () => undefined)
  const image = Promise.withResolvers<Awaited<ReturnType<NativeCaptureSession['capture']>>>()
  const original = session.capture.bind(session)
  session.capture = () => image.promise
  const clock = microsecondsSince(performance.now())
  const policy = new PixelCapturePolicy({ rules: () => defaultAppPixelRules, clock })
  const source = new PolicedSource({ open: () => nativeFrameSource(session, identity, async () => { throw new Error('must crop') }, async () => undefined),
    judge: policy, suspension: new CaptureSuspension(), clock, stopTimeoutMs: 100 })
  const frames: CapturedFrame[] = []
  const gaps: SourceGap[] = []
  const starting = source.start({ ...run(new CaptureSuspension(), frames, gaps), clock })
  await turn()
  const entry = policy.beginSecretEntry({ identity: { ...identity, app: 'other', sessionId: 'a1:other' }, secret: 'named', field: 'f', fact: { kind: 'unread', reason: 'no field read' } })
  policy.endSecretEntry(entry, { fact: { kind: 'unread', reason: 'no field read' }, input: 'not_sent' })
  image.resolve(await original(100, {}))
  try {
    assert.equal((await starting).ok, true)
    assert.deepEqual(frames, [], 'the overlapping crop is never handed to retention')
    assert.ok(gaps.some(gap => gap.reason === 'pixels_withheld'), 'the rejected capture cannot leave an unexplained missing interval')
  } finally { await source.stop(100) }
})

for (const engine of ['chromium', 'webkit'] as const) {
  test(`${engine} final stop sends a whole protocol timeout within its budget`, async () => {
    let stops = 0
    const send = async (method: string, _params?: object, options?: { timeoutMs?: number }): Promise<object> => {
      if (method.endsWith('stopScreencast')) {
        stops++
        assert.ok(options?.timeoutMs !== undefined && Number.isInteger(options.timeoutMs), 'the protocol requires whole milliseconds')
        assert.ok(options.timeoutMs >= 1 && options.timeoutMs <= 100)
      }
      return method.startsWith('Screencast.start') ? { generation: 1 } : {}
    }
    const source = engine === 'chromium' ? new ChromiumFrameSource({ id: 'c', detachReason: undefined, blockReason: undefined, send, on: () => () => undefined, onDetach: () => () => undefined }, identity)
      : new WebKitFrameSource({ screen: { viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 }, lostReason: undefined, proxy: send, onPageProxyEvent: () => () => undefined, onLost: () => () => undefined }, identity)
    assert.equal((await source.start(run(new CaptureSuspension()))).ok, true)
    const stats = await source.stop(100)
    assert.equal(stops, 1)
    assert.deepEqual(stats.problems, [])
  })
}
