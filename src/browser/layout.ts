import type { PageWorld } from './isolated-world.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { Failure } from '../protocol/failures.ts'
import type { LayoutBox, LayoutLook, LayoutTarget, MeasuredElement, Nesting } from '../protocol/layout.ts'
import type { LayoutRequest } from '../protocol/layout-checks.ts'
import type { EmptyStep, LocatorRecipe } from '../protocol/locator.ts'
import type { PageFacts } from '../protocol/page-facts.ts'
import type { Schema } from '../protocol/schema.ts'
import { failure } from '../protocol/failures.ts'
import { layoutLimits } from '../protocol/layout.ts'
import { emptyStepSchema } from '../protocol/locator.ts'
import { s } from '../protocol/schema.ts'
import { documentFactsSchema, pageFactsOf } from './document-facts.ts'
import { locatorsArguments } from './locate.ts'
import { layoutFunction } from './page-scripts.ts'

/** As much of an element's computed style as a layout look reads, as the browser writes each value. */
export type ReadStyle = {
  display: string
  visibility: string
  opacity: number
  position: string
  overflowX: string
  overflowY: string
  textOverflow: string
  /** `-webkit-line-clamp`, which is `none` unless the element clamps its lines. */
  lineClamp: string
}

/**
 * One element a layout look read, in a list where each element's parent comes before it. `parent` is the place of its
 * parent in the list, or -1 for the body, where every list starts: the body stands for the document, and what crosses
 * it crosses the viewport. `words` says it holds text of its own that is not blank, and `field` that it is a text
 * field, a select or a text area. `overrun` is how far its content runs past its client box, as its scroll size less
 * its client size, across and down.
 */
export type ReadNode = {
  parent: number
  box: LayoutBox
  style: ReadStyle
  words: boolean
  field: boolean
  overrun: { across: number; down: number }
}

/**
 * What one locator found: how many elements, the first step that kept none, and for exactly one element inside the
 * body its place in the list, with the places of the elements inside it whose words were read. An element outside the
 * body, the body itself included, has no place.
 */
export type ReadTarget = { count: number; emptyStep?: EmptyStep; node: number | null; inner: number[] }

/**
 * The page as a layout look reads it: the viewport's size, its width without the scrollbar as the root's client width,
 * the root's scroll width, and the root's and the body's `overflow-x`.
 */
export type ReadPage = { width: number; height: number; edge: number; scrollWidth: number; rootOverflowX: string; bodyOverflowX: string | null }

/** Everything one layout look read in the page, before any rule is applied to it. */
export type LayoutReading = { targets: ReadTarget[]; nodes: ReadNode[]; page: ReadPage }

const box: Schema<LayoutBox> = s.object({ left: s.number(), top: s.number(), right: s.number(), bottom: s.number() })

const readNodeSchema: Schema<ReadNode> = s.object({
  parent: s.number({ integer: true, min: -1 }),
  box,
  style: s.object({
    display: s.string(),
    visibility: s.string(),
    opacity: s.number(),
    position: s.string(),
    overflowX: s.string(),
    overflowY: s.string(),
    textOverflow: s.string(),
    lineClamp: s.string(),
  }),
  words: s.boolean(),
  field: s.boolean(),
  overrun: s.object({ across: s.number(), down: s.number() }),
})

/** What Retest's layout page function answers with when it read the page, before anything is measured. */
export const layoutReadingSchema: Schema<LayoutReading> = s.object({
  targets: s.array(
    s.object({
      count: s.number({ integer: true, min: 0 }),
      emptyStep: s.optional(emptyStepSchema),
      node: s.nullable(s.number({ integer: true, min: 0 })),
      inner: s.array(s.number({ integer: true, min: 0 })),
    }),
  ),
  nodes: s.array(readNodeSchema),
  page: s.object({
    width: s.number({ min: 0 }),
    height: s.number({ min: 0 }),
    edge: s.number({ min: 0 }),
    scrollWidth: s.number({ min: 0 }),
    rootOverflowX: s.string(),
    bodyOverflowX: s.nullable(s.string()),
  }),
})

const place = s.number({ integer: true, min: 0 })

const answerSchema = s.union([
  s.object({ reading: layoutReadingSchema, page: documentFactsSchema }),
  s.object({ invalid: s.object({ step: place, message: s.string() }), query: place }),
  s.object({ shadow: s.string(), query: place }),
])

/**
 * What one layout look read: the look and the page it read it on, or, with the locator it was in, a CSS selector the
 * page could not read or the host of an open shadow root a locator by Playwright's rules refuses to look past.
 */
