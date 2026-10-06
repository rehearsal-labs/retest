import type { NativeKind } from '../browser/contract.ts'
import type { RunTime } from '../api/run-time.ts'
import type { Observation } from '../protocol/commands.ts'
import type { Failure, TruncatedText } from '../protocol/failures.ts'
import type { LocatorCheck, LocatorCheckRecord } from '../protocol/locator-checks.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import type { NativeElement, NativeTree, StateReading } from './locators.ts'
import type { NativeReference } from './session.ts'
import { hostTime } from '../api/run-time.ts'
import { pollDelay } from '../assertions/look-until.ts'
import { observedItemLimit } from '../protocol/commands.ts'
import { Deadline, elapsedMs, smallestBudget } from '../protocol/deadline.ts'
import { truncateText } from '../protocol/failures.ts'
import { locatorCheck } from '../protocol/locator-checks.ts'
import { describeEmptyStep, describeLocator } from '../protocol/locator.ts'
import { quoteText } from '../protocol/text.ts'
import { unverifiedSentence } from './actionability.ts'
import { checkedReading, describeElement, enabledReading, fieldTypes, locate, platformName, readValue, selectedReading, textReading, valueReading, visibilityReading } from './locators.ts'

// Native checks, judged from the session's own scoped tree, as the parent judges the web's: each look reads the tree,
// finds the locator's elements and builds an observation of the same shape the web's checks read, with a selected
// state besides. The matchers the web has keep the web's rules, `.not` included, through `locatorCheck`; `toBeSelected`
// follows the same rule for one element. A state the tree does not report, or a field value that cannot be told from
// the field's placeholder, is null in the observation, so no check on it passes either way, and once the check gives
// up it fails naming what the executor did not report. A check of something the platform does not expose on the
// element that matched, such as a selected state on a text, fails at once as `unsupported`: it neither passes nor waits.

/** A native observation: what the web's checks read, and whether the one element that matched is selected. */
export type NativeObservation = Observation & { readonly selected: boolean | null }

/** A native check: any locator check the web has, or `toBeSelected`. */
export type NativeCheckRecord = LocatorCheckRecord | { readonly matcher: 'toBeSelected'; readonly not?: true }

/** A look at a locator's elements: the observation, the elements it rests on and the reference of the tree it read. */
export type NativeLook = { readonly observation: NativeObservation; readonly matches: readonly NativeElement[]; readonly reference: NativeReference; readonly tree: NativeTree }

/**
 * Builds the observation of a locator in a scoped tree. `visible`, `text`, `value`, `checked`, `enabled` and
 * `selected` are null unless exactly one element matched, and each is null too when that element does not have it, when
 * the executor did not report it, or, for a value, when it cannot be told from the field's placeholder. An element whose
 * visibility was not reported counts as visible among `items`, so no check on several elements passes as hidden on it.
 *
 * @example observeTree(tree, { by: 'testId', value: 'created-task-state' }).ok // true
 */
export function observeTree(tree: NativeTree, recipe: LocatorRecipe): { readonly ok: true; readonly observation: NativeObservation; readonly matches: readonly NativeElement[] } | { readonly ok: false; readonly failure: Failure } {
  const located = locate(tree, recipe)
  if (!located.ok) return located
  const { matches } = located
  const [only, ...others] = matches
  const single = only !== undefined && others.length === 0 ? only : undefined
  const items = matches.slice(0, observedItemLimit).map((element) => {
    const visible = visibilityReading(element, tree.platform)
    return { text: readValue(textReading(element, tree.platform)) ?? '', visible: visible.kind !== 'read' || visible.value }
  })
  const observation: NativeObservation = {
    count: matches.length,
    visible: single === undefined ? null : readValue(visibilityReading(single, tree.platform)),
    text: single === undefined ? null : readValue(textReading(single, tree.platform)),
    value: single === undefined ? null : readValue(valueReading(single, tree.platform)),
    checked: single === undefined ? null : readValue(checkedReading(single)),
    enabled: single === undefined ? null : readValue(enabledReading(single)),
    selected: single === undefined ? null : readValue(selectedReading(single, tree.platform)),
    items,
    itemsTruncated: matches.length > observedItemLimit,
    ...(located.emptyStep === undefined ? {} : { emptyStep: located.emptyStep }),
  }
  return { ok: true, observation, matches }
}

