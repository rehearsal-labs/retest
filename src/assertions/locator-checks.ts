import type { LocatorCheck } from './poll-locator.ts'
import { quoteText } from './format.ts'
import { normalizeText, textComparison } from './text.ts'

/** Passes when exactly one element matches and it is visible. */
export function visibleCheck(): LocatorCheck {
  return {
    matcher: 'toBeVisible',
    expected: 'visible',
    passes: (observation) => observation.count === 1 && observation.visible === true,
    actual: (observation) => (observation.visible === null ? null : observation.visible ? 'visible' : 'hidden'),
    mismatch: (_observation, locator) => `${locator} is hidden.`,
  }
}

/** Passes when exactly one element matches and its whole text equals `expected` under `textComparison`. */
export function textCheck(expected: string): LocatorCheck {
  const wanted = normalizeText(expected)
  return {
    matcher: 'toHaveText',
    expected,
    comparison: textComparison,
    passes: (observation) => observation.count === 1 && observation.text !== null && normalizeText(observation.text) === wanted,
    actual: (observation) => observation.text,
    mismatch: (observation, locator) =>
      `${locator} has text ${quoteText(observation.text ?? '')}, expected ${quoteText(expected)}. Compared ${textComparison}.`,
  }
}
