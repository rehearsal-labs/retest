import type { TestContextHookFn, TestContext } from 'node:test'
import type { WebSession } from '../../src/browser/contract.ts'
import type { CaptureMode, RecordSourceOptions } from '../../src/media/capture.ts'
import assert from 'node:assert/strict'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { webRuntimeIdentity } from '../../src/browser/contract.ts'
import { firefoxPlatformProblem } from '../../src/browser/firefox/executable.ts'
import { FirefoxPage } from '../../src/browser/firefox/page.ts'
import { WebKitPage } from '../../src/browser/webkit/page.ts'
import { CaptureSuspension, microsecondsSince, recordSource } from '../../src/media/capture.ts'
import { mediaArguments, MediaProcess } from '../../src/media/client.ts'
import { launch, openApp, scratchFolder } from './browser-harness.ts'
import { decodeFrames, decodeVideo, even, imageSize, mediaPrerequisites, pausesMs, shownFrameIds, spread, tickerFrames, tickerServer, videoAgainstTicks, watched } from './capture-proof.ts'

// Node stops later after hooks when one rejects. Capture fixtures must close every owned server and source even
// when browser cleanup fails, then retain all of those failures in the test verdict.
function captureTest(name: string, skip: string | false, body: (context: TestContext) => Promise<void>): void {
  test(name, { skip }, async (context) => {
    const failures: unknown[] = []
    const registerAfter = context.after.bind(context)
    context.after = (hook, options) => {
      registerAfter(async (hookContext) => {
        if (hook === undefined) return
        try { await cleanupHook(hook, hookContext) } catch (error) { failures.push(error) }
      }, options)
    }
    try { await body(context) } finally {
      context.after = registerAfter
      registerAfter(() => {
        if (failures.length > 0) throw new AggregateError(failures, 'Capture fixture cleanup failed. All cleanup hooks were attempted.')
      })
    }
  })
}

function cleanupHook(hook: TestContextHookFn, context: TestContext): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const returned = hook(context, (error) => { if (error === undefined) resolve(); else reject(error) })
      if (hook.length < 2) Promise.resolve(returned).then(() => resolve(), reject)
    } catch (error) { reject(error) }
  })
}

async function namedPage(t: TestContext, engine: 'firefox' | 'webkit'): Promise<{ page: WebSession; identity: { testId: string; attemptId: string; app: string; sessionId: string } }> {
  const browser = await launch(t)
  const page = await browser.newPage({ baseUrl: await tickerServer(t) }, 30_000)
  t.after(() => page.dispose(5000))
  assert.ok(page instanceof FirefoxPage || page instanceof WebKitPage)
  const identity = { testId: `capture-${engine}`, attemptId: `capture-${engine}`, app: 'web', sessionId: `capture-${engine}:web` }
  assert.ok(page.identify !== undefined)
  page.identify({ sessionId: identity.sessionId, owner: { runId: 'capture-sources', ...identity }, runtime: webRuntimeIdentity(browser, engine) })
  assert.ok((await page.execute({ kind: 'goto', url: '/' }, 10_000)).ok)
  const readyBy = performance.now() + 5000
  let ready = false
  while (!ready && performance.now() < readyBy) {
    const observed = await page.execute({ kind: 'observePage' }, 1000)
    ready = observed.ok && observed.kind === 'observePage' && observed.observation.title === 'ticker-ready'
    if (!ready) await sleep(20)
  }
  assert.equal(ready, true, 'the changing fixture painted before capture started')
  assert.ok(page.frameSource !== undefined, `${engine} must expose the contract hook`)
  return { page, identity }
}

// Retest runs Firefox on macOS on Apple silicon and WebKit on macOS; on any other machine the engine never starts.
function engineHostSkip(engine: 'firefox' | 'webkit'): string | false {
  const problem = engine === 'firefox' ? firefoxPlatformProblem() : process.platform === 'darwin' ? undefined : `Retest runs WebKit on macOS only, and this host is ${process.platform}.`
  return problem === undefined ? false : `unverified: ${problem}`
}