export type LayoutRead =
  | { look: LayoutLook; page: PageFacts }
  | { invalid: { step: number; message: string }; locator: LocatorRecipe }
  | { shadow: string; locator: LocatorRecipe }

/**
 * Reads the page for a layout check in one call of Retest's world, so no script of the page runs between the
 * elements it reads, and measures what it read by `measureLayout`'s rules. Never waits, and sends no input.
 */
export async function readLayout(world: PageWorld, request: LayoutRequest, deadline: Deadline): Promise<LayoutRead> {
  const locators = [request.locator, request.other].filter((locator): locator is LocatorRecipe => locator !== undefined)
  const words = request.words === true
  const answer = await world.call(layoutFunction, locatorsArguments(locators, [words, layoutLimits.descendants]), answerSchema, deadline)
  if ('reading' in answer) return { look: measureLayout(answer.reading, words), page: pageFactsOf(answer.page) }
  const locator = locators[answer.query]
  if (locator === undefined) throw new Error(`Retest's layout look named locator ${answer.query} of ${locators.length}`)
  return 'invalid' in answer ? { invalid: answer.invalid, locator } : { shadow: answer.shadow, locator }
}

const everywhere: LayoutBox = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity }
const nowhere: LayoutBox = { left: 0, top: 0, right: 0, bottom: 0 }

/**
 * What a layout look's reading measures, by these rules:
 *
 * - An element's visible box is its client rect cut down, along each axis, by every container around it whose
 *   overflow on that axis is not `visible`. The body is the document and cuts nothing. A fixed element stands on the
 *   viewport, so nothing above it cuts it, and a fixed container cuts what is inside it while nothing above it does.
 * - It is shown when it is inside the body, neither it nor any element around it has `display: none` or an opacity of
 *   0, its own `visibility` is `visible`, and its visible box is at least `layoutLimits.shown` pixels each way.
 * - A container cuts off words only along an axis whose overflow is `hidden` or `clip`, and never when it shortens its
 *   text on purpose with `text-overflow: ellipsis` or a line clamp. An element's words are cut by the most they run
 *   past what those containers keep, or past its own box when it hides its own overflow, as long as at least
 *   `layoutLimits.shown` pixels of them stay in view. An element with no words of its own has none to cut, and the cut
 *   of a measured element is the most of its own and of the elements inside it whose words were read.
 * - The edge is the viewport's width without its scrollbar. The viewport hides what runs past it sideways when the
 *   root's `overflow-x` is `hidden` or `clip`, or the body's is while the root's is `visible`.
 *
 * A reading whose list names a parent after its child, or a place it does not have, is not Retest's page function
 * answering, and throws.
 *
 * @example measureLayout(reading, false).targets[0]?.element?.shown // true
 */
export function measureLayout(reading: LayoutReading, words: boolean): LayoutLook {
  const { nodes, page } = reading
  nodes.forEach((node, index) => {
    if (node.parent >= index) throw new Error(`Retest's layout look listed element ${index} before its parent ${node.parent}`)
  })
  const targets = reading.targets.map((target) => measureTarget(nodes, target, words))
  const nesting = reading.targets.length === 2 ? nestingOf(nodes, reading.targets) : undefined
  return {
    viewport: { width: page.width, height: page.height },
    edge: page.edge,
    documentWidth: page.scrollWidth,
    hidesSideways: hides(page.rootOverflowX !== 'visible' || page.bodyOverflowX === null ? page.rootOverflowX : page.bodyOverflowX),
    targets,
    ...(nesting === undefined ? {} : { nesting }),
  }
}

function measureTarget(nodes: readonly ReadNode[], target: ReadTarget, words: boolean): LayoutTarget {
  const counted = target.emptyStep === undefined ? { count: target.count } : { count: target.count, emptyStep: target.emptyStep }
  if (target.count !== 1) return counted
  const read = words ? { cut: null } : {}
  if (target.node === null) return { ...counted, element: { shown: false, box: nowhere, seen: nowhere, field: false, ...read } }
  const node = nodeAt(nodes, target.node)
  const frame = frameOf(nodes, target.node)
  const element: MeasuredElement = { shown: frame.shown, box: frame.box, seen: frame.seen, field: node.field }
  if (!words) return { ...counted, element }
  const cuts = [target.node, ...target.inner].map((index) => cutOf(nodes, index)).filter((cut): cut is number => cut !== null)
  return { ...counted, element: { ...element, cut: cuts.length === 0 ? null : Math.max(...cuts) } }
}

