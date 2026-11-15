import type { BrowserVersion } from './browser.ts'
import type { CdpSession } from './cdp/session.ts'
import type { Deadline } from '../protocol/deadline.ts'
import { s } from '../protocol/schema.ts'
import { findPin } from './builds.ts'
import { request, sendOptions } from './cdp-results.ts'

// A page that sets no viewport reads the size, place and screen of the window its browser gives it, and Retest 0.4.2
// started Chrome on an about:blank page, whose window had a tab strip. Chrome started with no window of its own, as
// Retest starts it now, gives a new page's window none, so its viewport grew; Chrome's headless shell gives the page
// its whole window. Each is given here what Retest 0.4.2 gave the pinned Chrome for Testing, so a layout check or a
// picture of such a page is the same after the change and on either program.

/** A size in CSS pixels. */
type Size = { readonly width: number; readonly height: number }

/** Where a page's window stands on the screen, and the viewport inside it. */
type Placed = { readonly viewport: Size; readonly position: { readonly x: number; readonly y: number } }

/**
 * What a page that sets no viewport read in Retest 0.4.2 on the pinned Chrome for Testing: the window's size and its
 * screen, and the viewport and place of a page Retest opened and of a window a page opened as a tab, with no size of its
 * own. A window a page opens with a size keeps what its browser gives it. `keepView` leaves the page's view at the
 * window's size and makes only the page smaller, where the browser would otherwise report the view as its window.
 */
export type RecordedWindow = { readonly window: Size; readonly screen: Size; readonly page: Placed; readonly tab: Placed; readonly keepView?: true }

/** Which recorded window a page of the browser is given: as a page Retest opened, as a tab a page opened, or none. */
export type WindowKind = 'page' | 'tab' | 'none'

// Read through Retest 0.4.2 with Chrome for Testing 153.0.8010.12, headless, with no viewport: on Linux x64 from the
// published package (Ubuntu 24.04, 15 November 2026), on macOS arm64 from the same source, commit 8f2d789. Windows was
// not read, so neither program is given a window there. On macOS the headless shell reports a page's view as its window
// once device metrics resize the view, so the page read its viewport's size as its outer size (756x413 where Chrome
// read 756x556); the recorded viewport fits inside the window, so the view need not shrink with it.
const recorded: Readonly<Partial<Record<NodeJS.Platform, RecordedWindow>>> = {
  linux: { window: { width: 780, height: 580 }, screen: { width: 800, height: 600 }, page: { viewport: { width: 780, height: 437 }, position: { x: 20, y: 20 } }, tab: { viewport: { width: 780, height: 493 }, position: { x: 20, y: 20 } } },
  darwin: { window: { width: 756, height: 556 }, screen: { width: 800, height: 600 }, page: { viewport: { width: 756, height: 413 }, position: { x: 44, y: 44 } }, tab: { viewport: { width: 756, height: 413 }, position: { x: 44, y: 44 } }, keepView: true },
}

const empty = s.object({})

/**
 * The window a headless page of this browser is given, or undefined: only Chrome for Testing and its headless shell of
 * the pinned release get one, on a platform where Retest 0.4.2's window was read, since another browser's window was
 * never recorded.
 *
 * @example recordedWindow({ product: 'HeadlessChrome', version: '153.0.8010.12', userAgent }, 'linux')?.page.viewport // { width: 780, height: 437 }
 */
export function recordedWindow(version: BrowserVersion, platform: NodeJS.Platform = process.platform): RecordedWindow | undefined {
  if (version.product !== 'Chrome' && version.product !== 'HeadlessChrome') return undefined
  const pinned = findPin('chromium', platform === 'darwin' ? 'mac-arm64' : platform === 'win32' ? 'win-x64' : 'linux-x64')
  if (pinned === undefined || pinned.version !== version.version) return undefined
  return recorded[platform]
}

/**
 * The window and screen sizes Chrome's headless shell starts with, so a page reads Retest 0.4.2's window as Chrome for
 * Testing gave it, or undefined where none was read.
 *
 * @example recordedScreen('linux') // { window: { width: 780, height: 580 }, screen: { width: 800, height: 600 } }
 */
export function recordedScreen(platform: NodeJS.Platform = process.platform): { readonly window: Size; readonly screen: Size } | undefined {
  const found = recorded[platform]
  return found === undefined ? undefined : { window: found.window, screen: found.screen }
}

/**
 * The device metrics that give a page the recorded window: its viewport, its window's place and the screen, at the
 * browser's own pixel ratio. A page with emulation of its own, or a window opened with a size, is given nothing.
 */
export function windowRequests(session: CdpSession, window: RecordedWindow, kind: WindowKind, deadline: Deadline): Promise<unknown>[] {
  if (kind === 'none') return []
  const placed = kind === 'page' ? window.page : window.tab
  const metrics = { width: placed.viewport.width, height: placed.viewport.height, deviceScaleFactor: 0, mobile: false, screenWidth: window.screen.width, screenHeight: window.screen.height, positionX: placed.position.x, positionY: placed.position.y, ...(window.keepView === true ? { dontSetVisibleSize: true } : {}) }
  return [request(session, 'Emulation.setDeviceMetricsOverride', metrics, empty, sendOptions(deadline))]
}

/**
 * Whether a window a page opens asked for a size of its own, from the features `Page.windowOpen` lists: such a window
 * keeps what its browser gives it, and any other is a tab.
 *
 * @example sizedWindow(['popup', 'width=300', 'height=200']) // true
 */
export function sizedWindow(features: readonly string[]): boolean {
  return features.some((feature) => /^(width|height|innerwidth|innerheight)=/i.test(feature))
}
