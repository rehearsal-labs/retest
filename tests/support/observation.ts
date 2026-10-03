import type { ObservedItem, Observation } from '../../src/protocol/commands.ts'
import { observedItemLimit } from '../../src/protocol/commands.ts'

/** The states a single match can report besides its text and value: checked, and enabled, which it is unless said. */
export type MatchState = { checked?: boolean | null; enabled?: boolean }

/**
 * What a page reports for these matches: the single match's visibility, text, field value and states, and the list
 * of matches, cut at the limit a real page uses.
 */
export function observationOf(matches: readonly ObservedItem[], value: string | null = null, state: MatchState = {}): Observation {
  const [only] = matches
  const single = matches.length === 1 && only !== undefined
  return {
    count: matches.length,
    visible: single ? only.visible : null,
    text: single ? only.text : null,
    value: single ? value : null,
    checked: single ? (state.checked ?? null) : null,
    enabled: single ? (state.enabled ?? true) : null,
    items: matches.slice(0, observedItemLimit).map((item) => ({ ...item })),
    itemsTruncated: matches.length > observedItemLimit,
  }
}
