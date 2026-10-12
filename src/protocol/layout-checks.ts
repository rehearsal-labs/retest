import type { FailureClass } from './failures.ts'
import type { LayoutLook, MeasuredElement, Shared, ViewportSize } from './layout.ts'
import type { LocatorRecipe } from './locator.ts'
import {
  crossesEdge,
  describePixels,
  describeWidth,
  fieldAround,
  layoutLimits,
  overlapping,
  pastEdge,
  roundPixels,
  scrollsSideways,
  sharedBetween,
  viewportSizeSchema,
  wordsCutOff,
} from './layout.ts'
import { describeEmptyStep, describeLocator, locatorRecipeSchema } from './locator.ts'
import { s, type Schema } from './schema.ts'

/**
 * A layout matcher and its arguments, whole, and `not` when the test negated it. `toOverlap` names the other element's
 * locator; the element it is called on is the assertion's own `locator`. `toScrollHorizontally` is a page matcher and
 * has no locator.
 */
export type LayoutCheckRecord = { not?: true } & (
  | { matcher: 'toOverlap'; other: LocatorRecipe }
  | { matcher: 'toOverflowViewport' }
  | { matcher: 'toHaveClippedText' }
  | { matcher: 'toScrollHorizontally' }
)

const not = s.optional(s.literal(true))

export const layoutCheckRecordSchema: Schema<LayoutCheckRecord> = s.union([
  s.object({ matcher: s.literal('toOverlap'), other: locatorRecipeSchema, not }),
  s.object({ matcher: s.literal('toOverflowViewport'), not }),
  s.object({ matcher: s.literal('toHaveClippedText'), not }),
  s.object({ matcher: s.literal('toScrollHorizontally'), not }),
])

/** The layout matchers' names, as a test writes them. */
export const layoutMatchers: readonly LayoutCheckRecord['matcher'][] = ['toOverlap', 'toOverflowViewport', 'toHaveClippedText', 'toScrollHorizontally']

/**
 * What a layout look must measure for a check: the element the check is on, the other element `toOverlap` compares it
 * with, and, for `toHaveClippedText`, the words. A page check measures no element.
 */
export type LayoutRequest = { locator?: LocatorRecipe; other?: LocatorRecipe; words?: true }

/**
 * The look a layout check needs, from its record and the locator it was called on.
 *
 * @example layoutRequest({ matcher: 'toOverlap', other: help }, save) // { locator: save, other: help }
 */
export function layoutRequest(record: LayoutCheckRecord, locator: LocatorRecipe | undefined): LayoutRequest {
  const own = locator === undefined || record.matcher === 'toScrollHorizontally' ? {} : { locator }
  if (record.matcher === 'toOverlap') return { ...own, other: record.other }
  return record.matcher === 'toHaveClippedText' ? { ...own, words: true } : own
}

/**
 * What a layout look measured for a check, as its assertion event records it, in CSS pixels to a tenth. `viewport` and
 * `edge`, the viewport's width without its scrollbar, are always there. `shared` is what the visible boxes of the
 * two elements `toOverlap` compares share, across and down; `pastEdge` how far the visible part of the element ends
 * past the right edge, negative before it; `cut` the most a container cuts off of its words; `documentWidth` how wide
 * the document is. Each is present only once the look could measure it.
 */
export type LayoutRecord = {
  viewport: ViewportSize
  edge: number
  shared?: Shared
  pastEdge?: number
  cut?: number
  documentWidth?: number
}

export const layoutRecordSchema: Schema<LayoutRecord> = s.object({
  viewport: viewportSizeSchema,
  edge: s.number({ min: 0 }),
  shared: s.optional(s.object({ across: s.number(), down: s.number() })),
  pastEdge: s.optional(s.number()),
  cut: s.optional(s.number({ min: 0 })),
  documentWidth: s.optional(s.number({ min: 0 })),
})

