import type { ActionIntent, Check, DocumentAction, Readiness, SelectPlan } from './element-queries.ts'
import type { Point } from './input.ts'
import type { InDocument, IsolatedWorld } from './isolated-world.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { Failure } from '../protocol/failures.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import type { PageFacts } from '../protocol/page-facts.ts'
import { setTimeout as sleep } from 'node:timers/promises'
import { describeEmptyStep, describeLocator, describeStep, locatorSteps } from '../protocol/locator.ts'
import { describeOptionChoice } from '../protocol/option-choices.ts'
import { secretPlaceholder } from '../protocol/secret.ts'
import { CdpTimeoutError } from './cdp/errors.ts'
import { pageFactsOf } from './document-facts.ts'
import { armDocument, describeAction, prepare } from './element-queries.ts'
import { originRefusal } from './origin-refusal.ts'
import { originAndPath } from './page-url.ts'

/**
 * An element, or the document, that passed every check. `point` is where to act, or null for a key, which goes to
 * the focus. `context` is the document the look ran in, which holds the guard the look armed with `token`, or none
 * for a `select`'s look. `via` is `'label'` when a hidden control is acted on through its label, `scale` the visual
 * viewport's, `page` the page the look read, and `plan` the keys that make a select's choice.
 */
export type ReadyTarget = {
  point: Point | null
  context: number
  token: number | null
  via: 'label' | undefined
  scale: number
  page: PageFacts
  plan: SelectPlan | null
}

/**
 * Where to act, or a `check` or `select` already as asked, which needs no input, in the document `context` names, or
 * why the action cannot go.
 */
export type ActionTarget =
  | ({ ok: true; kind: 'ready' } & ReadyTarget)
  | { ok: true; kind: 'unchanged'; page: PageFacts; context: number }
  | { ok: false; failure: Failure }

/** A navigation the browser has begun in the main frame. Its document replaces the current one when it commits. */
export type PendingNavigation = { url: string }

export type ActionabilityOptions = {
  world: IsolatedWorld
  /** The element to act on, or undefined for input the document takes, which only waits out a navigation. */
  locator: LocatorRecipe | undefined
  intent: ActionIntent
  deadline: Deadline
  /** The navigation the browser is on, if any. While there is one, the page is not looked at. */
  pendingNavigation: () => PendingNavigation | undefined
}

type Unready =
  | Extract<Readiness, { status: 'missing' | 'blocked' }>
  | { status: 'option'; problem: 'missing' | 'disabled'; choice: number }
  | { status: 'navigating'; url: string }
type Look = { kind: 'settled'; target: ActionTarget } | { kind: 'unready'; unready: Unready }

const firstPauseMs = 20
const maxPauseMs = 200

const fieldTypes = 'a textarea, or an input of type text, search, email, url, tel, password or number'
const checkableKinds = 'a checkbox, a radio button, or an element whose role is checkbox, radio, switch, menuitemcheckbox or menuitemradio'

const becauseOf: Record<Check, string> = {
  attached: 'it was removed from the page while Retest checked it',
  visible: 'it is not visible',
  enabled: 'it is disabled',
  editable: 'it is read-only',
  stable: 'it kept moving',
  'in-view': 'it stays outside the viewport after scrolling',
  'hit-target': 'no element is at its centre',
  focused: 'it did not keep the keyboard focus',
}

/**
 * Resolves the locator again and again until one element passes every check, then returns where to act. More
 * than one match, an element the action cannot use, a choice that names several options, or an origin a fill may
 * not type into fails at once; anything else waits for the deadline. While the browser is opening another
 * document in the frame, the page is not looked at: the element is looked for in the document that arrives. Input
 * the document takes, a key for the page's keyboard or the wheel for the page, has no element, and is ready once
 * no such navigation is under way.
 *
 * @example const target = await waitUntilActionable({ world, locator, intent, deadline, pendingNavigation })
 */
export async function waitUntilActionable(options: ActionabilityOptions): Promise<ActionTarget> {
  const { deadline } = options
  let last: Unready | undefined
  for (let attempt = 0; ; attempt += 1) {
    const looked = await look(options, last)
    if (looked.kind === 'settled') return looked.target
    last = looked.unready
    if (deadline.expired) return failed(unready(last, options.locator, options.intent, deadline))
    await sleep(Math.min(firstPauseMs * 2 ** attempt, maxPauseMs, deadline.remainingMs), undefined, { signal: deadline.signal })
  }
}

async function look({ world, locator, intent, deadline, pendingNavigation }: ActionabilityOptions, last: Unready | undefined): Promise<Look> {
  const pending = pendingNavigation()
  if (pending !== undefined) return { kind: 'unready', unready: { status: 'navigating', url: pending.url } }
  let seen: InDocument<Readiness>
  try {
    seen = locator === undefined ? await armDocument(world, documentAction(intent), strokesOf(intent), deadline) : await prepare(world, locator, intent, deadline)
  } catch (error) {
    // The deadline ran out during a look, so the previous look is the latest answer there is.
    if (last !== undefined && error instanceof CdpTimeoutError) return { kind: 'settled', target: failed(unready(last, locator, intent, deadline)) }
    throw error
  }
  return lookedAt(seen, locator, intent)
}

