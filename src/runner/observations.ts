import type { Observation } from '../protocol/commands.ts'
import type { ChildEvent, EventBody } from '../protocol/events.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import type { Redactor } from './redactor.ts'
import { truncateText } from '../protocol/failures.ts'
import { locatorCheck } from '../protocol/locator-checks.ts'
import { describeLocator } from '../protocol/locator.ts'
import { formatObservationId } from '../protocol/observation-record.ts'
import { quoteText } from '../protocol/text.ts'

/** A page as an event records it: its origin and path, and its title when it has one. */
export type PageFields = { pageUrl?: string; pageTitle?: string }

/**
 * A look the parent served: the app and locator it read, the observation as sent, redacted and whole, and the
 * page it read, as the look itself read it.
 */
export type ServedObservation = PageFields & { app: string; locator: LocatorRecipe; observation: Observation }

/**
 * Where an assertion looked, as the parent knows it: its app, and the document the parent last saw that app's page
 * commit, with its title when it has one.
 */
export type AssertionPage = PageFields & { app: string | undefined }

type SentAssertion = Extract<ChildEvent, { type: 'assertion.passed' | 'assertion.failed' }>
type AssertionBody = Extract<EventBody, { type: 'assertion.passed' | 'assertion.failed' }>

/** The assertion as the parent writes it, or the protocol violation the test process committed by sending it. */
export type Judged = { ok: true; event: AssertionBody } | { ok: false; problem: string }

/**
 * The looks one attempt served its test process, by id, and the parent's judgement of the assertions that name
 * them. Ids count from `o1` within the attempt, so a later attempt never matches an earlier one's look. A look is
 * judged as it was served; what the parent writes of it is redacted with every value known when the assertion
 * comes, before anything is quoted or cut, so a value learned after the look was served is hidden whole too.
 */
export class ServedObservations {
  readonly #served = new Map<string, ServedObservation>()
  readonly #redactor: Redactor | undefined

  constructor(redactor?: Redactor) {
    this.#redactor = redactor
  }

  /** Keeps a look the parent is about to answer with, and gives it the attempt's next id. */
  serve(served: ServedObservation): string {
    const id = formatObservationId(this.#served.size + 1)
    this.#served.set(id, served)
    return id
  }

  /**
   * Checks an assertion the test process sent, and writes it as the parent's own record. A locator assertion
   * must carry its check, and a passed one must name a look this attempt served, for its app and locator, on
   * which that check passes. Its matcher, expected text and comparison come from the check, its actual value and
   * page from the look it names. A value assertion names neither; its pass is the test process's claim. A page
   * address or title the test process sent is never kept.
   *
   * @example observations.judge(event, { app: 'web', pageUrl: 'http://127.0.0.1:4173/' })
   */
  judge(assertion: SentAssertion, page: AssertionPage): Judged {
    const { check, observationId, pageUrl: _claimedPage, pageTitle: _claimedTitle, ...claimed } = assertion
    const { locator } = assertion
    if (locator === undefined) {
      if (check !== undefined || observationId !== undefined) return refused(`sent ${assertion.type} for a value, naming a look or a locator check, which only a locator assertion has`)
      return { ok: true, event: claimed.type === 'assertion.passed' ? { ...claimed, judgedBy: 'child' } : claimed }
    }
    const { matcher: _matcher, expected: _expected, actual: _actual, comparison: _comparison, ...kept } = claimed
    if (check === undefined) return refused(`sent ${assertion.type} for ${describeLocator(locator)} without the check it made`)
    const rule = locatorCheck(check)
    const recorded = locatorCheck(this.#redactor?.redactCheck(check) ?? check)
    const judged = { matcher: recorded.matcher, expected: truncateText(recorded.expected), ...(recorded.comparison === undefined ? {} : { comparison: recorded.comparison }) }
    if (observationId === undefined) {
      if (kept.type === 'assertion.passed') return refused(`sent assertion.passed for ${describeLocator(locator)} without naming the look it rested on`)
      return { ok: true, event: { ...kept, ...judged, actual: null, ...pageFields(page.pageUrl, page.pageTitle) } }
    }
    const served = this.#served.get(observationId)
    if (served === undefined) return refused(`named the look ${quoteText(observationId)}, which Retest did not serve to this test`)
    if (served.app !== page.app || !sameLocator(served.locator, locator)) {
      const look = `a look at ${describeLocator(served.locator)} on ${served.app}`
      return refused(`named ${observationId}, ${look}, for an assertion on ${describeLocator(locator)} on ${page.app ?? 'no app'}`)
    }
    const { observation } = served
    if (kept.type === 'assertion.passed' && !rule.passes(observation)) {
      return refused(`sent assertion.passed for expect(${describeLocator(locator)}).${rule.matcher}(), which fails on ${observationId}, the look it named, where ${matched(observation.count)}`)
    }
    const actual = recorded.actual(this.#redactor?.redactObservation(observation) ?? observation)
    const written = { ...judged, actual: actual === null ? null : truncateText(actual), observationId, ...pageFields(served.pageUrl, served.pageTitle) }
    return { ok: true, event: kept.type === 'assertion.passed' ? { ...kept, ...written, judgedBy: 'parent' } : { ...kept, ...written } }
  }
}

function refused(problem: string): Judged {
  return { ok: false, problem }
}

/**
 * A page as an event records it, each field only when it is known.
 *
 * @example pageFields('http://127.0.0.1:4173/done', undefined) // { pageUrl: 'http://127.0.0.1:4173/done' }
 */
export function pageFields(url: string | undefined, title: string | undefined): PageFields {
  return { ...(url === undefined ? {} : { pageUrl: url }), ...(title === undefined ? {} : { pageTitle: title }) }
}

// Recipes are flat, so two are the same when they hold the same keys with the same values, in any order.
function sameLocator(first: LocatorRecipe, second: LocatorRecipe): boolean {
  const other = new Map<string, unknown>(Object.entries(second))
  const entries = Object.entries(first)
  return entries.length === other.size && entries.every(([key, value]) => other.has(key) && other.get(key) === value)
}

function matched(count: number): string {
  if (count === 0) return 'nothing matched'
  return count === 1 ? '1 element matched' : `${count} elements matched`
}
