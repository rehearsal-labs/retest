import type { OwnedPage } from '../../src/browser/contract.ts'
import type { TakenPicture } from '../../src/browser/screenshot.ts'
import type { PictureSize, ScreenshotCheckRecord, ScreenshotLook } from '../../src/protocol/screenshot.ts'
import type { PictureCommand } from '../../src/runner/screenshot-baselines.ts'
import type { PagesContext } from '../../src/runner/test-pages.ts'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { readScreenshotCall } from '../../src/assertions/screenshot.ts'
import { allowedPixels, baselineFile, screenshotCheck, screenshotCheckProblem, screenshotNameProblem, screenshotRequestProblem } from '../../src/protocol/screenshot.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { AttemptScreenshots, ScreenshotBaselines } from '../../src/runner/screenshot-baselines.ts'
import { readPng, writePng } from '../../src/shared/png.ts'
import { RunStore } from '../../src/store/run-store.ts'
import { FakeBrowser, FakePage } from '../support/fake-browser.ts'

const page: ScreenshotCheckRecord = { matcher: 'toHaveScreenshot', name: 'page' }
const baseline = 'tests/__screenshots__/a.retest.ts/page-chromium-darwin-arm64.png'
const size = { width: 400, height: 300, scale: 1 }

function compared(differentPixels: number | undefined, expected: PictureSize = size): ScreenshotLook {
  return { baseline, picture: size, settled: true, comparison: { kind: 'compared', expected, ...(differentPixels === undefined ? {} : { differentPixels }) } }
}

test('a screenshot\'s name is one lowercase file name, and its baseline sits beside its test file', () => {
  for (const name of ['dashboard', 'chart-empty', 'step_2', 'v1.2']) assert.equal(screenshotNameProblem(name), undefined, name)
  for (const name of ['Dashboard', 'a/b', '../up', '.hidden', '', 'two words', 'x'.repeat(101)]) assert.ok(screenshotNameProblem(name) !== undefined, name)
  assert.equal(baselineFile({ testFile: 'tests/tasks.retest.ts', name: 'dashboard', engine: 'chromium', platform: 'darwin-arm64' }), 'tests/__screenshots__/tasks.retest.ts/dashboard-chromium-darwin-arm64.png')
  assert.equal(baselineFile({ testFile: 'top.retest.ts', name: 'a', engine: 'webkit', platform: 'linux-x64' }), '__screenshots__/top.retest.ts/a-webkit-linux-x64.png')
  assert.equal(screenshotCheckProblem({ ...page, threshold: 1.5 }), 'The threshold option of toHaveScreenshot() is a colour distance from 0 to 1, received 1.5.')
  assert.equal(screenshotCheckProblem({ ...page, maxDiffPixelRatio: 2 }), 'The maxDiffPixelRatio option of toHaveScreenshot() is a part of the pixels from 0 to 1, received 2.')
  assert.equal(screenshotRequestProblem({ name: '../../../tmp/x' }), "toHaveScreenshot() received the name '../../../tmp/x'. A screenshot's name is lowercase letters, digits, dots, dashes and underscores, starting with a letter or a digit, such as 'dashboard' or 'chart-empty'.")
  assert.equal(screenshotRequestProblem({ name: 'page', threshold: 5 }), 'The threshold option of toHaveScreenshot() is a colour distance from 0 to 1, received 5.')
  assert.equal(screenshotRequestProblem({ name: 'page', threshold: 0.3 }), undefined)
})

test('a limit the test did not give does not count, and with both the smaller holds, as Playwright reads them', () => {
  assert.equal(allowedPixels(page, 1000), 0)
  assert.equal(allowedPixels({ ...page, maxDiffPixels: 50 }, 1000), 50)
  assert.equal(allowedPixels({ ...page, maxDiffPixelRatio: 0.01 }, 1000), 10)
  assert.equal(allowedPixels({ ...page, maxDiffPixels: 50, maxDiffPixelRatio: 0.01 }, 1000), 10)
  assert.equal(allowedPixels({ ...page, maxDiffPixels: 5, maxDiffPixelRatio: 0.01 }, 1000), 5)
})