function lookedAt({ value: readiness, context }: InDocument<Readiness>, locator: LocatorRecipe | undefined, intent: ActionIntent): Look {
  switch (readiness.status) {
    case 'ready':
      return { kind: 'settled', target: readyTarget(readiness, context) }
    case 'unchanged':
      return { kind: 'settled', target: { ok: true, kind: 'unchanged', page: pageFactsOf(readiness.page), context } }
    case 'missing':
    case 'blocked':
      return { kind: 'unready', unready: readiness }
    default:
      return settledFailure(readiness, elementOf(locator), intent)
  }
}

/**
 * A look that settles the action as a failure, at once, or a choice that waits: one that matched no option yet, or
 * a disabled one.
 */
function settledFailure(
  readiness: Extract<Readiness, { status: 'ambiguous' | 'unsupported' | 'refused' | 'option' | 'invalid' | 'shadow' | 'unreachable' }>,
  locator: LocatorRecipe,
  intent: ActionIntent,
): Look {
  switch (readiness.status) {
    case 'ambiguous':
      return { kind: 'settled', target: failed(ambiguous(readiness.count, locator, intent)) }
    case 'invalid':
      return { kind: 'settled', target: failed(invalidSelector(readiness, locator, intent)) }
    case 'shadow':
      return { kind: 'settled', target: failed(shadowRefused(readiness.host, locator, intent)) }
    case 'unreachable':
      return { kind: 'settled', target: failed(unreachable(readiness.element, locator, intent)) }
    case 'unsupported':
      return { kind: 'settled', target: failed(unsupported(readiness, locator, intent)) }
    case 'refused':
      return { kind: 'settled', target: failed(originRefusal(readiness, intent, locator)) }
    case 'option': {
      const { problem, choice, count } = readiness
      if (problem !== 'ambiguous') return { kind: 'unready', unready: { status: 'option', problem, choice } }
      return { kind: 'settled', target: failed(ambiguousOption(choice, count, locator, intent)) }
    }
  }
}

function readyTarget(readiness: Extract<Readiness, { status: 'ready' }>, context: number): ActionTarget {
  const { point, token, via, scale, page, plan } = readiness
  return { ok: true, kind: 'ready', point, context, token, via: via ?? undefined, scale, page: pageFactsOf(page), plan }
}

// Only an action on an element can meet an element that does not suit it.
function elementOf(locator: LocatorRecipe | undefined): LocatorRecipe {
  if (locator === undefined) throw new Error("Retest's page script judged an element for input the document takes")
  return locator
}

function documentAction({ action }: ActionIntent): DocumentAction {
  if (action === 'press' || action === 'scroll') return action
  throw new Error(`Retest cannot ${action} without an element`)
}

// A key holds its modifiers and is pressed, each released once; the wheel turns once.
function strokesOf(intent: ActionIntent): number {
  return intent.action === 'press' ? intent.strokes : 1
}

/**
 * The failure for a CSS selector the page could not read. It fails at once: the selector is wrong in every document.
 *
 * @example invalidSelector({ step: 0, message: "'::nope' is not a valid selector." }, { by: 'css', selector: '::nope' }, { action: 'click', multiline: false })
 */
export function invalidSelector({ step, message }: { step: number; message: string }, locator: LocatorRecipe, intent: ActionIntent | undefined): Failure {
  const named = locatorSteps(locator)[step]
  const selector = named === undefined ? describeLocator(locator) : describeStep(named, locator.dialect)
  const action = intent === undefined ? `read ${describeLocator(locator)}` : describeAction(intent, locator)
  return { class: 'usage', message: `Could not ${action}: the page cannot read the CSS selector in ${selector}. ${message}`, details: { selector } }
}

/**
 * The failure for a locator by Playwright's rules on a document that holds an open shadow root. Playwright looks inside
 * one, and Retest does not, so it fails at once rather than find less than Playwright would.
 *
 * @example shadowRefused('<todo-list>', { by: 'role', role: 'button', dialect: 'playwright' }, undefined).class // 'unsupported'
 */
export function shadowRefused(host: string, locator: LocatorRecipe, intent: ActionIntent | undefined): Failure {
  const action = intent === undefined ? `read ${describeLocator(locator)}` : describeAction(intent, locator)
  return {
    class: 'unsupported',
    message: `Could not ${action}: the page holds an open shadow root, in ${host}. Playwright looks inside shadow roots and Retest does not, so Retest refuses the lookup rather than find less than Playwright would.`,
    details: { host },
  }
}

function unreachable(element: string, locator: LocatorRecipe, intent: ActionIntent): Failure {
  return {
    class: 'unsupported',
    message: `Could not ${describeAction(intent, locator)}: it is ${element}, and no key a person can press there reaches what was asked, such as an option with no label to type or a hidden option. Retest typed nothing.`,
    details: { element },
  }
}

