import type { OwnedBrowser, OwnedPage } from '../../../src/browser/contract.ts'
import type { CapturedFrame } from '../../../src/media/capture.ts'
import type { Observation } from '../../../src/protocol/commands.ts'
import type { LocatorRecipe } from '../../../src/protocol/locator.ts'
import type { EngineName } from '../../../tests/integration/engines.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { webRuntimeIdentity } from '../../../src/browser/contract.ts'
import { ChromiumPage } from '../../../src/browser/page.ts'
import { AttemptDiagnostics } from '../../../src/diagnostics/attempt.ts'
import { defaultDiagnosticsPolicy } from '../../../src/diagnostics/policy.ts'
import { decodePng } from '../../../src/native/png.ts'
import { defaultDiagnosticLimits } from '../../../src/protocol/diagnostics.ts'
import { formatSessionId } from '../../../src/protocol/evidence.ts'
import { Redactor } from '../../../src/runner/redactor.ts'
import { engineUnderTest } from '../../../tests/integration/engines.ts'
import { startTaskApp } from '../../task-app/server.ts'
import { serveScene } from './scenes.ts'

// Captures the corpus's browser evidence from real browsers: screenshots of the task app's scenes on Chrome, Firefox
// and WebKit, the text those pages show, Chrome's screencast frames of the scenes that change over time, and the
// diagnostics records Chrome's collector keeps of two pages. Run it from the Retest root, under the heavy-gate lock,
// since it starts real browsers:
//
//   lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_FIREFOX_ROUTE=launch-services node --conditions=retest-source fixtures/evaluation-corpus/capture/capture-browsers.ts
//
// (Firefox goes through Launch Services on the founder's Mac, where the host app may not start it as a child.)
//
// It writes into fixtures/evaluation-corpus/captures/ and replaces what is there, with capture-browsers.json naming
// each browser's build, or why an engine could not be captured; one engine failing leaves the others' captures. The
// corpus's case list never changes with it: a case names its files, and the corpus test checks every file a case
// names exists and reads as the image it claims.

const corpusRoot = resolve(import.meta.dirname, '..')
const capturesRoot = join(corpusRoot, 'captures')
const typedTitle = 'Release checklist'
const longTitle = 'Release checklist for the October launch of Retest and its media process'
const titleField: LocatorRecipe = { by: 'testId', value: 'task-title' }
const saveButton: LocatorRecipe = { by: 'testId', value: 'save-task' }
const savedMessage: LocatorRecipe = { by: 'testId', value: 'saved-task' }
const mainArea: LocatorRecipe = { by: 'css', selector: 'main' }

type Viewport = { width: number; height: number }
type Shot = { scene: string; name: string; engines: readonly EngineName[]; viewport: Viewport; title?: string; waitFor: (saved: string) => boolean; settleMs?: number }
type FramesCapture = { scene: string; viewport: Viewport; recordMs: number; title?: string }

const desktop: Viewport = { width: 800, height: 600 }
const ended = (text: string): boolean => text !== '' && text !== 'Saving…'

const shots: readonly Shot[] = [
  { scene: 'saved', name: 'saved', engines: ['chromium', 'firefox', 'webkit'], viewport: desktop, waitFor: ended },
  { scene: 'saved-wrong', name: 'saved-wrong', engines: ['chromium', 'webkit'], viewport: desktop, waitFor: ended },
  { scene: 'save-failed', name: 'save-failed', engines: ['webkit'], viewport: desktop, waitFor: ended },
  { scene: 'saving', name: 'saving', engines: ['chromium'], viewport: desktop, waitFor: (text) => text === 'Saving…' },
  { scene: 'clipped', name: 'clipped', engines: ['firefox'], viewport: desktop, title: longTitle, waitFor: ended },
  { scene: 'injection', name: 'injection', engines: ['chromium', 'webkit'], viewport: desktop, waitFor: ended, settleMs: 300 },
  { scene: 'covered', name: 'covered', engines: ['chromium'], viewport: desktop, waitFor: ended, settleMs: 300 },
  { scene: 'saved', name: 'saved-short-viewport', engines: ['chromium'], viewport: { width: 800, height: 130 }, waitFor: ended },
]

