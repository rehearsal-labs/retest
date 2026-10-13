import type { TestContext } from 'node:test'
import type { OwnedPage } from '../../src/browser/contract.ts'
import type { PictureRequest, TakenPicture } from '../../src/browser/screenshot.ts'
import type { Emulation } from '../../src/protocol/emulation.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import type { RgbaImage } from '../../src/shared/png.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { readPng } from '../../src/shared/png.ts'
import { assertOk, byTestId, goto, openApp, openPage, scroll, sharedBrowser } from './browser-harness.ts'

// The pictures a screenshot comparison takes on a Chromium page, against the driver: the viewport, one element clipped
// to its box at the page's own scale, an element scrolled into view, whose clip is measured from the document, and
// each element no picture can be taken of. The stable fixture page draws flat colours, so every pixel is known.

const browser = sharedBrowser()

const screen = (deviceScaleFactor: number): Emulation => ({ viewport: { width: 400, height: 300 }, deviceScaleFactor, touch: false, isMobile: false })
const bar = [43, 93, 138]
const swatch = [217, 79, 48]
const far = [74, 43, 138]

async function stablePage(t: TestContext, deviceScaleFactor = 1): Promise<OwnedPage | undefined> {
  const app = await openApp(t)
  const page = await openPage(t, browser(), app.url, { emulation: screen(deviceScaleFactor) })
  if (page.takePicture === undefined) {
    t.skip('this engine takes only whole-viewport screenshots, so it has no picture of one element')
    return undefined
  }
  return page
}

async function take(page: OwnedPage, request: PictureRequest): Promise<TakenPicture> {
  assert.ok(page.takePicture !== undefined)
  return page.takePicture(request, 5000)
}

async function takeOnceShown(page: OwnedPage, locator: LocatorRecipe): Promise<TakenPicture> {
  const end = performance.now() + 3000
  for (;;) {
    const taken = await take(page, { locator })
    if (!(taken.ok && 'target' in taken && taken.target.refused === 'outside') || performance.now() > end) return taken
    await delay(50)
  }
}

function pictureOf(taken: TakenPicture): { image: RgbaImage; taken: Extract<TakenPicture, { png: Uint8Array }> } {
  assert.ok(taken.ok && 'png' in taken, JSON.stringify(taken))
  return { image: readPng(taken.png), taken }
}

// Every pixel of the picture, as RGB, is the one colour.
function allOf(image: RgbaImage, colour: number[]): boolean {
  for (let at = 0; at < image.data.length; at += 4) {
    if (image.data[at] !== colour[0] || image.data[at + 1] !== colour[1] || image.data[at + 2] !== colour[2]) return false
  }
  return true
}

function pixel(image: RgbaImage, x: number, y: number): number[] {
  const at = (y * image.width + x) * 4
  return [...image.data.subarray(at, at + 3)]
}

test('the viewport is pictured whole, at the page\'s scale', async (t) => {
  const page = await stablePage(t)
  if (page === undefined) return
  assertOk(await goto(page, '/stable'))
  const { image, taken } = pictureOf(await take(page, {}))
  assert.deepEqual([image.width, image.height, taken.scale, taken.clip], [400, 300, 1, undefined])
  assert.deepEqual(pixel(image, 10, 10), bar)
  assert.deepEqual(pixel(image, 50, 100), swatch)
})

test('an element is pictured clipped to its box, and at twice the pixels on a screen of scale 2', async (t) => {
  const page = await stablePage(t)
  if (page === undefined) return
  assertOk(await goto(page, '/stable'))
  const { image, taken } = pictureOf(await take(page, { locator: byTestId('swatch') }))
  assert.deepEqual([image.width, image.height, taken.scale], [120, 80, 1])
  assert.deepEqual(taken.clip, { left: 24, top: 64, right: 144, bottom: 144 })
  assert.ok(allOf(image, swatch), 'every pixel is the swatch')
  assert.deepEqual(taken.page?.url.endsWith('/stable'), true)

  const sharp = await stablePage(t, 2)
  if (sharp === undefined) return
  assertOk(await goto(sharp, '/stable'))
  const doubled = pictureOf(await take(sharp, { locator: byTestId('swatch') }))
  assert.deepEqual([doubled.image.width, doubled.image.height, doubled.taken.scale], [240, 160, 2])
  assert.ok(allOf(doubled.image, swatch), 'every pixel is the swatch')
})

test('an element scrolled into view is pictured where it now is, measured from the document', async (t) => {
  const page = await stablePage(t)
  if (page === undefined) return
  assertOk(await goto(page, '/stable?tall=1'))
  const below = await take(page, { locator: byTestId('far') })
  assert.ok(below.ok && 'target' in below, JSON.stringify(below))
  assert.deepEqual(below.target, { count: 1, refused: 'outside' }, 'a picture never scrolls the page to the element')
  assertOk(await scroll(page, undefined, { y: 750 }))
  // The wheel scrolls the page smoothly, so the box comes into view a moment after the wheel event.
  const { image, taken } = pictureOf(await takeOnceShown(page, byTestId('far')))
  assert.deepEqual([image.width, image.height], [100, 60])
  assert.ok(taken.clip !== undefined && taken.clip.top < 300 && taken.clip.top >= 0, JSON.stringify(taken.clip))
  assert.ok(allOf(image, far), 'every pixel is the box, not what lies above or below it in the document')
})

test('an element that is missing, hidden or one of several is not pictured, and says which', async (t) => {
  const page = await stablePage(t)
  if (page === undefined) return
  assertOk(await goto(page, '/stable'))
  const missing = await take(page, { locator: byTestId('nowhere') })
  assert.ok(missing.ok && 'target' in missing, JSON.stringify(missing))
  assert.equal(missing.target.count, 0)
  const hidden = await take(page, { locator: byTestId('never') })
  assert.ok(hidden.ok && 'target' in hidden)
  assert.deepEqual(hidden.target, { count: 1, refused: 'hidden' })
  const several = await take(page, { locator: { by: 'css', selector: 'div' } })
  assert.ok(several.ok && 'target' in several)
  assert.ok(several.target.count > 1 && several.target.refused === undefined, JSON.stringify(several.target))
})
