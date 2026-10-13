import type { RgbaImage } from './png.ts'

// How two pictures differ, pixel by pixel, for a screenshot comparison. A pixel differs when the distance between its
// two colours, in the YIQ space that weighs brightness the way eyes do, is above a threshold; a pixel that differs only
// because an edge is anti-aliased a little differently is not counted.
//
// The colour distance and the anti-aliasing detector are adapted from pixelmatch 7.2.0 by Mapbox, read as published on
// npm, and match the version Playwright 1.63.0 vendors, whose `toHaveScreenshot` counts pixels this way, so a threshold
// means here what it means there. The distance follows Kotsarenko and Ramos, "Measuring perceived color difference using
// YIQ NTSC transmission color space in mobile applications" (2010); the detector follows Vysniauskas, "Anti-aliased
// pixel and intensity slope detector" (2009). Semi-transparent pixels are blended on white, as Playwright's copy does.
// pixelmatch's licence:
//
//   ISC License
//
//   Copyright (c) 2025, Mapbox
//
//   Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby
//   granted, provided that the above copyright notice and this permission notice appear in all copies.
//
//   THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING
//   ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL,
//   DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
//   WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE
//   USE OR PERFORMANCE OF THIS SOFTWARE.

/** The colour distance, from 0 to 1, above which a pixel counts as different, as Playwright's `toHaveScreenshot` sets it. */
export const defaultThreshold = 0.2

/** How two pictures of one size differ: the pixels counted as different, and the pixels left out as anti-aliasing. */
export type PixelDifference = { readonly differentPixels: number; readonly antiAliasedPixels: number }

/** The picture `differencePicture` draws, and the count it drew. */
export type DrawnDifference = PixelDifference & { readonly picture: RgbaImage }

// The largest squared distance two colours can have in YIQ, so a threshold of 1 lets every colour through.
const maxSquaredDistance = 35215
// How much of the actual picture's brightness shows in the difference picture: faded, so the red stands out.
const fade = 0.1
const differenceColour = [255, 0, 0] as const

/**
 * Whether two pictures are the same size and the same in every byte of every pixel.
 *
 * @example samePixels(first, second) // true
 */
export function samePixels(first: RgbaImage, second: RgbaImage): boolean {
  if (first.width !== second.width || first.height !== second.height || first.data.length !== second.data.length) return false
  return Buffer.from(first.data.buffer, first.data.byteOffset, first.data.byteLength).equals(Buffer.from(second.data.buffer, second.data.byteOffset, second.data.byteLength))
}

/**
 * Counts the pixels of two pictures of one size whose colours are further apart than `threshold`, from 0 to 1, leaving
 * out those that are anti-aliasing in either picture. Throws `RangeError` for pictures of different sizes or a
 * threshold outside 0 to 1.
 *
 * @example comparePixels(baseline, picture, 0.2).differentPixels // 0
 */
export function comparePixels(expected: RgbaImage, actual: RgbaImage, threshold: number = defaultThreshold): PixelDifference {
  checkSizes(expected, actual)
  return scan(expected, actual, threshold, undefined)
}

/**
 * Draws where two pictures differ, on a canvas as large as the larger of the two each way: the actual picture faded
 * to grey, and each differing pixel in red. A pixel that only one picture covers is red. Anti-aliased pixels stay
 * faded. The counts are those of `comparePixels` when the sizes match, and count the uncovered pixels as different
 * when they do not.
 *
 * @example differencePicture(baseline, picture, 0.2).picture.width // 1280
 */
export function differencePicture(expected: RgbaImage, actual: RgbaImage, threshold: number = defaultThreshold): DrawnDifference {
  checkThreshold(threshold)
  const width = Math.max(expected.width, actual.width)
  const height = Math.max(expected.height, actual.height)
  const data = new Uint8Array(width * height * 4)
  const canvas = { width, height, data }
  if (expected.width === actual.width && expected.height === actual.height) {
    const counted = scan(expected, actual, threshold, (index, different) => (different ? paint(data, index * 4) : fadeInto(data, index * 4, actual.data, index * 4)))
    return { ...counted, picture: canvas }
  }
  let differentPixels = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4
      if (x < actual.width && y < actual.height && x < expected.width && y < expected.height) fadeInto(data, at, actual.data, (y * actual.width + x) * 4)
      else {
        paint(data, at)
        differentPixels++
      }
    }
  }
  return { differentPixels, antiAliasedPixels: 0, picture: canvas }
}

function checkSizes(expected: RgbaImage, actual: RgbaImage): void {
  if (expected.width !== actual.width || expected.height !== actual.height) {
    throw new RangeError(`Pixels compare only between pictures of one size, not ${expected.width} by ${expected.height} and ${actual.width} by ${actual.height}.`)
  }
  for (const image of [expected, actual]) if (image.data.length !== image.width * image.height * 4) throw new RangeError(`${image.width} by ${image.height} RGBA pixels take ${image.width * image.height * 4} bytes, not ${image.data.length}.`)
}

function checkThreshold(threshold: number): void {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new RangeError(`A threshold is a colour distance from 0 to 1, not ${threshold}.`)
}

// Visits every pixel of two pictures of one size, counting those that differ, and tells `mark` of each, different or not.
function scan(expected: RgbaImage, actual: RgbaImage, threshold: number, mark: ((index: number, different: boolean) => void) | undefined): PixelDifference {
  checkThreshold(threshold)
  const { width, height } = expected
  const first = expected.data
  const second = actual.data
  const limit = maxSquaredDistance * threshold * threshold
  let differentPixels = 0
  let antiAliasedPixels = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x
      const delta = colourDelta(first, second, index * 4, index * 4, false)
      if (Math.abs(delta) <= limit) {
        mark?.(index, false)
        continue
      }
      if (antiAliased(first, second, x, y, width, height) || antiAliased(second, first, x, y, width, height)) {
        antiAliasedPixels++
        mark?.(index, false)
        continue
      }
      differentPixels++
      mark?.(index, true)
    }
  }
  return { differentPixels, antiAliasedPixels }
}

