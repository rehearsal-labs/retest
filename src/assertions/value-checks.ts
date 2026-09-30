import { formatValue } from '../api/format-value.ts'
import { shorten } from '../protocol/text.ts'
import { equalComparison, firstDifference } from './deep-equal.ts'

/** What a value matcher checks, for `expect` and for each look of `expect.poll`. */
export type ValueCheck = {
  readonly matcher: 'toBe' | 'toEqual' | 'toContain' | 'toMatch'
  /** The expected value as messages show it. */
  readonly expected: string
  readonly comparison: string
  /** Why `actual` does not pass, as a sentence, or undefined when it passes. */
  mismatch(actual: unknown): string | undefined
}

const sameValue = 'Object.is'
const containment = 'text holds it, case-sensitive; an array holds an item equal to it by SameValueZero'
const search = 'a RegExp search anywhere in the text, with the flags of the pattern'

/** Passes when the value is `expected` by `Object.is`. */
export function sameCheck(expected: unknown): ValueCheck {
  const shown = formatValue(expected)
  return {
    matcher: 'toBe',
    expected: shown,
    comparison: sameValue,
    mismatch: (actual) =>
      Object.is(actual, expected) ? undefined : `Expected ${shorten(shown)}, received ${shorten(formatValue(actual))}. toBe compares with ${sameValue}.`,
  }
}

/** Passes when the value equals `expected` under `equalComparison`, and says where they first differ. */
export function equalCheck(expected: unknown): ValueCheck {
  const shown = formatValue(expected)
  return {
    matcher: 'toEqual',
    expected: shown,
    comparison: equalComparison,
    mismatch: (actual) => {
      const path = firstDifference(actual, expected)
      if (path === undefined) return undefined
      const where = path === '' ? '' : ` They differ at ${path.replace(/^\./, '')}.`
      return `Expected ${shorten(shown)}, received ${shorten(formatValue(actual))}.${where}`
    },
  }
}

/** Passes when a string holds the text `expected`, or an array holds `expected` as one of its items. */
export function containCheck(expected: unknown): ValueCheck {
  const shown = formatValue(expected)
  return {
    matcher: 'toContain',
    expected: shown,
    comparison: containment,
    mismatch: (actual) => {
      if (typeof actual === 'string' && typeof expected === 'string') return actual.includes(expected) ? undefined : notIn(actual, shown)
      if (Array.isArray(actual)) return actual.includes(expected) ? undefined : notIn(actual, shown)
      return `Expected ${typeof expected === 'string' ? 'a string or an array' : 'an array'} to look in, received ${shorten(formatValue(actual))}.`
    },
  }
}

/** Passes when the text matches `pattern` anywhere. The pattern's `lastIndex` is left as it was. */
export function matchCheck(pattern: RegExp): ValueCheck {
  return {
    matcher: 'toMatch',
    expected: String(pattern),
    comparison: search,
    mismatch: (actual) => {
      if (typeof actual !== 'string') return `Expected text to match ${String(pattern)}, received ${shorten(formatValue(actual))}.`
      return actual.search(pattern) === -1 ? `Expected ${shorten(formatValue(actual))} to match ${String(pattern)}.` : undefined
    },
  }
}

function notIn(actual: unknown, shown: string): string {
  return `Expected ${shorten(formatValue(actual))} to contain ${shorten(shown)}.`
}