/** Why a look did not pass a layout check: as a check about one element, `not_found` or `ambiguous`, else `check_failed`. */
export type LayoutUnmet = { class: Extract<FailureClass, 'not_found' | 'ambiguous' | 'check_failed'>; message: string }

/** What a layout assertion looks for in each look, and how it says what it saw. */
export type LayoutCheck = {
  /** The matcher as the test wrote it: `not.` before it when negated. */
  readonly matcher: string
  readonly expected: string
  readonly comparison: string
  passes(look: LayoutLook): boolean
  actual(look: LayoutLook): string | null
  /** What the look measured for this check. */
  measured(look: LayoutLook): LayoutRecord
  /** Why the look did not pass, naming `locator`, the element the check was called on. */
  unmet(look: LayoutLook, locator: LocatorRecipe | undefined): LayoutUnmet
}

/**
 * The rule the test process polls a layout check with, and the parent judges it with. A check passes only on a look
 * that measured what it needs: exactly one shown element for each locator, two separate elements for `toOverlap`, and
 * words for `toHaveClippedText`. A look that could not measure that passes neither way, so a missing or hidden element
 * is never read as a layout problem or as its absence.
 *
 * @example layoutCheck({ matcher: 'toOverlap', other: help, not: true }).passes(look)
 */
export function layoutCheck(record: LayoutCheckRecord): LayoutCheck {
  const negated = record.not === true
  const rule = layoutRule(record)
  const verdict = (look: LayoutLook, locator: LocatorRecipe | undefined): Verdict => rule.judge(look, describeTarget(locator), locator)
  return {
    matcher: negated ? `not.${record.matcher}` : record.matcher,
    expected: negated ? rule.negatedExpected : rule.expected,
    comparison: rule.comparison,
    passes: (look) => {
      const judged = verdict(look, undefined)
      return judged.measured && judged.holds === !negated
    },
    actual: (look) => verdict(look, undefined).actual,
    measured: (look) => {
      const judged = verdict(look, undefined)
      return { viewport: look.viewport, edge: look.edge, ...(judged.measured ? judged.record : {}) }
    },
    unmet: (look, locator) => {
      const judged = verdict(look, locator)
      if (!judged.measured) return judged.why
      return { class: 'check_failed', message: judged.holds ? judged.met : judged.unmet }
    },
  }
}

/** What one rule measured, beside the viewport and the edge every record has. */
type Measurement = Omit<LayoutRecord, 'viewport' | 'edge'>

/**
 * The look as one rule reads it: measured, with what it measured, whether the condition holds and a sentence each way,
 * or why it could not be measured.
 */
type Verdict =
  | { measured: true; holds: boolean; actual: string; record: Measurement; met: string; unmet: string }
  | { measured: false; actual: string | null; why: LayoutUnmet }

type LayoutRule = {
  expected: string
  negatedExpected: string
  comparison: string
  judge(look: LayoutLook, described: string, locator: LocatorRecipe | undefined): Verdict
}

function layoutRule(record: LayoutCheckRecord): LayoutRule {
  switch (record.matcher) {
    case 'toOverlap':
      return overlapRule(record.other, matcherName(record))
    case 'toOverflowViewport':
      return edgeRule(matcherName(record))
    case 'toHaveClippedText':
      return clippedRule(matcherName(record))
    case 'toScrollHorizontally':
      return scrollRule
  }
}

function matcherName(record: LayoutCheckRecord): string {
  return record.not === true ? `not.${record.matcher}` : record.matcher
}

const apart = 'Compare two separate elements.'