test('a look passes once its picture settled and stands within the limits against its baseline', () => {
  const check = screenshotCheck(page)
  assert.equal(check.passes(compared(0)), true)
  assert.equal(check.passes(compared(1)), false)
  assert.equal(screenshotCheck({ ...page, maxDiffPixels: 1 }).passes(compared(1)), true)
  assert.equal(check.passes({ ...compared(0), settled: false }), false, 'a picture that has not settled never passes')
  assert.equal(check.passes({ baseline, picture: size, settled: true, comparison: { kind: 'missing' } }), false, 'no baseline never passes')
  assert.equal(check.passes({ baseline, picture: size, settled: true, comparison: { kind: 'update' } }), true, 'a run that updates baselines passes a settled picture')
  assert.equal(check.passes(compared(undefined, { width: 400, height: 299, scale: 1 })), false, 'another size never passes')
  assert.equal(check.passes({ baseline, target: { count: 0 }, settled: false }), false)
  assert.equal(check.passes(compared(0, { width: 400, height: 300 })), false, 'a baseline that records no scale never passes a picture that has one')
})

test('a check looks again after a settled picture that fails, and stops only when nothing later can change it', () => {
  const check = screenshotCheck(page)
  assert.equal(check.done(compared(0)), true, 'a pass')
  assert.equal(check.done(compared(5)), false, 'a settled picture that differs may still change')
  assert.equal(check.done({ ...compared(0), settled: false }), false)
  assert.equal(check.done({ baseline, picture: size, settled: true, comparison: { kind: 'missing' } }), true, 'no baseline')
  assert.equal(check.done({ baseline, picture: size, settled: true, comparison: { kind: 'unreadable', problem: 'The baseline at x is not a picture Retest reads.' } }), true, 'a baseline that cannot be read')
  assert.equal(check.done({ baseline, settled: false, unreadable: 'The browser\'s picture of web is not a PNG Retest reads.' }), true, 'a picture that cannot be read')
})

test('a look that does not pass says why, in a sentence', () => {
  const check = screenshotCheck(page)
  const swatch = { by: 'testId', value: 'swatch' } as const
  const reasons: [ScreenshotLook, string][] = [
    [compared(352), '352 pixels differ from the baseline "page", a ratio of 0.0029 of its 120000 pixels. At most 0 may differ.'],
    [compared(1), '1 pixel differs from the baseline "page", a ratio of under 0.0001 of its 120000 pixels. At most 0 may differ.'],
    [compared(undefined, { width: 400, height: 280, scale: 1 }), 'The picture is 400 by 300 pixels, and the baseline "page" is 400 by 280 pixels.'],
    [compared(undefined, { width: 400, height: 300, scale: 2 }), 'The picture was taken at a device scale factor of 1, and the baseline "page" at 2.'],
    [{ baseline, picture: size, settled: true, comparison: { kind: 'missing' } }, `No baseline named "page" exists at ${baseline}. Run with --update-screenshots to save this picture as the baseline.`],
    [compared(undefined, { width: 400, height: 300 }), 'The baseline "page" records no device scale factor, and the picture was taken at 1. Rewrite it with --update-screenshots.'],
    [{ ...compared(0), settled: false }, 'The page never settled. No two pictures in a row were the same, so Retest compared none with the baseline "page". An animation that never stops cannot be compared.'],
  ]
  for (const [look, message] of reasons) assert.deepEqual(check.unmet(look, undefined), { class: 'check_failed', message })
  const damaged = 'The baseline at tests/__screenshots__/a.retest.ts/page-chromium-darwin-arm64.png is not a picture Retest reads: The PNG\'s IDAT chunk fails its checksum, so the file is damaged.'
  assert.deepEqual(check.unmet({ baseline, picture: size, settled: true, comparison: { kind: 'unreadable', problem: damaged } }, undefined), { class: 'setup_failed', message: damaged })
  assert.deepEqual(check.measured({ baseline, picture: size, settled: true, comparison: { kind: 'unreadable', problem: damaged } }).baselineState, 'unreadable')
  assert.deepEqual(check.unmet({ baseline, settled: false, unreadable: 'The browser\'s picture of web is not a PNG Retest reads.' }, undefined), { class: 'setup_failed', message: 'The browser\'s picture of web is not a PNG Retest reads.' })
  assert.deepEqual(check.unmet({ baseline, target: { count: 0 }, settled: false }, swatch), { class: 'not_found', message: "getByTestId('swatch') matched no element." })
  assert.deepEqual(check.unmet({ baseline, target: { count: 3 }, settled: false }, swatch), { class: 'ambiguous', message: "getByTestId('swatch') matched 3 elements, and toHaveScreenshot needs exactly one." })
  assert.equal(check.unmet({ baseline, target: { count: 1, refused: 'outside' }, settled: false }, swatch).message, "getByTestId('swatch') runs past the viewport, so Retest took no picture of it. Scroll it into view first.")
  assert.deepEqual(check.measured(compared(352)), { name: 'page', baseline, threshold: 0.2, settled: true, picture: size, baselineState: 'compared', expected: size, differentPixels: 352, allowedPixels: 0 })
})

