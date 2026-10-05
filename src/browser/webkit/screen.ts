import type { Emulation } from '../../protocol/emulation.ts'
import type { Failure } from '../../protocol/failures.ts'

/** The screen a WebKit page shows: its viewport in CSS pixels, its pixel ratio, and a user agent in place of the build's. */
export type WebKitScreen = { readonly viewport: { readonly width: number; readonly height: number }; readonly deviceScaleFactor: number; readonly userAgent?: string }

/**
 * The viewport a WebKit page gets when its target names none: the size Retest's headless Chrome gave a page when this
 * was measured, 756 by 469 CSS pixels at a pixel ratio of 1, so a test that names no viewport sees the same layout on both
 * engines.
 */
export const defaultScreen: WebKitScreen = { viewport: { width: 756, height: 469 }, deviceScaleFactor: 1 }

/**
 * The screen a target's emulation asks of a WebKit page, or why WebKit cannot show it. WebKit takes a viewport, a pixel
 * ratio and a user agent; it has no mobile layout and Retest drives no touch screen on it, so a device or a screen that
 * asks for either is refused by name rather than shown as something it is not.
 *
 * @example webKitScreen({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, touch: false, isMobile: false }) // { ok: true, screen: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 } }
 */
export function webKitScreen(emulation: Emulation | undefined): { ok: true; screen: WebKitScreen } | { ok: false; failure: Failure } {
  if (emulation === undefined) return { ok: true, screen: defaultScreen }
  const asked = [...(emulation.isMobile ? ['a mobile layout'] : []), ...(emulation.touch ? ['a touch screen'] : [])]
  if (asked.length > 0) {
    const message = `Retest's WebKit driver cannot emulate ${asked.join(' or ')}. Give this WebKit target a viewport, or a screen with isMobile and touch false.`
    return { ok: false, failure: { class: 'unsupported', message } }
  }
  const { viewport, deviceScaleFactor, userAgent } = emulation
  return { ok: true, screen: { viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor, ...(userAgent === undefined ? {} : { userAgent }) } }
}
