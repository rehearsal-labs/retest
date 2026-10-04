import type { NativeKind } from '../browser/contract.ts'
import type { Observation } from '../protocol/commands.ts'
import type { Failure, TruncatedText } from '../protocol/failures.ts'
import type { LocatorCheck, LocatorCheckRecord } from '../protocol/locator-checks.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import type { NativeElement, NativeTree } from './locators.ts'
import type { NativeReference } from './session.ts'
import { setTimeout as sleep } from 'node:timers/promises'
import { pollDelay } from '../assertions/look-until.ts'
import { observedItemLimit } from '../protocol/commands.ts'
import { Deadline, elapsedMs, monotonicClock, smallestBudget } from '../protocol/deadline.ts'
import { truncateText } from '../protocol/failures.ts'
import { locatorCheck } from '../protocol/locator-checks.ts'
import { describeEmptyStep, describeLocator } from '../protocol/locator.ts'
import { unverifiedSentence } from './actionability.ts'
import { checkedOf, describeElement, enabledOf, fieldTypes, locate, platformName, selectedOf, textOf, valueOf, visibleOf } from './locators.ts'

// Native checks, judged from the session's own scoped tree, as the parent judges the web's: each look reads the tree,
// finds the locator's elements and builds an observation of the same shape the web's checks read, with a selected
// state besides. The matchers the web has keep the web's rules, `.not` included, through `locatorCheck`; `toBeSelected`
// follows the same rule for one element. A check of something the platform does not expose on the element that matched,
// such as a selected state on a text, fails at once as `unsupported`: it neither passes nor waits.

/** A native observation: what the web's checks read, and whether the one element that matched is selected. */
export type NativeObservation = Observation & { readonly selected: boolean | null }

/** A native check: any locator check the web has, or `toBeSelected`. */
export type NativeCheckRecord = LocatorCheckRecord | { readonly matcher: 'toBeSelected'; readonly not?: true }

/** A look at a locator's elements: the observation, the elements it rests on and the reference of the tree it read. */
export type NativeLook = { readonly observation: NativeObservation; readonly matches: readonly NativeElement[]; readonly reference: NativeReference; readonly tree: NativeTree }

/**
 * Builds the observation of a locator in a scoped tree. `visible`, `text`, `value`, `checked`, `enabled` and
 * `selected` are null unless exactly one element matched, and each is null too when that element does not have it.
 *
 * @example observeTree(tree, { by: 'testId', value: 'created-task-state' }).ok // true
 */
export function observeTree(tree: NativeTree, recipe: LocatorRecipe): { readonly ok: true; readonly observation: NativeObservation; readonly matches: readonly NativeElement[] } | { readonly ok: false; readonly failure: Failure } {
  const located = locate(tree, recipe)
  if (!located.ok) return located
  const { matches } = located
  const [only, ...others] = matches
  const single = only !== undefined && others.length === 0 ? only : undefined
  const items = matches.slice(0, observedItemLimit).map((element) => ({ text: textOf(element, tree.platform) ?? '', visible: visibleOf(element, tree) }))
  const observation: NativeObservation = {
    count: matches.length,
    visible: single === undefined ? null : visibleOf(single, tree),
    text: single === undefined ? null : (textOf(single, tree.platform) ?? null),
    value: single === undefined ? null : (valueOf(single, tree.platform) ?? null),
    checked: single === undefined ? null : (checkedOf(single) ?? null),
    enabled: single === undefined ? null : enabledOf(single),
    selected: single === undefined ? null : (selectedOf(single, tree.platform) ?? null),
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
  const selected: unknown = 'selected' in observation ? observation.selected : null
  return typeof selected === 'boolean' ? selected : undefined
}

/**
 * Why a check cannot be judged on the elements that matched, as `unsupported`, or undefined when it can: a text check on
 * a field, a value, checked or selected check on an element that has none.
 */
export function unsupportedCheck(record: NativeCheckRecord, matches: readonly NativeElement[], recipe: LocatorRecipe, platform: NativeKind): Failure | undefined {
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
      return onlyOne(matches, (element) => valueOf(element, platform) === undefined, (element) => `${locator} is ${describeElement(element, platform)}, which has no value on ${platformLabel}: a value belongs to a field, a switch, a checkbox, a slider or a stepper.`)
    case 'toBeChecked':
      return onlyOne(matches, (element) => checkedOf(element) === undefined, (element) => `${locator} is ${describeElement(element, platform)}, which has no checked state on ${platformLabel} that Retest reads: a switch, a toggle, a checkbox or a radio button has one.`)
    case 'toBeSelected':
      return onlyOne(matches, (element) => selectedOf(element, platform) === undefined, (element) => `${locator} is ${describeElement(element, platform)}, which has no selected state on ${platformLabel} that Retest reads.`)
    default:
      return undefined
  }
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
  look(timeoutMs: number): Promise<{ readonly ok: true; readonly look: NativeLook } | { readonly ok: false; readonly failure: Failure }>
}

/**
 * Looks at a locator's elements until the check passes or the time runs out, on the web's poll delays: at once, then
 * after 50, 100, 250 and then every 500 ms, the last look at the deadline. It only reads; it never acts. A look that
 * fails for any reason but the deadline after an earlier look stops it, and a check the platform cannot judge on the
 * element that matched fails at once as `unsupported`.
 */
export async function pollNative(options: NativePollOptions): Promise<NativeAssertionResult> {
  const { recipe, record, timeoutMs, platform, signal } = options
  const check = nativeCheck(record)
  const startedAt = monotonicClock()
  const deadline = new Deadline(timeoutMs, { startedAt })
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
    durationMs: elapsedMs(startedAt),
    ...(failure === undefined ? {} : { failure }),
    ...(last === undefined ? {} : { look: last }),
  })
  for (;;) {
    const delay = smallestBudget(pollDelay(attempts), deadline.remainingMs)
    if (delay > 0) await sleep(delay, undefined, { signal }).catch(() => undefined)
    const looked = await options.look(deadline.commandTimeoutMs)
    attempts += 1
    if (looked.ok) {
      last = looked.look
      const refused = unsupportedCheck(record, looked.look.matches, recipe, platform)
      if (refused !== undefined) return verdict(refused)
      if (check.passes(looked.look.observation)) return verdict(undefined)
    } else if (looked.failure.details?.['check'] === 'tree') {
      unread = looked.failure
    } else if (!(looked.failure.class === 'timeout' && deadline.expired && (last !== undefined || unread !== undefined))) {
      return verdict(looked.failure)
    }
    if (deadline.expired || signal.aborted) break
  }
  if (last === undefined && unread !== undefined) return verdict(unread)
  return verdict(lookedTooLong(check, recipe, last, attempts, timeoutMs, platform))
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
