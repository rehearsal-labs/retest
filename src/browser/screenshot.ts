import type { CdpSession } from './cdp/session.ts'
import type { IsolatedWorld } from './isolated-world.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { Failure } from '../protocol/failures.ts'
import type { LayoutBox } from '../protocol/layout.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import type { PageFacts } from '../protocol/page-facts.ts'
import type { ScreenshotTarget } from '../protocol/screenshot.ts'
import { s } from '../protocol/schema.ts'
import { invalidSelector, shadowRefused } from './actionability.ts'
import { request, sendOptions } from './cdp-results.ts'
import { readLayout } from './layout.ts'

/** What a screenshot comparison asks a page for: a picture of its viewport, or of the one element `locator` finds. */
export type PictureRequest = { readonly locator?: LocatorRecipe }

/**
 * A picture for a screenshot comparison: the PNG, the device scale factor it was taken at when the page told it, and,
 * for an element, the box it was clipped to, in CSS pixels from the viewport's top left corner. Or no picture, and
 * why, in `target`: the locator found no element, several, or one that is not shown or runs past the viewport. Or the
 * failure that kept the page from answering. `page` is the page it looked at, when the look read it.
 */
export type TakenPicture =
  | { readonly ok: true; readonly png: Uint8Array; readonly scale?: number; readonly clip?: LayoutBox; readonly page?: PageFacts }
  | { readonly ok: true; readonly target: ScreenshotTarget; readonly page?: PageFacts }
  | { readonly ok: false; readonly failure: Failure }

const screenshotSchema = s.object({ data: s.string() })
const viewportSchema = s.object({ scale: s.number({ min: 0 }), left: s.number(), top: s.number() })

// The device scale factor, and how far the visual viewport is scrolled into the document, which a clip is measured from.
const viewportFunction = `function readViewport() {
  const visual = globalThis.visualViewport
  return { scale: globalThis.devicePixelRatio, left: visual ? visual.pageLeft : globalThis.scrollX, top: visual ? visual.pageTop : globalThis.scrollY }
}`

/**
 * Takes a Chromium page's picture for a comparison through `Page.captureScreenshot`, as PNG. The viewport is taken as
 * it stands. An element is found and measured as a layout look measures it, in one call of Retest's world: it must be
 * the one match, shown, and inside the viewport, since a picture of it never scrolls the page; its box is widened to
 * whole CSS pixels, as Playwright clips an element, and taken at the page's own scale. The clip is given in the
 * document's coordinates, the viewport's offset added. Reads only, and sends no input.
 */
export async function takeChromiumPicture(page: { session: CdpSession; world: IsolatedWorld }, wanted: PictureRequest, deadline: Deadline): Promise<TakenPicture> {
  const { session, world } = page
  const { locator } = wanted
  if (locator === undefined) {
    const viewport = await world.call(viewportFunction, [], viewportSchema, deadline)
    const { data } = await request(session, 'Page.captureScreenshot', { format: 'png' }, screenshotSchema, sendOptions(deadline))
    return { ok: true, png: Buffer.from(data, 'base64'), scale: viewport.scale }
  }
  const read = await readLayout(world, { locator }, deadline)
  if ('invalid' in read) return { ok: false, failure: invalidSelector(read.invalid, read.locator, undefined) }
  if ('shadow' in read) return { ok: false, failure: shadowRefused(read.shadow, read.locator, undefined) }
  const { look } = read
  const [found] = look.targets
  const counted = found === undefined ? { count: 0 } : { count: found.count, ...(found.emptyStep === undefined ? {} : { emptyStep: found.emptyStep }) }
  const element = found?.element
  if (counted.count !== 1 || element === undefined) return { ok: true, target: counted, page: read.page }
  if (!element.shown) return { ok: true, target: { count: 1, refused: 'hidden' }, page: read.page }
  const clip = enclosing(element.box)
  if (clip.left < 0 || clip.top < 0 || clip.right > look.edge || clip.bottom > look.viewport.height) return { ok: true, target: { count: 1, refused: 'outside' }, page: read.page }
  const viewport = await world.call(viewportFunction, [], viewportSchema, deadline)
  const params = { format: 'png', clip: { x: clip.left + viewport.left, y: clip.top + viewport.top, width: clip.right - clip.left, height: clip.bottom - clip.top, scale: 1 } }
  const { data } = await request(session, 'Page.captureScreenshot', params, screenshotSchema, sendOptions(deadline))
  return { ok: true, png: Buffer.from(data, 'base64'), scale: viewport.scale, clip, page: read.page }
}

// The smallest box of whole pixels around a box, a thousandth of a pixel of rounding forgiven each way.
function enclosing(box: LayoutBox): LayoutBox {
  return { left: Math.floor(box.left + 1e-3), top: Math.floor(box.top + 1e-3), right: Math.ceil(box.right - 1e-3), bottom: Math.ceil(box.bottom - 1e-3) }
}
