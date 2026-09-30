import type { Observation } from './commands.ts'
import { observedItemLimit } from './commands.ts'
import { s, type Schema } from './schema.ts'
import { normalizeText, quoteText, textComparison } from './text.ts'

/** What a locator assertion looks for in each observation. */
export type LocatorCheck = {
  readonly matcher: LocatorCheckRecord['matcher']
  readonly expected: string
  readonly comparison?: string
  /** A check about the one element that matches: none is `not_found`, and several `ambiguous`. */
  readonly single: boolean
  passes(observation: Observation): boolean
  actual(observation: Observation): string | null
  /** Why the elements that matched did not pass, as a sentence. */
  mismatch(observation: Observation, locator: string): string
}

/**
 * A locator matcher and its arguments, whole. The test process sends it with each locator assertion, and the
 * parent rebuilds the check from it to judge the observation the assertion names.
 */
export type LocatorCheckRecord =
  | { matcher: 'toBeVisible' | 'toBeHidden' }
  | { matcher: 'toHaveText'; text: string }
  | { matcher: 'toHaveText'; texts: string[] }
  | { matcher: 'toHaveCount'; count: number }
  | { matcher: 'toHaveValue'; value: string }

export const locatorCheckRecordSchema: Schema<LocatorCheckRecord> = s.union([
  s.object({ matcher: s.enum(['toBeVisible', 'toBeHidden']) }),
  s.object({ matcher: s.literal('toHaveText'), text: s.string() }),
  s.object({ matcher: s.literal('toHaveText'), texts: s.array(s.string()) }),
  s.object({ matcher: s.literal('toHaveCount'), count: s.number({ integer: true, min: 0 }) }),
  s.object({ matcher: s.literal('toHaveValue'), value: s.string() }),
])

/**
 * The rule the test process polls with and the parent judges with.
 *
 * @example locatorCheck({ matcher: 'toHaveText', text: 'Saved' }).passes(observation)
 */
export function locatorCheck(record: LocatorCheckRecord): LocatorCheck {
  switch (record.matcher) {
    case 'toBeVisible':
      return visibleCheck()
    case 'toBeHidden':
      return hiddenCheck()
    case 'toHaveText':
      return 'texts' in record ? textsCheck(record.texts) : textCheck(record.text)
    case 'toHaveCount':
      return countCheck(record.count)
    case 'toHaveValue':
      return valueCheck(record.value)
  }
}

const listComparison = `every match in order, each by ${textComparison}`

/** Passes when exactly one element matches and it is visible. */
export function visibleCheck(): LocatorCheck {
  return {
    matcher: 'toBeVisible',
    expected: 'visible',
    single: true,
    passes: (observation) => observation.count === 1 && observation.visible === true,
    actual: (observation) => (observation.visible === null ? null : observation.visible ? 'visible' : 'hidden'),
    mismatch: (_observation, locator) => `${locator} is hidden.`,
  }
}

/** Passes when nothing matches, or nothing that matches is visible. More matches than Retest reads cannot pass. */
export function hiddenCheck(): LocatorCheck {
  return {
    matcher: 'toBeHidden',
    expected: 'hidden',
    single: false,
    passes: (observation) => observation.count === 0 || (!observation.itemsTruncated && visibleCount(observation) === 0),
    actual: (observation) => {
      if (observation.count === 0) return 'no element'
      if (observation.count === 1) return observation.visible === true ? 'visible' : 'hidden'
      return `${visibleCount(observation)} of ${observation.count} visible`
    },
    mismatch: (observation, locator) => {
      if (observation.itemsTruncated) {
        return `${locator} matched ${observation.count} elements. Retest reads the first ${observedItemLimit}, so it cannot tell that all are hidden.`
      }
      if (observation.count === 1) return `${locator} is visible.`
      const visible = visibleCount(observation)
      return `${locator} matched ${observation.count} elements, and ${visible} of them ${visible === 1 ? 'is' : 'are'} visible.`
    },
  }
}

/** Passes when exactly one element matches and its whole text equals `expected` under `textComparison`. */
export function textCheck(expected: string): LocatorCheck {
  const wanted = normalizeText(expected)
  return {
    matcher: 'toHaveText',
    expected,
    comparison: textComparison,
    single: true,
    passes: (observation) => observation.count === 1 && observation.text !== null && normalizeText(observation.text) === wanted,
    actual: (observation) => observation.text,
    mismatch: (observation, locator) =>
      `${locator} has text ${quoteText(observation.text ?? '')}, expected ${quoteText(expected)}. Compared ${textComparison}.`,
  }
}

/** Passes when the matches, hidden ones included, have exactly these texts in document order. */
export function textsCheck(expected: readonly string[]): LocatorCheck {
  const wanted = expected.map(normalizeText)
  const differsAt = (observation: Observation): number =>
    observation.items.findIndex((item, index) => normalizeText(item.text) !== wanted[index])
  return {
    matcher: 'toHaveText',
    expected: JSON.stringify(expected),
    comparison: listComparison,
    single: false,
    passes: (observation) => !observation.itemsTruncated && observation.count === wanted.length && differsAt(observation) === -1,
    actual: (observation) => JSON.stringify(observation.items.map((item) => item.text)),
    mismatch: (observation, locator) => {
      if (observation.count !== wanted.length) return `${locator} matched ${elements(observation.count)}, expected ${expected.length}.`
      if (observation.itemsTruncated) {
        return `${locator} matched ${observation.count} elements. Retest reads the first ${observedItemLimit}, so it cannot compare every text.`
      }
      const index = differsAt(observation)
      const item = observation.items[index]
      return `Match ${index + 1} of ${locator} has text ${quoteText(item?.text ?? '')}, expected ${quoteText(expected[index] ?? '')}. Compared ${textComparison}.`
    },
  }
}

/** Passes when exactly `count` elements match, visible or not. */
export function countCheck(count: number): LocatorCheck {
  return {
    matcher: 'toHaveCount',
    expected: String(count),
    single: false,
    passes: (observation) => observation.count === count,
    actual: (observation) => String(observation.count),
    mismatch: (observation, locator) => `${locator} matched ${elements(observation.count)}, expected ${count}.`,
  }
}

/** Passes when exactly one element matches, it is a field, and its value is exactly `expected`. */
export function valueCheck(expected: string): LocatorCheck {
  return {
    matcher: 'toHaveValue',
    expected,
    comparison: 'the whole value, exactly',
    single: true,
    passes: (observation) => observation.count === 1 && observation.value === expected,
    actual: (observation) => observation.value,
    mismatch: (observation, locator) =>
      observation.value === null
        ? `${locator} is not a field with a value.`
        : `${locator} has value ${quoteText(observation.value)}, expected ${quoteText(expected)}.`,
  }
}

function visibleCount(observation: Observation): number {
  return observation.items.filter((item) => item.visible).length
}

function elements(count: number): string {
  if (count === 0) return 'no element'
  return count === 1 ? '1 element' : `${count} elements`
}