export function browserCaptureProof(engine: 'firefox' | 'webkit', mode: CaptureMode): void {
  const skip = engineHostSkip(engine)
  captureTest(`${engine}: changing pixels pass through the contract hook and real media process, and every decoded video frame has its mapped screen state`, skip, async (t) => {
    const needs = mediaPrerequisites(t)
    if (needs === undefined) return
    const { page, identity } = await namedPage(t, engine)
    assert.ok(page.frameSource !== undefined)
    const folder = await scratchFolder(t)
    const size = await imageSize(needs.ffprobe, await page.screenshot(5000), 'png')
    const media = await MediaProcess.start({ executable: needs.binary, args: mediaArguments({ ffmpeg: needs.ffmpeg }), startTimeoutMs: 10_000 })
    t.after(() => media.close(10_000))
    const { source, frames } = watched(page.frameSource(identity))
    assert.deepEqual(source.availability(), { available: true, mode })
    const startedAt = performance.now()
    const epochMs = performance.timeOrigin + startedAt
    const stop = new AbortController()
    const options: RecordSourceOptions = { recordingId: engine, runId: 'capture-sources', output: join(folder, engine), width: even(size.width), height: even(size.height), fps: 30, deadlineMs: 20_000, clock: microsecondsSince(startedAt), startTimeoutMs: 10_000, stopTimeoutMs: 5000, finishTimeoutMs: 30_000, signal: stop.signal }
    const recording = recordSource(source, media, options)
    t.after(async () => { stop.abort(); await recording })
    await sleep(3000)
    stop.abort()
    const report = await recording
    const ending = report.ended
    assert.ok(ending !== undefined, report.reason)
    const kept = process.env['RETEST_CAPTURE_PROOF_OUT']
    if (ending.status !== 'ok' && kept !== undefined) {
      await mkdir(kept, { recursive: true })
      await writeFile(join(kept, `${engine}-failed-recording.json`), `${JSON.stringify(report, null, 2)}\n`)
    }
    assert.equal(ending.status, 'ok', ending.message)
    if (kept !== undefined) {
      const captured = join(kept, `${engine}-captured`)
      await mkdir(captured, { recursive: true })
      for (const [index, frame] of frames.entries()) await writeFile(join(captured, `${index + 1}.${frame.format === 'png' ? 'png' : 'jpg'}`), frame.bytes)
      await writeFile(join(kept, `${engine}-raw-report.json`), `${JSON.stringify({ report, handedOver: frames.map((frame) => ({ timestampUs: frame.timestampUs, earliestUs: frame.earliestUs, byteLength: frame.bytes.byteLength, signature: [...frame.bytes.subarray(0, 12)] })) }, null, 2)}\n`)
    }
    const pictures = await decodeFrames(needs, frames)
    const ticker = tickerFrames(frames, pictures, epochMs)
    const video = await decodeVideo(needs, ending.path ?? '')
    const ids = shownFrameIds(ending, video.frames.length, options.fps)
    const compared = videoAgainstTicks(video.frames, ids, ticker.ticks)
    const measured = { target: engine, size, capture: report.capture, frames: report.frames, gaps: report.gaps, pausesMs: spread(pausesMs(frames)), lagMs: spread(ticker.lagsMs), distinctTicks: ticker.distinct, counts: ending.frames, evidence: ending.evidence, video: { frames: video.frames.length, codec: video.codec, fps: video.fps, checked: compared.checked } }
    t.diagnostic(JSON.stringify(measured))
    if (kept !== undefined) {
      await mkdir(kept, { recursive: true })
      if (ending.path !== undefined) await copyFile(ending.path, join(kept, `${engine}-ticker.mp4`))
      await writeFile(join(kept, `${engine}-ticker-report.json`), `${JSON.stringify({ report, measured, compared, ticker, handedOver: frames.map((frame) => ({ identity: frame.identity, timestampUs: frame.timestampUs, earliestUs: frame.earliestUs, format: frame.format, byteLength: frame.bytes.byteLength })) }, null, 2)}\n`)
    }
    assert.equal(report.status, 'ended')
    assert.equal(report.capture?.mode, mode)
    assert.deepEqual([ticker.unreadable, ticker.future, ticker.backwards], [[], [], []])
    assert.ok(ticker.distinct >= 2)
    assert.ok(frames.every((frame) => frame.identity.sessionId === identity.sessionId))
    assert.equal(ending.frames.received, report.frames.sent)
    assert.equal(ending.frameMapEntries, frames.length)
    assert.equal(ending.frameMapOmitted, 0)
    assert.deepEqual(ending.frameMap.map((entry) => entry.frameId), frames.map((_, index) => String(index + 1)))
    assert.deepEqual(ending.identity, { runId: 'capture-sources', ...identity })
    assert.deepEqual([compared.mismatched, compared.unmapped], [[], []])
    assert.ok(compared.checked > 0 && compared.checked === video.frames.length)
    assert.equal(report.capture?.dropped, 0)
    assert.equal(report.frames.sent, frames.length)
    assert.deepEqual(report.problems, [])
  })

  captureTest(`${engine}: real input stays within its budget while capture runs, and stop leaves no new capture`, skip, async (t) => {
    const { page, identity } = await namedPage(t, engine)
    const app = await openApp(t)
    assert.ok((await page.execute({ kind: 'goto', url: app.url }, 10_000)).ok)
    assert.ok(page.frameSource !== undefined)
    const source = page.frameSource(identity)
    let frames = 0
    assert.equal((await source.start({ fps: 30, clock: microsecondsSince(performance.now()), deliver: () => { frames += 1 }, ended: () => assert.fail('capture must run'), timeoutMs: 5000 })).ok, true)
    t.after(() => source.stop(1000))
    const durationsMs: number[] = []
    for (let turn = 1; turn <= 5; turn++) {
      const started = performance.now()
      const result = await page.execute({ kind: 'fill', locator: { by: 'testId', value: 'task-title' }, value: `capture tick ${turn}` }, 2000)
      durationsMs.push(performance.now() - started)
      assert.ok(result.ok, JSON.stringify(result))
      assert.ok(durationsMs.at(-1) !== undefined && (durationsMs.at(-1) ?? 2000) < 2000)
    }
    const stoppedAt = performance.now()
    const stats = await source.stop(1000)
    assert.ok(performance.now() - stoppedAt < 1200)
    const final = frames
    await sleep(100)
    assert.equal(frames, final)
    assert.equal(stats.delivered, final)
    t.diagnostic(JSON.stringify({ actions: durationsMs.length, actionMs: spread(durationsMs), capture: stats }))
  })

  captureTest(`${engine}: withholding stops capture requests on the real page and resume captures again`, skip, async (t) => {
    const { page, identity } = await namedPage(t, engine)
    let requests = 0
    let remoteFrames = 0
    let unlisten: (() => void) | undefined
    if (page instanceof FirefoxPage) {
      const original = page.screenshot.bind(page)
      page.screenshot = (ms) => { requests += 1; return original(ms) }
    } else if (page instanceof WebKitPage) {
      const original = page.proxy.bind(page)
      page.proxy = (method, params, options) => { if (method.endsWith('startScreencast')) requests += 1; return original(method, params, options) }
      unlisten = page.onPageProxyEvent(event => { if (event.method === 'Screencast.screencastFrame') remoteFrames += 1 })
    }
    t.after(() => unlisten?.())
    assert.ok(page.frameSource !== undefined)
    const source = page.frameSource(identity)
    const suspension = new CaptureSuspension()
    let delivered = 0
    const gaps: { reason: string }[] = []
    const reasons: string[] = []
    assert.equal((await source.start({ fps: 30, clock: microsecondsSince(performance.now()), timeoutMs: 5000,
      deliver: () => { delivered += 1 }, ended: reason => reasons.push(reason), gap: gap => gaps.push(gap),
      withheld: () => suspension.suspended, onWithholdingChange: listener => suspension.listen(listener) })).ok, true)
    t.after(() => source.stop(5000))
    await sleep(200)
    assert.ok(delivered > 0)
    suspension.suspend()
    await sleep(100)
    const held = { requests, remoteFrames, delivered }
    await sleep(300) // The ticker continues painting throughout withholding.
    assert.deepEqual({ requests, remoteFrames, delivered }, held)
    suspension.resume()
    await sleep(300)
    assert.ok(delivered > held.delivered)
    assert.ok(requests > held.requests)
    assert.ok(gaps.some(gap => gap.reason === 'pixels_withheld'))
    assert.deepEqual(reasons, [])
    assert.deepEqual((await source.stop(5000)).problems, [])
  })

  captureTest(`${engine}: a foreign session identity is refused before capture`, skip, async (t) => {
    const { page, identity } = await namedPage(t, engine)
    assert.ok(page.frameSource !== undefined)
    const source = page.frameSource({ ...identity, sessionId: 'other:web' })
    assert.equal(source.availability().available, false)
    const start = await source.start({ fps: 10, clock: () => 0, timeoutMs: 1000, deliver: () => assert.fail('no foreign frame'), ended: () => assert.fail('nothing started') })
    assert.equal(start.ok, false)
    assert.equal((await source.stop(1000)).delivered, 0)
  })

  captureTest(`${engine}: a source left running ends when its session closes, and delivers no later frame`, skip, async (t) => {
    const { page, identity } = await namedPage(t, engine)
    assert.ok(page.frameSource !== undefined)
    const source = page.frameSource(identity)
    let frames = 0
    const reasons: string[] = []
    assert.equal((await source.start({ fps: 30, clock: microsecondsSince(performance.now()), timeoutMs: 5000, deliver: () => { frames += 1 }, ended: (reason) => reasons.push(reason) })).ok, true)
    t.after(() => source.stop(1000))
    await sleep(200)
    await page.dispose(5000)
    await sleep(100)
    const stats = await source.stop(1000)
    assert.equal(reasons.length, 1)
    assert.ok(stats.endedEarly !== undefined)
    const before = frames
    await sleep(100)
    assert.equal(frames, before)
    assert.equal(stats.delivered, before)
  })
}
