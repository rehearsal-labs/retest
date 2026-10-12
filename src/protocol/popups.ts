import { failureSchema, type Failure } from './failures.ts'
import { s, type Schema } from './schema.ts'

/**
 * What a test asks of an app's page about the pages it opens: to wait for the next one, or to stop a wait whose action
 * failed before any page opened, naming the wait by its id.
 */
export type PopupRequest = { kind: 'wait' } | { kind: 'stop'; wait: number }

/** A page an app's page opened, as the test file's process receives it: the app name its commands and checks go to. */
export type PopupRecord = { app: string }

/**
 * The parent's answers. A wait is first `armed`, once the page hands the next page it opens to the test, then `opened`
 * with that page, or `failed` at either point. A stop is `stopped`.
 */
export type PopupAnswer = { kind: 'armed' } | { kind: 'opened'; popup: PopupRecord } | { kind: 'stopped' } | { kind: 'failed'; failure: Failure }

export const popupRequestSchema: Schema<PopupRequest> = s.discriminatedUnion('kind', [
  s.object({ kind: s.literal('wait') }),
  s.object({ kind: s.literal('stop'), wait: s.number({ integer: true, min: 0 }) }),
])

export const popupRecordSchema: Schema<PopupRecord> = s.object({ app: s.string() })

export const popupAnswerSchema: Schema<PopupAnswer> = s.discriminatedUnion('kind', [
  s.object({ kind: s.literal('armed') }),
  s.object({ kind: s.literal('opened'), popup: popupRecordSchema }),
  s.object({ kind: s.literal('stopped') }),
  s.object({ kind: s.literal('failed'), failure: failureSchema }),
])

/**
 * The app name a page another page opened goes by: the opener's name, then `popup-` and the first number from 1 that no
 * app of the test goes by yet. So the popups of one page are numbered in the order they opened, and a popup never takes
 * the name of another app, a popup's or one of the test's own.
 *
 * @example popupAppName('web', new Set(['web', 'web/popup-1'])) // 'web/popup-2'
 */
export function popupAppName(opener: string, taken: ReadonlySet<string>): string {
  for (let number = 1; ; number += 1) {
    const name = `${opener}/popup-${number}`
    if (!taken.has(name)) return name
  }
}