test('what a test passes toHaveScreenshot is read, a .png left off, and anything else refused with a sentence', () => {
  assert.deepEqual(readScreenshotCall('chart.png', { maxDiffPixels: 50, timeout: 2000 }), { record: { matcher: 'toHaveScreenshot', name: 'chart', maxDiffPixels: 50 }, timeoutMs: 2000 })
  assert.deepEqual(readScreenshotCall('chart', undefined), { record: { matcher: 'toHaveScreenshot', name: 'chart' } })
  assert.match(String(readScreenshotCall(3, undefined)), /^toHaveScreenshot\(\) takes the name of its baseline, such as 'dashboard', received 3\.$/)
  assert.match(String(readScreenshotCall('Chart', undefined)), /^toHaveScreenshot\(\) received the name 'Chart'\. A screenshot's name is lowercase letters/)
  assert.match(String(readScreenshotCall('chart', { maxDiff: 5 })), /Its options are threshold, maxDiffPixels, maxDiffPixelRatio and timeout\.$/)
  assert.match(String(readScreenshotCall('chart', { threshold: 2 })), /^The threshold option of toHaveScreenshot\(\) is a colour distance from 0 to 1, received 2\.$/)
  assert.match(String(readScreenshotCall('chart', { maxDiffPixels: 1.5 })), /^The maxDiffPixels option of toHaveScreenshot\(\) is a whole number of pixels from 0, received 1\.5\.$/)
  assert.match(String(readScreenshotCall('chart', { timeout: 0 })), /^The timeout option of toHaveScreenshot\(\) must be a whole number of milliseconds from 1 to/)
})

test('a run writes each baseline once, with its scale, and refuses a second, different picture for it', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'retest-baselines-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const baselines = new ScreenshotBaselines({ rootDir: root, update: true, platform: 'darwin-arm64' })
  const path = baselines.path('tests/a.retest.ts', 'page', 'chromium')
  assert.equal(path, 'tests/__screenshots__/a.retest.ts/page-chromium-darwin-arm64.png')
  assert.deepEqual(baselines.read(path), { ok: false, missing: true })
  const red = { width: 2, height: 1, data: Uint8Array.of(255, 0, 0, 255, 255, 0, 0, 255) }
  assert.deepEqual(baselines.write(path, red, 2), { ok: true, replaced: false, again: false })
  const written = readPng(readFileSync(join(root, path)))
  assert.deepEqual([written.width, written.height, written.text['retest:scale']], [2, 1, '2'])
  const read = baselines.read(path)
  assert.ok(read.ok && read.scale === 2)
  assert.deepEqual(baselines.write(path, red, 2), { ok: true, replaced: true, again: true }, 'the same picture again writes nothing more')
  const blue = { width: 2, height: 1, data: Uint8Array.of(0, 0, 255, 255, 0, 0, 255, 255) }
  const conflict = baselines.write(path, blue, 2)
  assert.ok(!conflict.ok && conflict.failure.class === 'usage' && /Two checks in this run took different pictures for the baseline at tests\/__screenshots__\/a\.retest\.ts\/page-chromium-darwin-arm64\.png/.test(conflict.failure.message))
  assert.equal(baselines.written, 1)
  writeFileSync(join(root, 'tests/__screenshots__/a.retest.ts/broken-chromium-darwin-arm64.png'), 'not a picture')
  const broken = baselines.read('tests/__screenshots__/a.retest.ts/broken-chromium-darwin-arm64.png')
  assert.ok(!broken.ok && !broken.missing && /is not a picture Retest reads: The file is not a PNG/.test(broken.problem))
})