/**
 * The rule a native check polls with and is judged by: the web's own for the matchers the web has, and for
 * `toBeSelected` the same rule on one element, which a negation does not pass on none.
 */
export function nativeCheck(record: NativeCheckRecord): LocatorCheck {
  if (record.matcher !== 'toBeSelected') return locatorCheck(record)
  const negated = record.not === true
  return {
    matcher: negated ? 'not.toBeSelected' : 'toBeSelected',
    expected: negated ? 'not selected' : 'selected',
    single: true,
    passes: (observation) => observation.count === 1 && observedSelected(observation) === !negated,
    actual: (observation) => {
      const selected = observedSelected(observation)
      return selected === undefined ? null : selected ? 'selected' : 'not selected'
    },
    mismatch: (observation, locator) => (observedSelected(observation) === true ? `${locator} is selected.` : `${locator} is not selected.`),
  }
}

// The selected state rides on the observation the native looks build; a web observation has none.
function observedSelected(observation: Observation): boolean | undefined {
  return observation.selected ?? undefined
}

/**
 * Why a check cannot be judged on the elements that matched, or undefined when it can. `unsupported` for a check the
 * platform cannot judge on the element at all: a text check on a field, a value, checked or selected check on an element
 * that has none. Otherwise, as `unjudged` says, a failure naming the state the executor did not report, or a value that
 * cannot be told from the field's placeholder. The parent asks this of the look a check rested on.
 */
export function unsupportedCheck(record: NativeCheckRecord, matches: readonly NativeElement[], recipe: LocatorRecipe, platform: NativeKind): Failure | undefined {
  return platformRefusal(record, matches, recipe, platform) ?? unjudged(record, matches, recipe, platform)
}

// What the platform cannot judge on the element that matched: it never changes, so a check fails on it at once.
function platformRefusal(record: NativeCheckRecord, matches: readonly NativeElement[], recipe: LocatorRecipe, platform: NativeKind): Failure | undefined {
  const locator = describeLocator(recipe)
  const platformLabel = platformName(platform)
  switch (record.matcher) {
    case 'toHaveText':
    case 'toContainText': {
      const field = matches.find((element) => fieldTypes.has(element.type))
      if (field === undefined) return undefined
      return unsupported(`${locator} is ${describeElement(field, platform)}: on ${platformLabel} a field's text is what was typed, which ${record.matcher} does not read. Use toHaveValue.`, field)
    }
    case 'toHaveValue':
      return onlyOne(matches, (element) => valueReading(element, platform).kind === 'none', (element) => `${locator} is ${describeElement(element, platform)}, which has no value on ${platformLabel}: a value belongs to a field, a switch, a checkbox, a slider or a stepper.`)
    case 'toBeChecked':
      return onlyOne(matches, (element) => checkedReading(element).kind === 'none', (element) => `${locator} is ${describeElement(element, platform)}, which has no checked state on ${platformLabel} that Retest reads: a switch, a toggle, a checkbox or a radio button has one.`)
    case 'toBeSelected':
      return onlyOne(matches, (element) => selectedReading(element, platform).kind === 'none', (element) => `${locator} is ${describeElement(element, platform)}, which has no selected state on ${platformLabel} that Retest reads.`)
    default:
      return undefined
  }
}

/**
 * Why a check cannot be judged on the look it rests on, though the platform has the state: the executor did not report
 * the attribute it is read from, or an iOS field's value equals its placeholder, which an empty field and one holding
 * that text both give. Such a check passes in neither direction, and fails naming which.
 */
export function unjudged(record: NativeCheckRecord, matches: readonly NativeElement[], recipe: LocatorRecipe, platform: NativeKind): Failure | undefined {
  const locator = describeLocator(recipe)
  if (record.matcher === 'toBeHidden' && record.not !== true) {
    const unseen = matches.slice(0, observedItemLimit).find((element) => visibilityReading(element, platform).kind === 'unreported')
    return unseen === undefined ? undefined : unreportedFailure(locator, record.matcher, unseen, visibilityReading(unseen, platform), platform)
  }
  const [element, ...others] = matches
  if (element === undefined || others.length > 0) return undefined
  const reading = readingFor(record, element, platform)
  if (reading === undefined || (reading.kind !== 'unreported' && reading.kind !== 'placeholder')) return undefined
  return unreportedFailure(locator, record.not === true ? `not.${record.matcher}` : record.matcher, element, reading, platform)
}

