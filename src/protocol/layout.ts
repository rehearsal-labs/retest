import type { EmptyStep } from './locator.ts'
import { emptyStepSchema } from './locator.ts'
import { s, type Schema } from './schema.ts'

/**
 * The numbers a layout look counts by. They are the ones Rehearsal's page survey finds layout problems with, so a
 * test of a problem that survey found fails while the survey would still find it, and passes once it would not.
 */
export const layoutLimits = {
  /** Pixels two elements must share, both across and down, before they overlap. */
  overlap: 4,
  /** Pixels past an edge that rounding alone reaches, and so never count. */
  tolerance: 1,
  /** Pixels of words a container must cut off before the words count as cut off. */
  clipped: 4,
  /** Pixels an element must show each way to count as shown. */
  shown: 2,
  /** Elements inside a measured one whose words are read, in document order. */
  descendants: 200,
} as const

/** A box in CSS pixels, from the viewport's top left corner, as an element's client rect gives it. */
export type LayoutBox = { left: number; top: number; right: number; bottom: number }

/** The viewport's size in CSS pixels, its scrollbars included, as `innerWidth` and `innerHeight` read it. */
export type ViewportSize = { width: number; height: number }

/** The one element a locator matched, as a layout look measured it. */
export type MeasuredElement = {
  /**
   * Shown as a layout look counts it: inside the body, neither it nor a container around it is undisplayed or faded
   * out to nothing, it is not hidden, and at least `layoutLimits.shown` pixels of it show each way.
   */
  shown: boolean
  /** Its client rect. */
  box: LayoutBox
  /** The part of its box that every container around it that limits its overflow lets the page show. */
  seen: LayoutBox
  /** A text field, a select or a text area, which a control may sit inside without overlapping it. */
  field: boolean
  /**
   * The most pixels a container cuts off of its own words or the words of an element inside it, or null when it shows
   * no words. Present only in a look that read words.
   */
  cut?: number | null
}

/** What one locator matched in a layout look: how many elements, the first step that kept none, and the one it measured. */
export type LayoutTarget = { count: number; emptyStep?: EmptyStep; element?: MeasuredElement }

/** Which of two measured elements holds the other, or `same` when both locators found one element. */
export type Nesting = 'same' | 'first' | 'second'

/**
 * What a layout look saw. `edge` is where the page's content can end: the viewport's width without its scrollbar.
 * `documentWidth` is how wide the document is, the root element's scroll width. `hidesSideways` says the viewport
 * hides what runs past it sideways, as `overflow-x: hidden` or `clip` on the root, or on the body when the root leaves
 * its own visible, makes it. `targets` has one entry per locator the look measured, in order. `nesting` is present
 * when the look measured two elements and one is the other or holds it.
 */
export type LayoutLook = {
  viewport: ViewportSize
  edge: number
  documentWidth: number
  hidesSideways: boolean
  targets: LayoutTarget[]
  nesting?: Nesting
}

const box: Schema<LayoutBox> = s.object({ left: s.number(), top: s.number(), right: s.number(), bottom: s.number() })
const size = s.number({ min: 0 })

export const viewportSizeSchema: Schema<ViewportSize> = s.object({ width: size, height: size })

const measuredElementSchema: Schema<MeasuredElement> = s.object({
  shown: s.boolean(),
  box,
  seen: box,
  field: s.boolean(),
  cut: s.optional(s.nullable(s.number({ min: 0 }))),
})

export const layoutLookSchema: Schema<LayoutLook> = s.object({
  viewport: viewportSizeSchema,
  edge: size,
  documentWidth: size,
  hidesSideways: s.boolean(),
  targets: s.array(s.object({ count: s.number({ integer: true, min: 0 }), emptyStep: s.optional(emptyStepSchema), element: s.optional(measuredElementSchema) })),
  nesting: s.optional(s.enum(['same', 'first', 'second'])),
})

/** Pixels two boxes share, across and down. A number at or below 0 says how far apart they are that way. */
export type Shared = { across: number; down: number }

