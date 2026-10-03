import type { Observation } from './commands.ts'
import type { EmptyStep } from './locator.ts'
import { truncateText, truncatedTextSchema, type TruncatedText } from './failures.ts'
import { emptyStepSchema } from './locator.ts'
import { s, type Schema } from './schema.ts'

/** How many UTF-16 code units of a match's text or value an observation event keeps. */
export const observedTextLimit = 4096
/** How many UTF-16 code units of each listed match's text an observation event keeps. */
export const observedItemTextLimit = 512

/**
 * What a look saw, as its `observation` event records it: the page text is cut to fit, never inside a surrogate pair.
 * `checked`, `enabled` and `emptyStep` are absent in runs recorded before looks read them.
 */
export type ObservedRecord = {
  count: number
  visible: boolean | null
  text: TruncatedText | null
  value: TruncatedText | null
  checked?: boolean | null
  enabled?: boolean | null
  items: { text: TruncatedText; visible: boolean }[]
  itemsTruncated: boolean
  emptyStep?: EmptyStep
}

export const observedRecordSchema: Schema<ObservedRecord> = s.object({
  count: s.number({ integer: true, min: 0 }),
  visible: s.nullable(s.boolean()),
  text: s.nullable(truncatedTextSchema),
  value: s.nullable(truncatedTextSchema),
  checked: s.optional(s.nullable(s.boolean())),
  enabled: s.optional(s.nullable(s.boolean())),
  items: s.array(s.object({ text: truncatedTextSchema, visible: s.boolean() })),
  itemsTruncated: s.boolean(),
  emptyStep: s.optional(emptyStepSchema),
})

/**
 * An observation as its event records it. Nothing is left out: only text is cut.
 *
 * @example observedRecord(observation).text // { text: 'Saved', truncated: false, length: 5 }
 */
export function observedRecord(observation: Observation): ObservedRecord {
  const { count, visible, text, value, checked, enabled, items, itemsTruncated, emptyStep } = observation
  return {
    count,
    visible,
    text: text === null ? null : truncateText(text, observedTextLimit),
    value: value === null ? null : truncateText(value, observedTextLimit),
    checked,
    enabled,
    items: items.map((item) => ({ text: truncateText(item.text, observedItemTextLimit), visible: item.visible })),
    itemsTruncated,
    ...(emptyStep === undefined ? {} : { emptyStep }),
  }
}

const observationIdPattern = /^o[1-9]\d*$/

/**
 * The id of an attempt's observation, counted from 1 within the attempt.
 *
 * @example formatObservationId(3) // 'o3'
 */
export function formatObservationId(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError(`An observation is counted from 1, received ${sequence}.`)
  }
  return `o${sequence}`
}

/**
 * Whether text has the shape of an observation id. Only the parent knows which ids it served.
 *
 * @example isObservationId('o12') // true
 */
export function isObservationId(text: string): boolean {
  return observationIdPattern.test(text)
}
