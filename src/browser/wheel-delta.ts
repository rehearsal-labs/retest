import type { BrowserVersion } from './browser.ts'
import type { Point } from './input.ts'

/**
 * How a Chromium browser reads the delta of a wheel sent with `Input.dispatchMouseEvent`. `css`: as CSS pixels, which
 * it scales by the page's zoom as it scales the point, so the page scrolls the delta whatever its zoom. `viewport`: as
 * the viewport's own pixels, so a page zoomed out to fit, as a phone shows a page laid out wider than itself, scrolls
 * the delta divided by its visual viewport's scale.
 */
export type WheelUnits = 'css' | 'viewport'

// Chromium's main@{#1721550}, "DevTools: Preserve CSS wheel deltas across zoomed frames" (18 October 2026), made the
// DevTools input handler scale a wheel's delta by the browser zoom, CSS zoom and pinch scale it already applied to the
// point. Chrome 158.0.8111.0 is the first build holding it and 158.0.8110.0 the last without, by their source and by
// measurement on 17 November 2026 on Linux, macOS and Windows: one wheel of 60 CSS pixels on a 412-pixel phone page
// zoomed out to 0.42 moved it 60 when sent as it is, and 25 when sent times the scale, on the headless shell 158.0.8111.0
// and Chrome 158.0.8127.36. Sent times the scale it moved 60, and sent as it is 143, on the headless shells 158.0.8110.0
// and 157.0.8103.78, Chrome 156.0.8078.80, Chromium 156.0.8078.79, Edge 156.0.4314.58, Chrome for Testing 153.0.8010.12
// and its shell, and Electron 44.5.1's Chromium 152.0.7977.130. Nothing on the page tells the two apart before input,
// and Retest never sends a wheel to find out, so the version the browser reports decides.
const firstScalingBuild = [158, 0, 8111, 0] as const

// The products whose version is Chromium's own, build number included. Another, such as Microsoft Edge's `Edg`, numbers
// its builds its own way and shares only Chromium's major version, whose releases all hold the change from 158 on.
const chromiumNumbered = new Set(['Chrome', 'HeadlessChrome'])

/**
 * How the browser that reported `browser` in its handshake reads a wheel's delta. A version that cannot be read is
 * taken to read it as the protocol says, in CSS pixels.
 *
 * @example wheelUnits({ product: 'Chrome', version: '158.0.8127.36' }) // 'css'
 * @example wheelUnits({ product: 'HeadlessChrome', version: '153.0.8010.12' }) // 'viewport'
 */
export function wheelUnits(browser: Pick<BrowserVersion, 'product' | 'version'>): WheelUnits {
  const parts = browser.version.split('.')
  if (parts.length !== 4 || !parts.every((part) => /^\d+$/.test(part))) return 'css'
  const first = chromiumNumbered.has(browser.product) ? firstScalingBuild : firstScalingBuild.slice(0, 1)
  return atLeast(parts.map(Number), first) ? 'css' : 'viewport'
}

/**
 * The delta to send for a scroll of `delta` CSS pixels on a page whose visual viewport is at `scale`, to a browser that
 * reads it in `units`.
 *
 * @example wheelDelta({ x: 0, y: 60 }, 0.5, 'viewport') // { x: 0, y: 30 }
 * @example wheelDelta({ x: 0, y: 60 }, 0.5, 'css') // { x: 0, y: 60 }
 */
export function wheelDelta(delta: Point, scale: number, units: WheelUnits): Point {
  if (units === 'css') return { x: delta.x, y: delta.y }
  return { x: delta.x * scale, y: delta.y * scale }
}

// Whether a version's numbers, read from the left, are at or past `first`'s.
function atLeast(parts: readonly number[], first: readonly number[]): boolean {
  for (const [index, bound] of first.entries()) {
    const part = parts[index] ?? 0
    if (part !== bound) return part > bound
  }
  return true
}
