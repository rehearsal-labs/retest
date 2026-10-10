import type { FrameSequence } from '../../src/media/protocol.ts'
import type { EventBody } from '../../src/protocol/events.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { webRuntimeIdentity } from '../../src/browser/contract.ts'
import { ChromiumPage } from '../../src/browser/page.ts'
import { defaultRecordingSettings } from '../../src/config/read-recording.ts'
import { microsecondsSince } from '../../src/media/capture.ts'
import { defaultAppPixelRules, PixelCapturePolicy } from '../../src/media/policy.ts'
import { AttemptRecorder, RunMedia, startMediaProcess } from '../../src/runner/run-media.ts'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'
import { ArtifactSequences } from '../../src/store/artifacts.ts'
import { launch, openPage, scratchFolder, servePages } from './browser-harness.ts'
import { repositoryRoot } from './cli-harness.ts'
import { recordingSkip } from './recording-harness.ts'

// A real capture/runner proof without a judge: the media store is inspected before its frames are released.
test('a real secret fill withholds its pixels from video and kept frames until a new document', { timeout: 60000, skip: recordingSkip }, async t => {
  const site = await servePages(t, {
    '/': `<body style="margin:0;background:#0000ff"><input data-testid="entry" oninput="document.body.style.background='#ff0000'">`,
    '/safe': `<body style="margin:0;background:#00ff00">Safe document`,
  })
  const browser = await launch(t)
  const page = await openPage(t, browser, site.url)
  assert.ok(page instanceof ChromiumPage)
  const identity = { testId: 'pixel-proof', attemptId: 'pixels1', app: 'web', sessionId: 'pixels1:web' }
  const session = { sessionId: identity.sessionId, owner: { runId: 'pixel-run', ...identity }, runtime: webRuntimeIdentity(browser, 'chromium') }
  page.identify(session)
  const runFolder = await scratchFolder(t)
  const clock = microsecondsSince(performance.now())
  const events: EventBody[] = []
  const restarts: Promise<unknown>[] = []
  let recorder: AttemptRecorder | undefined
  const policy = new PixelCapturePolicy({ clock, rules: () => defaultAppPixelRules, record: record => {
    if (record.type === 'capture.withheld') recorder?.withhold(record.sessionId, record.fromUs)
    if (record.type === 'capture.resumed') restarts.push(recorder?.resume(record.sessionId) ?? Promise.resolve())
  } })
  let kept: FrameSequence | undefined
  let queryProblem: string | undefined
  let ownership: OwnedProcessGroup | undefined
  const media = new RunMedia({
    location: { executable: process.env['RETEST_TEST_MEDIA_BINARY'] ?? join(repositoryRoot, 'media/target/release/retest-media'), ffmpeg: process.env['RETEST_TEST_FFMPEG'] ?? '/opt/homebrew/bin/ffmpeg' },
    start: async (location, timeoutMs) => {
      const process = await startMediaProcess(location, timeoutMs)
      ownership = new OwnedProcessGroup(process.pid)
      assert.deepEqual(ownership.capture(), [])
      const release = process.release.bind(process)
      process.release = async (id, budget) => {
        const stretch = policy.stretches()[0]
        if (stretch?.untilUs !== undefined) {
          try { kept = await process.frames(id, { fromUs: stretch.fromUs, toUs: stretch.untilUs, maxFrames: 64, maxWidth: 320, maxHeight: 240 }, budget) }
          catch { queryProblem = 'The kept-frame query failed.' }
        }
        return release(id, budget)
      }
      return process
    },
    emit: event => void events.push(event), timeouts: { start: 10000, close: 5000, leftovers: 1000 }, runFolder,
  })
  t.after(async () => { await recorder?.finish(); assert.equal(await media.close(), undefined); assert.equal(ownership?.remains(), false) })
  recorder = new AttemptRecorder({ media, runId: 'pixel-run', runFolder, ...identity, settings: { ...defaultRecordingSettings, record: true, size: { width: 320, height: 240 } }, records: () => true, withheldFrom: () => undefined, judge: policy, clock, sequences: new ArtifactSequences(), timeouts: { start: 10000, stop: 5000, deadline: 5000, finish: 10000, release: 5000 }, keepFrames: true, emit: event => void events.push(event) })
  await recorder.start([{ app: 'web', page, browser, touch: false, session }])
  assert.deepEqual(ownership?.capture(), [])
  assert.ok((await page.execute({ kind: 'goto', url: '/' }, 5000)).ok)
  await delay(300)
  const fact = { kind: 'unread' as const, reason: 'The runner has no field masking fact.' }
  const entry = policy.beginSecretEntry({ identity, secret: 'synthetic', field: 'entry', fact })
  assert.ok((await page.execute({ kind: 'fill', locator: { by: 'testId', value: 'entry' }, value: randomUUID() }, 5000)).ok, 'the secret input was confirmed')
  policy.endSecretEntry(entry, { fact, input: 'sent' })
  await delay(400)
  assert.ok((await page.execute({ kind: 'goto', url: '/safe' }, 5000)).ok)
  policy.pageLeft(identity, 'new_document')
  await Promise.all(restarts)
  await delay(300)
  const [recording] = await recorder.finish()
  assert.ok(recording?.path)
  assert.equal(recording.status, 'partial')
  assert.ok(recording.gaps.some(gap => gap.code === 'pixels_withheld'))
  assert.ok((recording.withheld?.durationUs ?? 0) > 0)
  assert.equal(queryProblem, undefined)
  assert.ok(kept)
  assert.equal(kept.status, 'ok')
  assert.equal(kept.inInterval, 0, 'the media store received no frame of the secret stretch')
  assert.deepEqual(kept.frames, [])
  assert.ok(kept.stretches.some(stretch => stretch.captureGaps.includes('pixels_withheld')))
  const rgb = execFileSync(process.env['RETEST_TEST_FFMPEG'] ?? '/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-xerror', '-i', join(runFolder, recording.path), '-vf', 'scale=1:1:flags=area', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { timeout: 15000 })
  assert.ok(rgb.length >= 6 && rgb.length % 3 === 0)
  const pixels = Array.from({ length: rgb.length / 3 }, (_, index) => [...rgb.subarray(index * 3, index * 3 + 3)])
  assert.equal(pixels.some(([red = 0, green = 0, blue = 0]) => red > green + blue + 80), false, 'no decoded video frame shows the red secret document')
  assert.ok(pixels.some(([red = 0, green = 0, blue = 0]) => blue > red + green + 80), 'safe frames before entry were kept')
  assert.ok(pixels.some(([red = 0, green = 0, blue = 0]) => green > red + blue + 80), 'safe frames after the new document were kept')
  assert.equal(await media.close(), undefined)
  assert.equal(ownership?.remains(), false)
  const proof = process.env['RETEST_RECORDING_PROOF_OUT']
  if (proof !== undefined) {
    const output = join(proof, 'pixels')
    assert.equal(existsSync(output), false, 'pixel proof folders are never overwritten')
    writeFileSync(join(runFolder, 'recording-proof.json'), JSON.stringify({ runId: 'pixel-run', recording, stretches: policy.stretches(), decodedFrames: pixels.length, redSecretDocumentFrames: 0, keptFramesInStretch: kept.inInterval }, null, 2) + '\n')
    mkdirSync(proof, { recursive: true })
    cpSync(runFolder, output, { recursive: true })
  }
  t.diagnostic(`decoded ${pixels.length} video frames; no secret-stretch frame in the media store`)
})
