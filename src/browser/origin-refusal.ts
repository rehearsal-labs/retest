import type { ActionIntent } from './element-queries.ts'
import type { Failure } from '../protocol/failures.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import { describeLocator } from '../protocol/locator.ts'
import { secretPlaceholder } from '../protocol/secret.ts'

/** Where a fill bound to origins would have typed: the document's origin, or the one the page set off to open. */
export type Refusal = { origin: string; leaving: boolean }

/**
 * The failure for a fill whose text would have reached an origin it is not bound to. The text was never typed.
 * An opaque origin, such as `about:blank`'s, arrives as `'null'`.
 *
 * @example originRefusal({ origin: 'https://evil.example', leaving: false }, { action: 'fill', multiline: false, secret: 'password', allowedOrigins: ['https://app.example'] }, locator)
 */
export function originRefusal({ origin, leaving }: Refusal, intent: ActionIntent, locator: LocatorRecipe): Failure {
  const text = intent.secret === undefined ? 'the text' : secretPlaceholder(intent.secret)
  const opaque = origin === 'null'
  const where = opaque ? 'a page with no web origin' : origin
  const allowed = [...new Set(intent.allowedOrigins ?? [])]
  const reason = leaving
    ? `the page started to open ${where} before Retest typed. Retest kept the page where it was and did not type ${text}.`
    : `the page is on ${where}, and ${allowed.length === 0 ? `no origin may take ${text}` : `${text} may be typed only on ${allowed.join(', ')}`}. Retest did not type it.`
  const details = { origin: opaque ? null : origin, ...(leaving ? { leaving } : {}) }
  return { class: 'not_actionable', message: `Could not fill ${describeLocator(locator)} with ${text}: ${reason}`, details }
}