function overlapRule(other: LocatorRecipe, matcher: string): LayoutRule {
  const second = describeLocator(other)
  const limit = layoutLimits.overlap
  return {
    expected: `share more than ${limit} by ${limit} pixels with ${second}`,
    negatedExpected: `share no more than ${limit} pixels across or down with ${second}`,
    comparison: 'the visible boxes of both elements, each cut by the containers around it that limit overflow; a control inside a field never overlaps it',
    judge: (look, first, locator) => {
      const one = oneShown(look, 0, { described: first, locator, matcher })
      if (!one.ok) return one.verdict
      const two = oneShown(look, 1, { described: second, locator: other, matcher })
      if (!two.ok) return two.verdict
      if (look.nesting !== undefined) {
        const why = { class: 'check_failed', message: nestingSentence(look.nesting, first, second) } as const
        return { measured: false, actual: look.nesting === 'same' ? 'the same element' : 'one holds the other', why }
      }
      const shared = sharedBetween(one.element, two.element)
      const record = { shared: { across: roundPixels(shared.across), down: roundPixels(shared.down) } }
      const width = describeWidth(look)
      const touch = shared.across > 0 && shared.down > 0
      const sharing = touch ? `share ${roundPixels(shared.across)} by ${describePixels(shared.down)} ${width}` : `do not touch ${width}`
      return {
        measured: true,
        holds: overlapping(one.element, two.element),
        actual: sharing,
        record,
        met: `${first} and ${second} overlap: they ${sharing}.`,
        unmet: underlapSentence({ one: one.element, two: two.element, first, second, sharing, touch }),
      }
    },
  }
}

function nestingSentence(nesting: NonNullable<LayoutLook['nesting']>, first: string, second: string): string {
  if (nesting === 'same') return `${first} and ${second} find the same element, so they cannot overlap. ${apart}`
  const [outer, inner] = nesting === 'first' ? [first, second] : [second, first]
  return `${outer} holds ${inner}, so they cannot overlap. ${apart}`
}

type Underlap = { one: MeasuredElement; two: MeasuredElement; first: string; second: string; sharing: string; touch: boolean }

// Why two measured elements do not overlap: one sits inside the other as a control in its field, they share too little,
// or they do not touch.
function underlapSentence({ one, two, first, second, sharing, touch }: Underlap): string {
  if (!touch) return `${first} and ${second} ${sharing}.`
  const field = fieldAround(one, two)
  if (field !== undefined) {
    const [outer, inner] = field === 'first' ? [first, second] : [second, first]
    return `${inner} sits inside the field ${outer}, and a control inside a field never overlaps it. They ${sharing}.`
  }
  return `${first} and ${second} ${sharing.replace(/^share /, 'share only ')}, and an overlap is more than ${layoutLimits.overlap} pixels each way.`
}

function edgeRule(matcher: string): LayoutRule {
  const tolerance = describePixels(layoutLimits.tolerance)
  return {
    expected: `ends more than ${tolerance} past the right edge`,
    negatedExpected: `ends no more than ${tolerance} past the right edge`,
    comparison: "the right end of its visible box, against the viewport's width without its scrollbar",
    judge: (look, described, locator) => {
      const one = oneShown(look, 0, { described, locator, matcher })
      if (!one.ok) return one.verdict
      const past = roundPixels(pastEdge(one.element, look.edge))
      const width = describeWidth(look)
      const ends = past > 0 ? `ends ${describePixels(past)} past the right edge ${width}` : past < 0 ? `ends ${describePixels(-past)} before the right edge ${width}` : `ends at the right edge ${width}`
      // Within a pixel past the edge is where rounding alone can put an element, so it is not yet past it.
      const unmet = past > 0 ? `${described} ${ends}, and only more than ${tolerance} counts.` : `${described} ${ends}.`
      return { measured: true, holds: crossesEdge(one.element, look.edge), actual: ends, record: { pastEdge: past }, met: `${described} ${ends}.`, unmet }
    },
  }
}