/**
 * What two elements' visible boxes share, across and down.
 *
 * @example sharedBetween(save, help) // { across: 32, down: 32 }
 */
export function sharedBetween(one: MeasuredElement, other: MeasuredElement): Shared {
  return {
    across: Math.min(one.seen.right, other.seen.right) - Math.max(one.seen.left, other.seen.left),
    down: Math.min(one.seen.bottom, other.seen.bottom) - Math.max(one.seen.top, other.seen.top),
  }
}

/**
 * Which of two elements is a field the other sits inside, as a button that clears a search sits inside its field, or
 * undefined when neither is. Such a pair never overlaps, since the control belongs to the field. A pixel of rounding
 * is allowed each way.
 *
 * @example fieldAround(search, clear) // 'first'
 */
export function fieldAround(one: MeasuredElement, other: MeasuredElement): 'first' | 'second' | undefined {
  if (one.field && holds(one.seen, other.seen)) return 'first'
  return other.field && holds(other.seen, one.seen) ? 'second' : undefined
}

/**
 * Whether two shown elements overlap: their visible boxes share more than `layoutLimits.overlap` pixels both across
 * and down, and neither is a field the other sits inside. Whether one holds the other in the document is the look's
 * own `nesting`, and such a pair is never measured.
 */
export function overlapping(one: MeasuredElement, other: MeasuredElement): boolean {
  const { across, down } = sharedBetween(one, other)
  return across > layoutLimits.overlap && down > layoutLimits.overlap && fieldAround(one, other) === undefined
}

/**
 * How far the visible part of an element ends past the right edge, in pixels: negative when it ends before it.
 *
 * @example pastEdge(price, 390) // 14
 */
export function pastEdge(element: MeasuredElement, edge: number): number {
  return element.seen.right - edge
}

/** Whether the visible part of an element ends more than `layoutLimits.tolerance` pixels past the right edge. */
export function crossesEdge(element: MeasuredElement, edge: number): boolean {
  return pastEdge(element, edge) > layoutLimits.tolerance
}

/** Whether a container cuts off more than `layoutLimits.clipped` pixels of an element's words. */
export function wordsCutOff(cut: number): boolean {
  return cut > layoutLimits.clipped
}

/**
 * Whether the page scrolls sideways: the document is more than `layoutLimits.tolerance` pixels wider than the edge,
 * and the viewport does not hide what runs past it.
 */
export function scrollsSideways(look: LayoutLook): boolean {
  return look.documentWidth > look.edge + layoutLimits.tolerance && !look.hidesSideways
}

/**
 * Pixels as a measurement records them: to a tenth of a pixel, so a rounded number never hides which side of a limit
 * it is on.
 *
 * @example roundPixels(31.996) // 32
 */
export function roundPixels(value: number): number {
  const rounded = Math.round(value * 10) / 10
  return Object.is(rounded, -0) ? 0 : rounded
}

/**
 * Pixels as a sentence says them.
 *
 * @example describePixels(1) // '1 pixel'
 */
export function describePixels(value: number): string {
  const rounded = roundPixels(value)
  return `${rounded} ${rounded === 1 ? 'pixel' : 'pixels'}`
}

/**
 * The width a look was taken at, as a sentence ends with it: the viewport's width, and the edge as well when a
 * scrollbar takes part of it.
 *
 * @example describeWidth(look) // 'at 390 pixels wide'
 */
export function describeWidth(look: Pick<LayoutLook, 'viewport' | 'edge'>): string {
  const width = `at ${roundPixels(look.viewport.width)} pixels wide`
  return look.edge === look.viewport.width ? width : `${width}, ${roundPixels(look.edge)} without the scrollbar`
}

function holds(outer: LayoutBox, inner: LayoutBox): boolean {
  const slack = layoutLimits.tolerance
  return inner.left >= outer.left - slack && inner.right <= outer.right + slack && inner.top >= outer.top - slack && inner.bottom <= outer.bottom + slack
}