const frameCaptures: readonly FramesCapture[] = [
  { scene: 'toast', viewport: { width: 640, height: 400 }, recordMs: 2600 },
  { scene: 'toast-wrong', viewport: { width: 640, height: 400 }, recordMs: 2600 },
  { scene: 'error-flash', viewport: { width: 640, height: 400 }, recordMs: 2600 },
  { scene: 'injection-frames', viewport: { width: 640, height: 400 }, recordMs: 2600 },
  { scene: 'spinner', viewport: { width: 640, height: 400 }, recordMs: 3000 },
]

// What each engine came to: its build when it ran, or why it did not, so a case never names a capture that was not made.
type Built = { engine: EngineName; product: string; version: string } | { engine: EngineName; failed: string }

async function main(): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), 'retest-corpus-capture-'))
  const built: Built[] = []
  const texts: Record<string, string> = {}
  try {
    for (const folder of ['screenshots', 'text', 'frames', 'diagnostics']) {
      rmSync(join(capturesRoot, folder), { recursive: true, force: true })
      mkdirSync(join(capturesRoot, folder), { recursive: true })
    }
    for (const engine of ['chromium', 'firefox', 'webkit'] as const) {
      try {
        await captureEngine(engine, scratch, texts, built)
      } catch (error) {
        const failed = error instanceof Error ? error.message : String(error)
        console.log(`${engine}: capture failed: ${failed}`)
        built.push({ engine, failed })
      }
    }
    for (const [name, text] of Object.entries(texts)) writeFileSync(join(capturesRoot, 'text', `${name}.txt`), text)
    writeFileSync(join(capturesRoot, 'capture-browsers.json'), `${JSON.stringify({ capturedAt: new Date().toISOString(), command: 'lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_FIREFOX_ROUTE=launch-services node --conditions=retest-source fixtures/evaluation-corpus/capture/capture-browsers.ts', platform: `${process.platform}-${process.arch}`, node: process.version, browsers: built }, null, 2)}\n`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

async function captureEngine(engine: EngineName, scratch: string, texts: Record<string, string>, built: Built[]): Promise<void> {
  const browser = await engineNamed(engine).launch({ logFile: join(scratch, `${engine}.log`), headless: true }, 60_000)
  try {
    for (const shot of shots.filter((each) => each.engines.includes(engine))) {
      const { saved, main } = await captureShot(browser, engine, shot)
      if (engine === 'chromium') texts[shot.name] = main
      else texts[`${shot.name}-${engine}`] = saved
    }
    if (engine === 'chromium') {
      for (const capture of frameCaptures) await captureFrames(browser, capture)
      await captureDiagnostics(browser)
    }
    built.push({ engine, product: browser.product, version: browser.version })
  } finally {
    await browser.close(10_000)
  }
}

function engineNamed(name: EngineName): ReturnType<typeof engineUnderTest> {
  const saved = process.env['RETEST_TEST_ENGINE']
  process.env['RETEST_TEST_ENGINE'] = name
  try {
    return engineUnderTest()
  } finally {
    if (saved === undefined) delete process.env['RETEST_TEST_ENGINE']
    else process.env['RETEST_TEST_ENGINE'] = saved
  }
}

async function openScene(browser: OwnedBrowser, url: string, viewport: Viewport): Promise<OwnedPage> {
  const page = await browser.newPage({ baseUrl: url, emulation: { viewport, deviceScaleFactor: 1, touch: false, isMobile: false } }, 30_000)
  await expectOk(page.execute({ kind: 'goto', url: '/' }, 15_000), 'goto')
  return page
}

async function saveTask(page: OwnedPage, title: string): Promise<void> {
  await expectOk(page.execute({ kind: 'fill', locator: titleField, value: title }, 5000), 'fill')
  await expectOk(page.execute({ kind: 'click', locator: saveButton }, 5000), 'click')
}

async function captureShot(browser: OwnedBrowser, engine: EngineName, shot: Shot): Promise<{ saved: string; main: string }> {
  const server = await serveScene(shot.scene)
  const page = await openScene(browser, server.url, shot.viewport)
  try {
    await saveTask(page, shot.title ?? typedTitle)
    const saved = await waitForText(page, shot.waitFor)
    await delay(shot.settleMs ?? 150)
    const png = await page.screenshot(10_000)
    writeFileSync(join(capturesRoot, 'screenshots', `${engine}-${shot.name}.png`), png)
    const main = (await look(page, mainArea)).text ?? ''
    console.log(`screenshot ${engine}-${shot.name}: ${png.byteLength} bytes, saved message ${JSON.stringify(saved)}`)
    return { saved, main }
  } finally {
    await page.dispose(5000)
    await server.close()
  }
}

// Chrome's screencast of the scene from just before the save until `recordMs` after it, each frame on a clock that
// starts when the page was opened, in whole microseconds, as the run's clock would stamp it.
async function captureFrames(browser: OwnedBrowser, capture: FramesCapture): Promise<void> {
  const server = await serveScene(capture.scene)
  const opened = await openScene(browser, server.url, capture.viewport)
  try {
    if (!(opened instanceof ChromiumPage)) throw new Error('Frames are captured from Chrome only.')
    const zero = performance.now()
    const clock = (): number => Math.round((performance.now() - zero) * 1000)
    const attemptId = 'corpus1'
    const identity = { testId: `corpus > ${capture.scene}`, attemptId, app: 'web', sessionId: formatSessionId(attemptId, 'web') }
    opened.identify({ sessionId: identity.sessionId, owner: { runId: 'corpus', testId: identity.testId, attemptId, app: 'web' }, runtime: webRuntimeIdentity(browser, 'chromium') })
    const frames: CapturedFrame[] = []
    const source = opened.frameSource(identity, { format: 'png', maxWidth: capture.viewport.width, maxHeight: capture.viewport.height })
    const started = await source.start({ fps: 10, clock, deliver: (frame) => void frames.push(frame), ended: (reason) => console.log(`capture of ${capture.scene} ended early: ${reason}`), timeoutMs: 5000 })
    if (!started.ok) throw new Error(`The screencast of ${capture.scene} did not start: ${started.reason}`)
    await expectOk(opened.execute({ kind: 'fill', locator: titleField, value: capture.title ?? typedTitle }, 5000), 'fill')
    await delay(300)
    const clickUs = clock()
    await expectOk(opened.execute({ kind: 'click', locator: saveButton }, 5000), 'click')
    await delay(capture.recordMs)
    const endUs = clock()
    const stats = await source.stop(5000)
    const folder = join(capturesRoot, 'frames', capture.scene)
    mkdirSync(folder, { recursive: true })
    const listed = frames.map((frame, index) => {
      const file = `${String(index + 1).padStart(3, '0')}.${frame.format === 'png' ? 'png' : 'jpg'}`
      writeFileSync(join(folder, file), frame.bytes)
      const size = imageSize(frame.bytes)
      return { file, frameId: `${capture.scene}-${index + 1}`, captureUs: frame.timestampUs, format: frame.format, width: size.width, height: size.height, shows: showing(frame.bytes) }
    })
    const manifest = { scene: capture.scene, source: 'chromium', fps: 10, viewport: capture.viewport, clickUs, endUs, frameIntervalUs: 100_000, delivered: stats.delivered, superseded: stats.superseded, dropped: stats.dropped, frames: listed }
    writeFileSync(join(folder, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`frames ${capture.scene}: ${listed.length} frames, click at ${clickUs} µs, ${stats.superseded} superseded`)
  } finally {
    await opened.dispose(5000)
    await server.close()
  }
}

// The records Chrome's own collector keeps, through the attempt diagnostics the runner uses: the task app's
// diagnostics page, whole and under limits small enough to cut it, and the quiet save of the task app's page.
async function captureDiagnostics(browser: OwnedBrowser): Promise<void> {
  const app = await startTaskApp()
  const quiet = await serveScene('saved')
  try {
    await diagnose(browser, app.url, '/diagnostics', 'diagnostics-page', defaultDiagnosticsPolicy)
    const tight = { ...defaultDiagnosticsPolicy, limits: { ...defaultDiagnosticLimits, consoleEntries: 3, requests: 2 } }
    await diagnose(browser, app.url, '/diagnostics', 'diagnostics-page-cut', tight)
    await diagnose(browser, quiet.url, '/', 'quiet-save', defaultDiagnosticsPolicy, true)
  } finally {
    await quiet.close()
    await app.close()
  }
}

async function diagnose(browser: OwnedBrowser, url: string, path: string, name: string, policy: typeof defaultDiagnosticsPolicy, save = false): Promise<void> {
  const page = await browser.newPage({ baseUrl: url, emulation: { viewport: desktop, deviceScaleFactor: 1, touch: false, isMobile: false } }, 30_000)
  const attemptId = 'corpus1'
  const testId = `corpus > ${name}`
  const written = new Map<string, Uint8Array>()
  const diagnostics = new AttemptDiagnostics({ policy, redactor: new Redactor(), writeArtifact: (artifact, bytes) => void written.set(artifact, bytes), emit: () => undefined, testId, attemptId, variant: undefined, named: true })
  try {
    const session = { sessionId: formatSessionId(attemptId, 'web'), owner: { runId: 'corpus', testId, attemptId, app: 'web' }, runtime: webRuntimeIdentity(browser, 'chromium') }
    await diagnostics.start([{ app: 'web', page, session }], 10_000)
    await expectOk(page.execute({ kind: 'goto', url: path }, 15_000), 'goto')
    if (save) {
      await saveTask(page, typedTitle)
      await waitForText(page, ended)
    }
    await delay(1500)
    const finished = await diagnostics.finishNative('attempt_ended')
    const [artifact] = written.values()
    if (artifact === undefined) throw new Error(`No diagnostics artifact for ${name}: ${JSON.stringify(finished.summaries)}`)
    writeFileSync(join(capturesRoot, 'diagnostics', `${name}.jsonl`), artifact)
    console.log(`diagnostics ${name}: ${artifact.byteLength} bytes`)
  } finally {
    await page.dispose(5000)
  }
}

// What a frame shows, read from its pixels by the colours the scenes paint their transient elements in: the toast's
// green, the error banner's red and the injected note's yellow. A fact about the capture, never a model's reading.
const marks: readonly [string, readonly [number, number, number]][] = [
  ['toast', [27, 94, 32]],
  ['error-banner', [176, 0, 32]],
  ['note', [255, 251, 230]],
]

function showing(bytes: Uint8Array): string[] {
  const image = decodePng(bytes)
  return marks.flatMap(([name, [red, green, blue]]) => {
    let count = 0
    for (let index = 0; index + 2 < image.pixels.length; index += image.channels) {
      if (Math.abs((image.pixels[index] ?? 0) - red) <= 3 && Math.abs((image.pixels[index + 1] ?? 0) - green) <= 3 && Math.abs((image.pixels[index + 2] ?? 0) - blue) <= 3) count++
    }
    return count >= 200 ? [name] : []
  })
}

async function look(page: OwnedPage, locator: LocatorRecipe): Promise<Observation> {
  const result = await page.execute({ kind: 'observe', locator }, 5000)
  if (!result.ok || result.kind !== 'observe') throw new Error(`Looking at ${JSON.stringify(locator)} failed: ${JSON.stringify(result)}`)
  return result.observation
}

async function waitForText(page: OwnedPage, until: (text: string) => boolean): Promise<string> {
  const end = performance.now() + 10_000
  for (;;) {
    const text = (await look(page, savedMessage)).text ?? ''
    if (until(text)) return text
    if (performance.now() > end) throw new Error(`The saved message still reads ${JSON.stringify(text)}.`)
    await delay(50)
  }
}

async function expectOk(result: Promise<{ ok: boolean }>, what: string): Promise<void> {
  const answered = await result
  if (!answered.ok) throw new Error(`${what} failed: ${JSON.stringify(answered)}`)
}

// The pixel size of a PNG from its header, or of a JPEG from its first start-of-frame marker.
function imageSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes[0] === 0x89) return { width: view.getUint32(16), height: view.getUint32(20) }
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error('A JPEG marker was expected.')
    const marker = bytes[offset + 1] ?? 0
    const length = view.getUint16(offset + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
    offset += 2 + length
  }
  throw new Error('The JPEG has no start-of-frame marker.')
}

await main()