function clippedRule(matcher: string): LayoutRule {
  const limit = describePixels(layoutLimits.clipped)
  return {
    expected: `more than ${limit} of its words cut off`,
    negatedExpected: `no more than ${limit} of its words cut off`,
    comparison: `its words and those of up to ${layoutLimits.descendants} elements inside it, against every container that hides overflow; text shortened on purpose with an ellipsis or a line clamp is not cut off`,
    judge: (look, described, locator) => {
      const one = oneShown(look, 0, { described, locator, matcher })
      if (!one.ok) return one.verdict
      const { cut } = one.element
      if (cut === undefined || cut === null) {
        const why = { class: 'check_failed', message: `${described} shows no words, so Retest cannot tell whether a container cuts them off.` } as const
        return { measured: false, actual: 'no words', why }
      }
      const width = describeWidth(look)
      const amount = roundPixels(cut)
      const met = `A container cuts off ${describePixels(amount)} of the words in ${described} ${width}.`
      const unmet = amount === 0 ? `No container cuts off the words in ${described} ${width}.` : `A container cuts off only ${describePixels(amount)} of the words in ${described} ${width}, and only more than ${limit} counts.`
      return { measured: true, holds: wordsCutOff(cut), actual: `cut ${describePixels(amount)} ${width}`, record: { cut: amount }, met, unmet }
    },
  }
}

const scrollRule: LayoutRule = {
  expected: 'scrolls sideways',
  negatedExpected: 'does not scroll sideways',
  comparison: "the document's width against the viewport's width without its scrollbar, unless the page hides what runs past it",
  judge: (look) => {
    const width = describeWidth(look)
    const documentWidth = roundPixels(look.documentWidth)
    const actual = `document ${documentWidth} pixels wide ${width}${look.hidesSideways ? ', overflow hidden' : ''}`
    const met = `The page is ${documentWidth} pixels wide and scrolls ${describePixels(look.documentWidth - look.edge)} sideways ${width}.`
    return { measured: true, holds: scrollsSideways(look), actual, record: { documentWidth }, met, unmet: stillSentence(look, documentWidth, width) }
  },
}

// Why a page does not scroll sideways: it fits, it hides what runs past the viewport, or it is wider by a rounding.
function stillSentence(look: LayoutLook, documentWidth: number, width: string): string {
  if (documentWidth <= roundPixels(look.edge)) return `The page fits its viewport ${width}, so it does not scroll sideways.`
  if (look.hidesSideways) return `The page is ${documentWidth} pixels wide ${width}, but it hides what runs past the viewport, so it does not scroll sideways.`
  return `The page is ${documentWidth} pixels wide ${width}, and only more than ${describePixels(layoutLimits.tolerance)} past the edge counts.`
}

type Locating = { described: string; locator: LocatorRecipe | undefined; matcher: string }

// The one shown element a look measured for a locator, or why it measured none: no match, several, or one not shown.
function oneShown(look: LayoutLook, index: number, { described, locator, matcher }: Locating): { ok: true; element: MeasuredElement } | { ok: false; verdict: Verdict } {
  const target = look.targets[index]
  const unmeasured = (why: LayoutUnmet, actual: string | null): { ok: false; verdict: Verdict } => ({ ok: false, verdict: { measured: false, actual, why } })
  if (target === undefined) return unmeasured({ class: 'check_failed', message: `Retest's look did not measure ${described}.` }, null)
  if (target.count === 0) {
    const step = target.emptyStep === undefined || locator === undefined ? undefined : describeEmptyStep(locator, target.emptyStep)
    return unmeasured({ class: 'not_found', message: `${described} matched no element.${step === undefined ? '' : ` ${step}`}` }, null)
  }
  if (target.count > 1) return unmeasured({ class: 'ambiguous', message: `${described} matched ${target.count} elements, and ${matcher} needs exactly one.` }, null)
  const { element } = target
  if (element === undefined || !element.shown) return unmeasured({ class: 'check_failed', message: `${described} is not shown, so Retest cannot measure it.` }, 'not shown')
  return { ok: true, element }
}

function describeTarget(locator: LocatorRecipe | undefined): string {
  return locator === undefined ? 'The element' : describeLocator(locator)
}
