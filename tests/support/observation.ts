import type { ObservedItem, Observation } from '../../src/protocol/commands.ts'
import { observedItemLimit } from '../../src/protocol/commands.ts'

/**
 * What a page reports for these matches: the single match's visibility, text and field value, and the list of
 * matches, cut at the limit a real page uses.
 */
export function observationOf(matches: readonly ObservedItem[], value: string | null = null): Observation {
  const [only] = matches
  const single = matches.length === 1 && only !== undefined
  return {
    count: matches.length,
    visible: single ? only.visible : null,
    text: single ? only.text : null,
    value: single ? value : null,
    items: matches.slice(0, observedItemLimit).map((item) => ({ ...item })),
    itemsTruncated: matches.length > observedItemLimit,
  }
}