test('two checks of one name keep their own pictures until each is judged, settle only 100 ms apart, and an unreadable picture ends the check', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'retest-pictures-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const store = RunStore.create(join(folder, 'run'))
  t.after(() => store.close())
  const context: PagesContext = {
    store,
    timeouts: defaultTimeouts,
    stopped: new Promise<void>(() => undefined),
    interruption: () => undefined,
    connected: () => true,
    release: () => undefined,
    named: true,
    emit: () => undefined,
    redact: (text) => text,
    testId: 'tests/a.retest.ts > a',
    attemptId: 'attempt1',
  }
  const browser = new FakeBrowser({}, { executablePath: '/fake/chromium', logFile: join(folder, 'browser.log'), headless: true })
  const red = { width: 2, height: 1, data: Uint8Array.of(255, 0, 0, 255, 255, 0, 0, 255) }
  class PicturePage extends FakePage {
    override async screenshot(): Promise<Uint8Array> {
      return writePng(red)
    }
  }
  const pages: Record<string, OwnedPage> = { web: new PicturePage(browser, {}), broken: new FakePage(browser, {}) }
  const screenshots = new AttemptScreenshots({
    baselines: new ScreenshotBaselines({ rootDir: folder, update: false, platform: 'test' }),
    context,
    app: (app) => {
      const found = pages[app]
      return found === undefined ? undefined : { page: found, engine: 'chromium', source: 'chromium' }
    },
    testFile: 'tests/a.retest.ts',
  })
  const look = async (app: string, observationId: string, previous?: string): Promise<ScreenshotLook> => {
    const command: PictureCommand = { kind: 'observeScreenshot', name: 'page', check: true, ...(previous === undefined ? {} : { previous }) }
    const taken = await screenshots.take(app, command, 1000, new AbortController().signal)
    assert.ok(taken.ok, JSON.stringify(taken))
    screenshots.keep({ observationId, app, command, look: taken.look, picture: taken.picture })
    return taken.look
  }
  await look('web', 'o1')
  await look('web', 'o2')
  assert.equal((await look('web', 'o3', 'o2')).settled, false, 'two pictures closer than 100 ms do not settle')
  await delay(110)
  const [checkA, checkB] = [await look('web', 'o4', 'o1'), await look('web', 'o5', 'o3')]
  assert.deepEqual([checkA.settled, checkA.comparison, checkB.settled], [true, { kind: 'missing' }, true])
  assert.equal((await look('web', 'o6', 'o1')).settled, false, 'a look already followed is followed once')
  // The deadline cuts the last wait short, so the last look can come a few milliseconds after a settled one; it stays
  // settled, since the pictures have been the same for longer than settling needs.
  await delay(20)
  const last = await look('web', 'o8', 'o5')
  assert.deepEqual([last.settled, last.steady], [true, undefined], 'a picture taken 20 ms after a settled one of the same pixels is settled')
  // Check A's settled picture is still held after check B's looks: judged, it leaves its picture as the candidate.
  const judgedA = screenshots.settle({ passed: false, check: { matcher: 'toHaveScreenshot', name: 'page' }, observationId: 'o4' })
  assert.deepEqual(judgedA.attachments?.map((attachment) => attachment.name), ['actual'])
  assert.deepEqual(readPng(readFileSync(join(store.directory, judgedA.attachments?.[0]?.path ?? ''))).data, red.data)
  const unreadable = await look('broken', 'o7')
  assert.match(unreadable.unreadable ?? '', /^The browser's picture of broken is not a PNG Retest reads: The file is not a PNG/)
  assert.equal(screenshotCheck({ matcher: 'toHaveScreenshot', name: 'page' }).done(unreadable), true)
})