function failed(failure: Failure): ActionTarget {
  return { ok: false, failure }
}

function ambiguous(count: number, locator: LocatorRecipe, intent: ActionIntent): Failure {
  return {
    class: 'ambiguous',
    message: `Could not ${describeAction(intent, locator)}: it matches ${count} elements, and a locator must match exactly one. Retest did not ${intent.action} any of them.`,
    details: { count },
  }
}

function ambiguousOption(choice: number, count: number, locator: LocatorRecipe, intent: ActionIntent): Failure {
  const named = choiceOf(intent, choice)
  return {
    class: 'ambiguous',
    message: `Could not ${describeAction(intent, locator)}: ${count} options match ${named}, and each choice must match exactly one. Retest selected nothing.`,
    details: { choice: named, count },
  }
}

function unsupported(readiness: Extract<Readiness, { status: 'unsupported' }>, locator: LocatorRecipe, intent: ActionIntent): Failure {
  const { element } = readiness
  const action = describeAction(intent, locator)
  switch (readiness.reason) {
    case 'multiline': {
      const value = intent.secret === undefined ? 'a line break' : `${secretPlaceholder(intent.secret)}, which has a line break`
      return {
        class: 'unsupported',
        message: `Could not fill ${describeLocator(locator)} with ${value}: it is ${element}, which holds one line. Use a textarea for text with \\n or \\r.`,
        details: { field: element },
      }
    }
    case 'field':
      return { class: 'unsupported', message: `Could not ${action}: it is ${element}, and fill supports ${fieldTypes}.`, details: { field: element } }
    case 'checkable':
      return { class: 'unsupported', message: `Could not ${action}: it is ${element}, and ${intent.action}() works on ${checkableKinds}.`, details: { element } }
    case 'radio':
      return {
        class: 'unsupported',
        message: `Could not ${action}: it is a radio button, ${element}. A person unchecks a radio button by choosing another one, so check that one instead.`,
        details: { element },
      }
    case 'select':
      return {
        class: 'unsupported',
        message: `Could not ${action}: it is ${element}, and select() chooses from a <select> element. Choose from a list the page draws itself with click().`,
        details: { element },
      }
    case 'multiple':
      return {
        class: 'usage',
        message: `Could not ${action}: it is ${element}, which takes one option, and select() was given a list. Pass one option, not a list.`,
        details: { element },
      }
  }
}

function unready(last: Unready, locator: LocatorRecipe | undefined, intent: ActionIntent, deadline: Deadline): Failure {
  const action = describeAction(intent, locator)
  const waitedMs = deadline.budgetMs
  switch (last.status) {
    case 'missing': {
      const step = locator === undefined || last.empty === null ? undefined : describeEmptyStep(locator, last.empty)
      return { class: 'not_found', message: `Could not ${action}: no element matched within ${waitedMs} ms.${step === undefined ? '' : ` ${step}`}`, details: { waitedMs } }
    }
    case 'navigating': {
      const opening = describeAddress(last.url)
      return {
        class: 'not_actionable',
        message: `Could not ${action} within ${waitedMs} ms: the page was still opening ${opening}, and Retest does not ${intent.action} in a document about to be replaced.`,
        details: { check: 'navigation', url: opening, waitedMs },
      }
    }
    case 'option':
      return optionUnready(last, action, intent, waitedMs)
    case 'blocked': {
      const covering = last.check === 'hit-target' ? last.detail : null
      const reason = covering === null ? becauseOf[last.check] : `another element, ${covering}, covers its centre`
      return {
        class: 'not_actionable',
        message: `Could not ${action} within ${waitedMs} ms: ${reason}.`,
        details: { check: last.check, covering, waitedMs },
      }
    }
  }
}

// Options often arrive late, so a choice that matched none, or only a disabled one, is waited for.
function optionUnready({ problem, choice }: Extract<Unready, { status: 'option' }>, action: string, intent: ActionIntent, waitedMs: number): Failure {
  const named = choiceOf(intent, choice)
  if (problem === 'missing') {
    return { class: 'not_found', message: `Could not ${action}: no option matched ${named} within ${waitedMs} ms.`, details: { choice: named, waitedMs } }
  }
  return {
    class: 'not_actionable',
    message: `Could not ${action} within ${waitedMs} ms: the option ${named} is disabled.`,
    details: { check: 'enabled', choice: named, waitedMs },
  }
}

function choiceOf(intent: ActionIntent, index: number): string {
  const choice = intent.action === 'select' ? intent.choices[index] : undefined
  if (choice === undefined) throw new Error("Retest's page script named a choice the select was not given")
  return describeOptionChoice(choice)
}

// An address is recorded as its origin and path, since a query can carry what a page was given.
function describeAddress(url: string): string {
  const parsed = URL.parse(url)
  return parsed === null ? url : originAndPath(parsed)
}