function readingFor(record: NativeCheckRecord, element: NativeElement, platform: NativeKind): StateReading<unknown> | undefined {
  switch (record.matcher) {
    case 'toBeVisible':
    case 'toBeHidden':
      return visibilityReading(element, platform)
    case 'toBeEnabled':
    case 'toBeDisabled':
      return enabledReading(element)
    case 'toBeSelected':
      return selectedReading(element, platform)
    case 'toBeChecked':
      return checkedReading(element)
    case 'toHaveValue':
      return valueReading(element, platform)
    case 'toHaveText':
    case 'toContainText':
      return textReading(element, platform)
    default:
      return undefined
  }
}

// What the executors leave out: WebDriverAgent 16.13.6, read from TaskPhone's trees on the simulator, writes `enabled`,
// `visible` and `traits` on every element and leaves `value` out wherever it is empty, a static text's and a field's
// with no placeholder included; the macOS runner 4.3.6, by its source (`FBXPath.m`), writes `enabled` and `selected`
// on every element and leaves out a `value` XCTest gives none.
function unreportedFailure(locator: string, matcher: string, element: NativeElement, reading: StateReading<unknown>, platform: NativeKind): Failure {
  const described = describeElement(element, platform)
  if (reading.kind === 'placeholder') {
    return { class: 'check_failed', message: `${locator} is ${described}, whose value reads as its placeholder ${quoteText(reading.placeholder)}: ${platformName(platform)}'s executor writes the placeholder as the value of an empty field, so Retest cannot tell an empty field from one holding that text, and ${matcher} passes in neither direction.`, details: { element: described, unreported: 'value' } }
  }
  const attribute = reading.kind === 'unreported' ? reading.attribute : 'state'
  const why = attribute === 'value' && platform === 'ios-simulator' ? ': WebDriverAgent leaves a value out when it is empty, and Retest cannot tell that from a value it did not read' : ''
  return { class: 'check_failed', message: `${locator} is ${described}, and the executor did not report its ${attribute} in the tree${why}, so Retest cannot judge ${matcher} in either direction.`, details: { element: described, unreported: attribute } }
}

function onlyOne(matches: readonly NativeElement[], lacks: (element: NativeElement) => boolean, say: (element: NativeElement) => string): Failure | undefined {
  const [element, ...others] = matches
  if (element === undefined || others.length > 0 || !lacks(element)) return undefined
  return unsupported(say(element), element)
}

function unsupported(message: string, element: NativeElement): Failure {
  return { class: 'unsupported', message, details: { elementType: element.type } }
}

/** A native check's verdict, with what it rests on: the last look, how many looks, and the failure when it did not pass. */
export type NativeAssertionResult = {
  readonly passed: boolean
  readonly matcher: string
  readonly expected: string
  readonly actual: TruncatedText | null
  readonly comparison?: string
  readonly attempts: number
  readonly timeoutMs: number
  readonly durationMs: number
  readonly failure?: Failure
  readonly look?: NativeLook
}

/** How a native check looks: one look within a time, and the clock and pause it polls with. */
export type NativePollOptions = {
  readonly recipe: LocatorRecipe
  readonly record: NativeCheckRecord
  readonly timeoutMs: number
  readonly platform: NativeKind
  readonly signal: AbortSignal
  /** The clock and waits used by the check. Defaults to the host's monotonic clock and timers. */
  readonly time?: RunTime
  look(timeoutMs: number): Promise<{ readonly ok: true; readonly look: NativeLook } | { readonly ok: false; readonly failure: Failure }>
}

/**
 * Looks at a locator's elements until the check passes or the time runs out, on the web's poll delays: at once, then
 * after 50, 100, 250 and then every 500 ms, the last look at the deadline. It only reads; it never acts. Once a look has
 * answered, a later look that runs out of time preserves that look and polling continues to the check's exact deadline,
 * since a look sits under its own budgets, which can end it before the check's. A look that fails
 * for any other reason stops it, and a check the platform cannot judge on the element that matched fails at once as
 * `unsupported`.
 */
