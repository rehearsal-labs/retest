import type { Observation, PageObservation } from '../protocol/commands.ts'
import type { ChildEvent, EventBody } from '../protocol/events.ts'
import type { LocatorCheckRecord, PageCheckRecord, PageLook } from '../protocol/locator-checks.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import type { Redactor } from './redactor.ts'
import { isDeepStrictEqual } from 'node:util'
import { truncateText } from '../protocol/failures.ts'
import { checkRecordProblem, decidedByLook, isPageCheck, locatorCheck, mapLocatorCheckText, mapPageCheckText, pageCheck } from '../protocol/locator-checks.ts'
import { describeLocator } from '../protocol/locator.ts'
import { formatObservationId } from '../protocol/observation-record.ts'
import { cleanTitle, recordedTitle } from '../protocol/page-facts.ts'
import { quoteText } from '../protocol/text.ts'

/** A page as an event records it: its origin and path, and its title when it has one. */
export type PageFields = { pageUrl?: string; pageTitle?: string }

/**
 * A look the parent served: the app and locator it read, the session that served it, the observation as sent,
 * redacted and whole, and the page it read, as the look itself read it. A look at the page itself holds what it saw
 * of the page, as sent, and the app's base URL.
 */
export type ServedObservation =
  | (PageFields & { app: string; sessionId: string; locator: LocatorRecipe; observation: Observation })
  | { app: string; sessionId: string; page: PageLook }

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
 * The looks one attempt served its test process, and the parent's judgement of the assertions that name them. A
 * look's reference is its id, counted from `o1` within the attempt, and the session that served it: the test process
 * receives both with the look and sends both back with the assertion. Ids repeat from one attempt to the next, so the
 * session is what tells a look of this attempt from one an earlier attempt served: an assertion that sends back
 * another session is refused, as `ObservationScope` says, even when this attempt served a look with the same id, app
 * and locator. A reference needs both halves: an assertion that sends an id without its session is refused, as one
 * that sends a session without an id is, since an id alone could name a look of any attempt. A look is judged as it
 * was served; what the parent writes of it is redacted with every value known when the assertion comes, before
 * anything is quoted or cut, so a value learned after the look was served is hidden whole too.
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
   * which that check passes; an assertion that names a look must send back the session that served it. Its matcher,
   * expected text and comparison come from the check, its actual value and page from the look it names. A value
   * assertion names neither; its pass is the test process's claim, though a pass of a locator or page matcher that
   * names no look is refused. A page address or title the test process sent is never kept.
   *
   * @example observations.judge(event, { app: 'web', pageUrl: 'http://127.0.0.1:4173/' })
   */
  judge(assertion: SentAssertion, page: AssertionPage): Judged {
    const { check, observationId, sessionId, pageUrl: _claimedPage, pageTitle: _claimedTitle, ...claimed } = assertion
    const { locator } = assertion
    const problem = check === undefined ? undefined : checkRecordProblem(check)
    if (problem !== undefined) return refused(`sent ${assertion.type} with a check Retest cannot read: ${problem}`)
    if (check !== undefined && isPageCheck(check)) {
      if (locator !== undefined) return refused(`sent ${assertion.type} for ${describeLocator(locator)} with ${check.matcher}, a check of the page`)
      return this.#judgePage(assertion, check, page)
    }
    if (locator === undefined) {
      if (check !== undefined || observationId !== undefined || sessionId !== undefined) return refused(`sent ${assertion.type} for a value, naming a look or a locator check, which only a locator assertion has`)
      if (claimed.type === 'assertion.passed' && decidedByLook(claimed.matcher)) {
        return refused(`sent assertion.passed for ${claimed.matcher} without the check it made or the look it rested on`)
      }
      return { ok: true, event: claimed.type === 'assertion.passed' ? { ...claimed, judgedBy: 'child' } : claimed }
    }
    const { matcher: _matcher, expected: _expected, actual: _actual, comparison: _comparison, ...kept } = claimed
    if (check === undefined) return refused(`sent ${assertion.type} for ${describeLocator(locator)} without the check it made`)
    const rule = locatorCheck(check)
    const recorded = locatorCheck(this.#redactLocatorCheck(check))
    const judged = { matcher: recorded.matcher, expected: truncateText(recorded.expected), ...(recorded.comparison === undefined ? {} : { comparison: recorded.comparison }) }
    if (observationId === undefined) {
      if (sessionId !== undefined) return refused(`sent the session ${quoteText(sessionId)} of a look without the look's id`)
      if (kept.type === 'assertion.passed') return refused(`sent assertion.passed for ${describeLocator(locator)} without naming the look it rested on`)
      return { ok: true, event: { ...kept, ...judged, actual: null, ...pageFields(page.pageUrl, page.pageTitle) } }
    }
    if (sessionId === undefined) return refused(`named the look ${quoteText(observationId)} without the session that served it`)
    const served = this.#served.get(observationId)
    if (served === undefined) return refused(`named the look ${quoteText(observationId)}, which Retest did not serve to this test`)
    if (!('locator' in served) || served.app !== page.app || !sameLocator(served.locator, locator)) {
      const look = 'locator' in served ? `a look at ${describeLocator(served.locator)} on ${served.app}` : `a look at the page of ${served.app}`
      return refused(`named ${observationId}, ${look}, for an assertion on ${describeLocator(locator)} on ${page.app ?? 'no app'}`)
    }
    if (sessionId !== served.sessionId) {
      return refused(`named ${observationId} of the session ${quoteText(sessionId)}, but the session ${quoteText(served.sessionId)} served this test's ${observationId}`)
    }
    const { observation } = served
    if (kept.type === 'assertion.passed' && !rule.passes(observation)) {
      return refused(`sent assertion.passed for expect(${describeLocator(locator)}).${rule.matcher}(), which fails on ${observationId}, the look it named, where ${matched(observation.count)}`)
    }
    const actual = recorded.actual(this.#redactor?.redactObservation(observation) ?? observation)
    const written = { ...judged, actual: actual === null ? null : truncateText(actual), observationId, ...pageFields(served.pageUrl, served.pageTitle) }
    return { ok: true, event: kept.type === 'assertion.passed' ? { ...kept, ...written, judgedBy: 'parent' } : { ...kept, ...written } }
  }

  // A page assertion is judged as a locator assertion is, on a look at the page of its own app, as the test process
  // received it: whole and redacted. The event records the look's whole address, and its title as Retest records one.
  #judgePage(assertion: SentAssertion, check: PageCheckRecord, page: AssertionPage): Judged {
    const { check: _check, observationId, sessionId, pageUrl: _claimedPage, pageTitle: _claimedTitle, ...claimed } = assertion
    const { matcher: _matcher, expected: _expected, actual: _actual, comparison: _comparison, ...kept } = claimed
    const rule = pageCheck(check)
    const recorded = pageCheck(this.#redactor === undefined ? check : mapPageCheckText(check, (text) => this.#redactText(text)))
    const judged = { matcher: recorded.matcher, expected: truncateText(recorded.expected), comparison: recorded.comparison }
    if (observationId === undefined) {
      if (sessionId !== undefined) return refused(`sent the session ${quoteText(sessionId)} of a look without the look's id`)
      if (kept.type === 'assertion.passed') return refused(`sent assertion.passed for expect(page).${rule.matcher}() without naming the look it rested on`)
      return { ok: true, event: { ...kept, ...judged, actual: null, ...pageFields(page.pageUrl, page.pageTitle) } }
    }
    if (sessionId === undefined) return refused(`named the look ${quoteText(observationId)} without the session that served it`)
    const served = this.#served.get(observationId)
    if (served === undefined) return refused(`named the look ${quoteText(observationId)}, which Retest did not serve to this test`)
    if (!('page' in served) || served.app !== page.app) {
      const look = 'page' in served ? `a look at the page of ${served.app}` : `a look at ${describeLocator(served.locator)} on ${served.app}`
      return refused(`named ${observationId}, ${look}, for an assertion on the page of ${page.app ?? 'no app'}`)
    }
    if (sessionId !== served.sessionId) {
      return refused(`named ${observationId} of the session ${quoteText(sessionId)}, but the session ${quoteText(served.sessionId)} served this test's ${observationId}`)
    }
    const look = served.page
    if (kept.type === 'assertion.passed' && !rule.passes(look)) {
      return refused(`sent assertion.passed for expect(page).${rule.matcher}(), which fails on ${observationId}, the look it named`)
    }
    const shown = { ...look, url: look.url === null ? null : this.#redactText(look.url), title: look.title === null ? null : this.#redactText(look.title) }
    const actual = recorded.actual(shown)
    const pageRead = pageFields(shown.url ?? undefined, shown.title === null || shown.title === '' ? undefined : recordedTitle(shown.title))
    const written = { ...judged, actual: actual === null ? null : truncateText(actual), observationId, ...pageRead }
    return { ok: true, event: kept.type === 'assertion.passed' ? { ...kept, ...written, judgedBy: 'parent' } : { ...kept, ...written } }
  }

  #redactLocatorCheck(check: LocatorCheckRecord): LocatorCheckRecord {
    return this.#redactor === undefined ? check : mapLocatorCheckText(check, (text) => this.#redactText(text))
  }

  #redactText(text: string): string {
    return this.#redactor?.redact(text) ?? text
  }
}

function refused(problem: string): Judged {
  return { ok: false, problem }
}

/**
 * A look at the page as the parent keeps it when no redactor runs: its title cleaned as every title is, and not cut.
 *
 * @example cleanedLook({ url: 'http://127.0.0.1:4173/', title: '  Tasks ' }).title // 'Tasks'
 */
export function cleanedLook(look: PageObservation): PageObservation {
  return look.title === null ? look : { ...look, title: cleanTitle(look.title) ?? '' }
}

/**
 * A page as an event records it, each field only when it is known.
 *
 * @example pageFields('http://127.0.0.1:4173/done', undefined) // { pageUrl: 'http://127.0.0.1:4173/done' }
 */
export function pageFields(url: string | undefined, title: string | undefined): PageFields {
  return { ...(url === undefined ? {} : { pageUrl: url }), ...(title === undefined ? {} : { pageTitle: title }) }
}

// Two recipes are the same when they hold the same steps, picks and patterns, with keys in any order.
function sameLocator(first: LocatorRecipe, second: LocatorRecipe): boolean {
  return isDeepStrictEqual(first, second)
}

function matched(count: number): string {
  if (count === 0) return 'nothing matched'
  return count === 1 ? '1 element matched' : `${count} elements matched`
}