test('a picture of another size or scale than its baseline fails on the first picture, without waiting for a second', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'retest-pictures-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const store = RunStore.create(join(folder, 'run'))
  t.after(() => store.close())
  const context: PagesContext = {
    store,
    timeouts: defaultTimeouts,
    stopped: new Promise<void>(() => undefined),
    interruption: () => undefined,
    connected: () => true,
    release: () => undefined,
    named: true,
    emit: () => undefined,
    redact: (text) => text,
    testId: 'tests/a.retest.ts > a',
    attemptId: 'attempt1',
  }
  const baselines = new ScreenshotBaselines({ rootDir: folder, update: false, platform: 'test' })
  const path = baselines.path('tests/a.retest.ts', 'page', 'chromium')
  mkdirSync(join(folder, path, '..'), { recursive: true })
  writeFileSync(join(folder, path), writePng({ width: 3, height: 1, data: new Uint8Array(12).fill(255) }, { text: { 'retest:scale': '1' } }))
  const browser = new FakeBrowser({}, { executablePath: '/fake/chromium', logFile: join(folder, 'browser.log'), headless: true })
  // A page that takes its pictures as Chromium's does, at a scale it tells.
  class ScaledPage extends FakePage {
    width = 3
    scale = 1
    async takePicture(): Promise<TakenPicture> {
      return { ok: true, png: writePng({ width: this.width, height: 1, data: new Uint8Array(this.width * 4).fill(255) }), scale: this.scale }
    }
  }
  const narrow = new ScaledPage(browser, {})
  narrow.width = 2
  const sharp = new ScaledPage(browser, {})
  sharp.scale = 2
  const pages: Record<string, OwnedPage> = { narrow, sharp }
  const screenshots = new AttemptScreenshots({
    baselines,
    context,
    app: (app) => {
      const found = pages[app]
      return found === undefined ? undefined : { page: found, engine: 'chromium', source: 'chromium' }
    },
    testFile: 'tests/a.retest.ts',
  })
  const check = screenshotCheck({ matcher: 'toHaveScreenshot', name: 'page' })
  const first = async (app: string): Promise<ScreenshotLook> => {
    const taken = await screenshots.take(app, { kind: 'observeScreenshot', name: 'page', check: true }, 1000, new AbortController().signal)
    assert.ok(taken.ok, JSON.stringify(taken))
    return taken.look
  }
  const sized = await first('narrow')
  assert.deepEqual([sized.first, sized.settled, check.done(sized)], [true, false, true], 'a page of another size is told on its first picture')
  assert.deepEqual(check.unmet(sized, undefined), { class: 'check_failed', message: 'The picture is 2 by 1 pixels, and the baseline "page" is 3 by 1 pixels.' })
  const scaled = await first('sharp')
  assert.deepEqual([scaled.first, scaled.settled, check.done(scaled)], [true, false, true], 'a picture at another scale is told on its first picture')
  assert.deepEqual(check.unmet(scaled, undefined), { class: 'check_failed', message: 'The picture was taken at a device scale factor of 2, and the baseline "page" at 1.' })
  const element: ScreenshotLook = { ...sized, target: { count: 1 } }
  assert.equal(check.done(element), false, 'an element whose box can still change is looked at again')
})

test('a check that never settled says why: one picture only, the same for too short a time, or no two alike', () => {
  const check = screenshotCheck(page)
  const swatch = { by: 'testId', value: 'swatch' } as const
  assert.equal(check.unmet({ baseline, picture: size, settled: false, first: true }, undefined).message, 'Only one picture of the page was taken in the time allowed, so Retest could not tell whether it had settled, and compared none with the baseline "page".')
  assert.equal(check.unmet({ baseline, picture: size, settled: false, first: true }, swatch).message, "Only one picture of getByTestId('swatch') was taken in the time allowed, so Retest could not tell whether it had settled, and compared none with the baseline \"page\".")
  assert.equal(check.unmet({ baseline, picture: size, settled: false, steady: { forMs: 850, neededMs: 1000 } }, undefined).message, 'The page had stayed the same for 850 ms when the time ran out, and a picture settles after 1000 ms, so Retest compared none with the baseline "page".')
  assert.match(check.unmet({ baseline, picture: size, settled: false }, undefined).message, /^The page never settled\. No two pictures in a row were the same/)
})