export async function pollNative(options: NativePollOptions): Promise<NativeAssertionResult> {
  const { recipe, record, timeoutMs, platform, signal } = options
  const check = nativeCheck(record)
  const { now, sleep } = options.time ?? hostTime
  const startedAt = now()
  const deadline = new Deadline(timeoutMs, { startedAt, clock: now })
  let attempts = 0
  let last: NativeLook | undefined
  // A tree the session could not read, as just after a launch, is a look that saw nothing; the next look tries again.
  let unread: Failure | undefined
  const verdict = (failure: Failure | undefined): NativeAssertionResult => ({
    passed: failure === undefined,
    matcher: check.matcher,
    expected: check.expected,
    actual: last === undefined ? null : nullableText(check.actual(last.observation)),
    ...(check.comparison === undefined ? {} : { comparison: check.comparison }),
    attempts,
    timeoutMs,
    durationMs: elapsedMs(startedAt, now),
    ...(failure === undefined ? {} : { failure }),
    ...(last === undefined ? {} : { look: last }),
  })
  for (;;) {
    const waitToEndMs = deadline.waitToEndMs
    const delay = smallestBudget(pollDelay(attempts), waitToEndMs)
    if (delay > 0) await sleep(delay, signal).catch(() => undefined)
    if (delay > 0 && delay === waitToEndMs) {
      while (!deadline.reached && !signal.aborted) await sleep(deadline.waitToEndMs, signal).catch(() => undefined)
    }
    const looked = await options.look(deadline.commandTimeoutMs)
    attempts += 1
    if (looked.ok) {
      last = looked.look
      const refused = platformRefusal(record, looked.look.matches, recipe, platform)
      if (refused !== undefined) return verdict(refused)
      if (check.passes(looked.look.observation)) return verdict(undefined)
    } else if (looked.failure.details?.['check'] === 'tree') {
      unread = looked.failure
    } else if (!(looked.failure.class === 'timeout' && (last !== undefined || (deadline.expired && unread !== undefined)))) {
      return verdict(looked.failure)
    }
    if (deadline.reached || signal.aborted) break
  }
  if (last === undefined && unread !== undefined) return verdict(unread)
  return verdict((last === undefined ? undefined : unjudged(record, last.matches, recipe, platform)) ?? lookedTooLong(check, recipe, last, attempts, timeoutMs, platform))
}

function lookedTooLong(check: LocatorCheck, recipe: LocatorRecipe, last: NativeLook | undefined, attempts: number, timeoutMs: number, platform: NativeKind): Failure {
  const locator = describeLocator(recipe)
  const looked = `Looked ${attempts} ${attempts === 1 ? 'time' : 'times'} in ${timeoutMs} ms.`
  const observation = last?.observation
  const details = { expected: truncateText(check.expected), received: observation === undefined ? null : nullableText(check.actual(observation)), attempts, timeoutMs, ...(check.comparison === undefined ? {} : { comparison: check.comparison }) }
  if (observation === undefined || (check.single && observation.count === 0)) {
    const step = observation?.emptyStep === undefined ? undefined : describeEmptyStep(recipe, observation.emptyStep)
    const located = last === undefined ? undefined : locate(last.tree, recipe)
    const unverified = located?.ok === true && located.unverified !== undefined ? ` ${unverifiedSentence(located.unverified, platform)}` : ''
    return { class: 'not_found', message: `${locator} matched no element.${step === undefined ? '' : ` ${step}`}${unverified} ${looked}`, details }
  }
  if (check.single && observation.count > 1) return { class: 'ambiguous', message: `${locator} matched ${observation.count} elements, and ${check.matcher} needs exactly one. ${looked}`, details }
  const [element] = last?.matches ?? []
  const named = element === undefined ? {} : { element: describeElement(element, platform) }
  return { class: 'check_failed', message: `${check.mismatch(observation, locator)} ${looked}`, details: { ...details, ...named } }
}

function nullableText(text: string | null): TruncatedText | null {
  return text === null ? null : truncateText(text)
}
