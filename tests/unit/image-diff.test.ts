import type { RgbaImage } from '../../src/shared/png.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { comparePixels, defaultThreshold, differencePicture, samePixels } from '../../src/shared/image-diff.ts'

type Colour = readonly [number, number, number, number?]

// A picture painted pixel by pixel from a function of its column and row.
function picture(width: number, height: number, paint: (x: number, y: number) => Colour): RgbaImage {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [red, green, blue, alpha = 255] = paint(x, y)
      data.set([red, green, blue, alpha], (y * width + x) * 4)
    }
  }
  return { width, height, data }
}

const white: Colour = [255, 255, 255]
const black: Colour = [0, 0, 0]

function pixel(image: RgbaImage, x: number, y: number): number[] {
  const at = (y * image.width + x) * 4
  return [...image.data.subarray(at, at + 4)]
}

test('identical pictures differ in no pixel, and pictures of different sizes are not compared', () => {
  const plain = picture(8, 8, () => white)
  assert.ok(samePixels(plain, picture(8, 8, () => white)))
  assert.deepEqual(comparePixels(plain, picture(8, 8, () => white)), { differentPixels: 0, antiAliasedPixels: 0 })
  assert.equal(samePixels(plain, picture(8, 9, () => white)), false)
  assert.throws(() => comparePixels(plain, picture(9, 8, () => white)), /one size, not 8 by 8 and 9 by 8/)
})

test('a changed block counts each of its pixels, and a change below the threshold counts none', () => {
  const base = picture(10, 10, () => white)
  const blocked = picture(10, 10, (x, y) => (x >= 2 && x < 5 && y >= 2 && y < 5 ? [200, 30, 30] : white))
  assert.deepEqual(comparePixels(base, blocked), { differentPixels: 9, antiAliasedPixels: 0 })
  const faint = picture(10, 10, () => [250, 250, 250])
  assert.equal(comparePixels(base, faint).differentPixels, 0, 'a faint tint stays under the default threshold')
  assert.equal(comparePixels(base, faint, 0).differentPixels, 100, 'a threshold of 0 counts every changed pixel')
  assert.equal(comparePixels(base, blocked, 1).differentPixels, 0, 'a threshold of 1 lets every colour through')
  assert.equal(defaultThreshold, 0.2)
  assert.throws(() => comparePixels(base, blocked, 1.5), /from 0 to 1, not 1.5/)
})

test('an anti-aliased edge drawn a shade differently is left out, and the same change on a flat area is counted', () => {
  // A black and a white half, with a grey column between them where the edge is smoothed: one shade in the baseline
  // and another in the picture, as a font or a curve renders a little differently between two runs.
  const edge = (grey: number) => picture(7, 7, (x) => (x < 3 ? black : x === 3 ? [grey, grey, grey] : white))
  const smoothed = comparePixels(edge(128), edge(60))
  assert.deepEqual(smoothed, { differentPixels: 0, antiAliasedPixels: 7 })
  const flat = (grey: number) => picture(7, 7, (x) => (x === 3 ? [grey, grey, grey] : white))
  assert.deepEqual(comparePixels(flat(128), flat(60)), { differentPixels: 7, antiAliasedPixels: 0 }, 'a column on white is no edge')
})

test('a transparent pixel compares as the white it would show on', () => {
  const opaque = picture(3, 3, () => white)
  const clear = picture(3, 3, () => [0, 0, 0, 0])
  assert.equal(comparePixels(opaque, clear).differentPixels, 0)
  assert.equal(comparePixels(opaque, picture(3, 3, () => [0, 0, 0, 128])).differentPixels, 9)
})

test('the difference picture marks differing pixels in red over the faded picture', () => {
  const base = picture(6, 4, () => white)
  const changed = picture(6, 4, (x, y) => (x === 4 && y === 1 ? black : [0, 0, 255]))
  const drawn = differencePicture(base, changed, 0.2)
  assert.equal(drawn.differentPixels, 24)
  const quiet = differencePicture(base, picture(6, 4, (x, y) => (x === 4 && y === 1 ? black : white)), 0.2)
  assert.equal(quiet.differentPixels, 1)
  assert.deepEqual(pixel(quiet.picture, 4, 1), [255, 0, 0, 255])
  const faded = pixel(quiet.picture, 0, 0)
  assert.deepEqual(faded, [255, 255, 255, 255], 'white fades to white')
  const greyed = pixel(differencePicture(picture(1, 1, () => black), picture(1, 1, () => black), 0.2).picture, 0, 0)
  assert.ok(greyed[0] !== undefined && greyed[0] > 200 && greyed[0] < 255 && greyed[0] === greyed[1] && greyed[1] === greyed[2], 'black fades to a light grey')
})

test('pictures of different sizes are drawn on the larger canvas, and what only one covers is red', () => {
  const small = picture(2, 2, () => white)
  const wide = picture(3, 2, () => white)
  const drawn = differencePicture(small, wide, 0.2)
  assert.deepEqual([drawn.picture.width, drawn.picture.height, drawn.differentPixels], [3, 2, 2])
  assert.deepEqual(pixel(drawn.picture, 2, 0), [255, 0, 0, 255])
  assert.deepEqual(pixel(drawn.picture, 1, 1), [255, 255, 255, 255])
})