/** An element as the containers around it leave it: its box, its visible box, the region its words may fill, and whether it is shown. */
type Frame = { box: LayoutBox; seen: LayoutBox; kept: LayoutBox; shown: boolean }

function frameOf(nodes: readonly ReadNode[], index: number): Frame {
  const node = nodeAt(nodes, index)
  let clip = everywhere
  let kept = everywhere
  let faded = node.style.opacity === 0
  let undisplayed = node.style.display === 'none'
  let standing = node.style.position === 'fixed'
  for (let at = node.parent; at >= 0; ) {
    const parent = nodeAt(nodes, at)
    faded ||= parent.style.opacity === 0
    undisplayed ||= parent.style.display === 'none'
    at = parent.parent
    if (standing || parent.parent === -1) continue
    const { overflowX, overflowY } = parent.style
    clip = within(clip, parent.box, { across: overflowX !== 'visible', down: overflowY !== 'visible' })
    const cuts = !shortens(parent.style)
    kept = within(kept, parent.box, { across: cuts && hides(overflowX), down: cuts && hides(overflowY) })
    standing = parent.style.position === 'fixed'
  }
  const seen = meet(node.box, clip)
  const shown = !undisplayed && !faded && node.style.visibility === 'visible' && shows(seen)
  return { box: node.box, seen, kept, shown }
}

function cutOf(nodes: readonly ReadNode[], index: number): number | null {
  const node = nodeAt(nodes, index)
  if (!node.words) return null
  const { box, kept, shown } = frameOf(nodes, index)
  if (!shown || !shows(meet(box, kept))) return null
  const lost = Math.max(kept.left - box.left, box.right - kept.right, kept.top - box.top, box.bottom - kept.bottom)
  const cutsItself = !shortens(node.style)
  const ownLost = Math.max(cutsItself && hides(node.style.overflowX) ? node.overrun.across : 0, cutsItself && hides(node.style.overflowY) ? node.overrun.down : 0)
  return Math.max(0, lost, ownLost)
}

function nestingOf(nodes: readonly ReadNode[], [first, second]: readonly ReadTarget[]): Nesting | undefined {
  const one = first?.count === 1 ? first.node : null
  const other = second?.count === 1 ? second.node : null
  if (one === null || other === null) return undefined
  if (one === other) return 'same'
  if (holdsNode(nodes, one, other)) return 'first'
  return holdsNode(nodes, other, one) ? 'second' : undefined
}

function holdsNode(nodes: readonly ReadNode[], outer: number, inner: number): boolean {
  for (let at = nodeAt(nodes, inner).parent; at >= 0; at = nodeAt(nodes, at).parent) if (at === outer) return true
  return false
}

function nodeAt(nodes: readonly ReadNode[], index: number): ReadNode {
  const node = nodes[index]
  if (node === undefined) throw new Error(`Retest's layout look named element ${index} of ${nodes.length}`)
  return node
}

function hides(overflow: string): boolean {
  return overflow === 'hidden' || overflow === 'clip'
}

// Text an element shortens on purpose, with an ellipsis or a line clamp, is shortened rather than cut off.
function shortens(style: ReadStyle): boolean {
  return style.textOverflow === 'ellipsis' || style.lineClamp !== 'none'
}

function meet(first: LayoutBox, second: LayoutBox): LayoutBox {
  return {
    left: Math.max(first.left, second.left),
    top: Math.max(first.top, second.top),
    right: Math.min(first.right, second.right),
    bottom: Math.min(first.bottom, second.bottom),
  }
}

// What a container leaves of a region, along the axes it limits.
function within(region: LayoutBox, container: LayoutBox, axes: { across: boolean; down: boolean }): LayoutBox {
  return {
    left: axes.across ? Math.max(region.left, container.left) : region.left,
    right: axes.across ? Math.min(region.right, container.right) : region.right,
    top: axes.down ? Math.max(region.top, container.top) : region.top,
    bottom: axes.down ? Math.min(region.bottom, container.bottom) : region.bottom,
  }
}

function shows(region: LayoutBox): boolean {
  return region.right - region.left >= layoutLimits.shown && region.bottom - region.top >= layoutLimits.shown
}

/**
 * The answer of a page whose engine Retest does not measure layout on yet. Nothing is read, and no input is sent.
 *
 * @example layoutUnmeasured('Firefox').class // 'unsupported'
 */
export function layoutUnmeasured(engine: string): Failure {
  return failure('unsupported', `Retest measures layout on Chrome and Chromium only, and not on ${engine} yet, so it measured nothing.`)
}
