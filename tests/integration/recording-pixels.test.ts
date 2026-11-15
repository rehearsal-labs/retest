import type { AttemptRecording } from '../../src/evaluation/frames.ts'
import type { FrameSequence, SequenceFrame } from '../../src/media/protocol.ts'
import type { EventBody } from '../../src/protocol/events.ts'
import type { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'
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
import { Deadline } from '../../src/protocol/deadline.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { AttemptRecorder, RunMedia, startMediaProcess } from '../../src/runner/run-media.ts'
import { launchOwnership } from '../../src/shared/process-system.ts'
import { ArtifactSequences } from '../../src/store/artifacts.ts'
import { launch, openPage, scratchFolder, servePages } from './browser-harness.ts'
import { builtMediaBinary, recordingSkip } from './recording-harness.ts'

type Pixel = readonly number[]

const ffmpeg = process.env['RETEST_TEST_FFMPEG'] ?? '/opt/homebrew/bin/ffmpeg'
// A picture scaled to one pixel: the page before the secret is blue, the secret's page red, the new document green.
const showsBlue = ([red = 0, green = 0, blue = 0]: Pixel): boolean => blue > red + green + 80
const showsRed = ([red = 0, green = 0, blue = 0]: Pixel): boolean => red > green + blue + 80
const showsGreen = ([red = 0, green = 0, blue = 0]: Pixel): boolean => green > red + blue + 80

function pixelOf(frame: SequenceFrame): Pixel {
  return [...execFileSync(ffmpeg, ['-v', 'error', '-f', frame.format === 'png' ? 'png_pipe' : 'jpeg_pipe', '-i', 'pipe:0', '-vf', 'scale=1:1:flags=area', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { input: frame.bytes, timeout: 15000 }).subarray(0, 3)]
}

/**
 * Whether the recording's kept frames, as an AI check reads them, come to hold a frame from `fromUs` on that `shows` a
 * page, within a navigation's default budget. Chrome paints a new document, and sends its frame, when it chooses to:
 * on GitHub's macOS runner, Chrome 156 sent the first frame of a page from under 100 ms to almost 3 s after its
 * navigation answered, the slowest in a fresh process, and a fixed wait of 300 ms before the secret entry often ended
 * first. Retest 0.4.2's start page and Chrome for Testing 153 were as slow there; the headless shell took under 10 ms.
 */
async function keptPicture(recording: AttemptRecording | undefined, fromUs: number, clock: () => number, shows: (pixel: Pixel) => boolean): Promise<boolean> {
  assert.ok(recording?.state === 'recording', 'the recording keeps its frames')
  const deadline = new Deadline(defaultTimeouts.navigation)
  while (!deadline.expired) {
    const kept = await recording.store.frames({ fromUs, toUs: clock(), maxFrames: 16, maxWidth: 64, maxHeight: 48 }, defaultTimeouts.cleanup)
    if (kept.frames.some((frame) => shows(pixelOf(frame)))) return true
    await delay(20) // the store is read again for a frame Chrome has yet to send
  }
  return false
}

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
    location: { executable: process.env['RETEST_TEST_MEDIA_BINARY'] ?? builtMediaBinary, ffmpeg },
    start: async (location, timeoutMs) => {
      const process = await startMediaProcess(location, timeoutMs)
      // Read afresh through the process layer: the media process's group on Unix, the job it was held in on Windows.
      ownership = launchOwnership(process.pid)
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
    emit: event => void events.push(event), timeouts: { start: defaultTimeouts.setup, close: defaultTimeouts.cleanup, leftovers: defaultTimeouts.cleanup }, runFolder,
  })
  t.after(async () => { await recorder?.finish(); assert.equal(await media.close(), undefined); assert.equal(ownership?.remains(), false) })
  recorder = new AttemptRecorder({ media, runId: 'pixel-run', runFolder, ...identity, settings: { ...defaultRecordingSettings, record: true, size: { width: 320, height: 240 } }, records: () => true, withheldFrom: () => undefined, judge: policy, clock, sequences: new ArtifactSequences(), timeouts: { start: defaultTimeouts.setup, stop: defaultTimeouts.cleanup, deadline: defaultTimeouts.cleanup, finish: defaultTimeouts.cleanup + 5000, release: defaultTimeouts.cleanup }, keepFrames: true, emit: event => void events.push(event) })
  await recorder.start([{ app: 'web', page, browser, touch: false, session }])
  assert.deepEqual(ownership?.capture(), [])
  const openedUs = clock()
  assert.ok((await page.execute({ kind: 'goto', url: '/' }, defaultTimeouts.navigation)).ok)
  assert.ok(await keptPicture(recorder.recording('web'), openedUs, clock, showsBlue), 'the recording kept a frame of the page before the secret entry')
  const fact = { kind: 'unread' as const, reason: 'The runner has no field masking fact.' }
  const entry = policy.beginSecretEntry({ identity, secret: 'synthetic', field: 'entry', fact })
  assert.ok((await page.execute({ kind: 'fill', locator: { by: 'testId', value: 'entry' }, value: randomUUID() }, defaultTimeouts.action)).ok, 'the secret input was confirmed')
  policy.endSecretEntry(entry, { fact, input: 'sent' })
  await delay(400)
  const leftUs = clock()
  assert.ok((await page.execute({ kind: 'goto', url: '/safe' }, defaultTimeouts.navigation)).ok)
  policy.pageLeft(identity, 'new_document')
  await Promise.all(restarts)
  assert.ok(await keptPicture(recorder.recording('web'), leftUs, clock, showsGreen), 'the recording kept a frame of the new document')
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
  const rgb = execFileSync(ffmpeg, ['-v', 'error', '-xerror', '-i', join(runFolder, recording.path), '-vf', 'scale=1:1:flags=area', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { timeout: 15000 })
  assert.ok(rgb.length >= 6 && rgb.length % 3 === 0)
  const pixels = Array.from({ length: rgb.length / 3 }, (_, index) => [...rgb.subarray(index * 3, index * 3 + 3)])
  assert.equal(pixels.some(showsRed), false, 'no decoded video frame shows the red secret document')
  assert.ok(pixels.some(showsBlue), 'safe frames before entry were kept')
  assert.ok(pixels.some(showsGreen), 'safe frames after the new document were kept')
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