/**
 * Whether the pixel at `x`, `y` of `picture` looks like part of an anti-aliased edge: among its eight neighbours it has
 * no more than two of its own brightness, at least one darker and one brighter, and the darkest or the brightest of
 * them sits in a flat run of at least three equal neighbours in both pictures.
 */
function antiAliased(picture: Uint8Array, other: Uint8Array, x: number, y: number, width: number, height: number): boolean {
  const left = Math.max(x - 1, 0)
  const top = Math.max(y - 1, 0)
  const right = Math.min(x + 1, width - 1)
  const bottom = Math.min(y + 1, height - 1)
  const at = (y * width + x) * 4
  let equal = x === left || x === right || y === top || y === bottom ? 1 : 0
  let darkest = 0
  let brightest = 0
  let darkestAt: [number, number] | undefined
  let brightestAt: [number, number] | undefined
  for (let column = left; column <= right; column++) {
    for (let row = top; row <= bottom; row++) {
      if (column === x && row === y) continue
      const delta = colourDelta(picture, picture, at, (row * width + column) * 4, true)
      if (delta === 0) {
        equal++
        if (equal > 2) return false
      } else if (delta < darkest) {
        darkest = delta
        darkestAt = [column, row]
      } else if (delta > brightest) {
        brightest = delta
        brightestAt = [column, row]
      }
    }
  }
  if (darkestAt === undefined || brightestAt === undefined) return false
  const flat = ([column, row]: [number, number]): boolean => hasManySiblings(picture, column, row, width, height) && hasManySiblings(other, column, row, width, height)
  return flat(darkestAt) || flat(brightestAt)
}

// Whether a pixel has at least three neighbours exactly like it, a pixel on the picture's edge counting the edge as one.
function hasManySiblings(picture: Uint8Array, x: number, y: number, width: number, height: number): boolean {
  const left = Math.max(x - 1, 0)
  const top = Math.max(y - 1, 0)
  const right = Math.min(x + 1, width - 1)
  const bottom = Math.min(y + 1, height - 1)
  const at = (y * width + x) * 4
  let equal = x === left || x === right || y === top || y === bottom ? 1 : 0
  for (let column = left; column <= right; column++) {
    for (let row = top; row <= bottom; row++) {
      if (column === x && row === y) continue
      const other = (row * width + column) * 4
      if (picture[at] === picture[other] && picture[at + 1] === picture[other + 1] && picture[at + 2] === picture[other + 2] && picture[at + 3] === picture[other + 3]) equal++
      if (equal > 2) return true
    }
  }
  return false
}

// The squared YIQ distance between two pixels, negative when the first is the brighter; with `brightnessOnly`, the
// difference in brightness alone, first less second.
function colourDelta(first: Uint8Array, second: Uint8Array, at: number, other: number, brightnessOnly: boolean): number {
  const r1 = first[at] ?? 0
  const g1 = first[at + 1] ?? 0
  const b1 = first[at + 2] ?? 0
  const a1 = first[at + 3] ?? 0
  const r2 = second[other] ?? 0
  const g2 = second[other + 1] ?? 0
  const b2 = second[other + 2] ?? 0
  const a2 = second[other + 3] ?? 0
  if (r1 === r2 && g1 === g2 && b1 === b2 && a1 === a2) return 0
  const [red1, green1, blue1] = onWhite(r1, g1, b1, a1)
  const [red2, green2, blue2] = onWhite(r2, g2, b2, a2)
  const brightness1 = luma(red1, green1, blue1)
  const brightness2 = luma(red2, green2, blue2)
  const y = brightness1 - brightness2
  if (brightnessOnly) return y
  const i = inPhase(red1, green1, blue1) - inPhase(red2, green2, blue2)
  const q = quadrature(red1, green1, blue1) - quadrature(red2, green2, blue2)
  const delta = 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q
  return brightness1 > brightness2 ? -delta : delta
}

function onWhite(red: number, green: number, blue: number, alpha: number): [number, number, number] {
  if (alpha === 255) return [red, green, blue]
  const opacity = alpha / 255
  return [blend(red, opacity), blend(green, opacity), blend(blue, opacity)]
}

function blend(channel: number, opacity: number): number {
  return 255 + (channel - 255) * opacity
}

function luma(red: number, green: number, blue: number): number {
  return red * 0.29889531 + green * 0.58662247 + blue * 0.11448223
}

function inPhase(red: number, green: number, blue: number): number {
  return red * 0.59597799 - green * 0.2741761 - blue * 0.32180189
}

function quadrature(red: number, green: number, blue: number): number {
  return red * 0.21147017 - green * 0.52261711 + blue * 0.31114694
}

function paint(data: Uint8Array, at: number): void {
  data[at] = differenceColour[0]
  data[at + 1] = differenceColour[1]
  data[at + 2] = differenceColour[2]
  data[at + 3] = 255
}

function fadeInto(data: Uint8Array, at: number, source: Uint8Array, from: number): void {
  const opacity = (fade * (source[from + 3] ?? 0)) / 255
  const grey = blend(luma(source[from] ?? 0, source[from + 1] ?? 0, source[from + 2] ?? 0), opacity)
  data[at] = grey
  data[at + 1] = grey
  data[at + 2] = grey
  data[at + 3] = 255
}
