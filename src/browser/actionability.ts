import type { ActionIntent, Check, Readiness } from './element-queries.ts'
import type { Guard } from './input-guard.ts'
import type { Point } from './input.ts'
import type { InDocument, IsolatedWorld } from './isolated-world.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { Failure } from '../protocol/failures.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import { setTimeout as sleep } from 'node:timers/promises'
import { describeLocator } from '../protocol/locator.ts'
import { secretPlaceholder } from '../protocol/secret.ts'
import { CdpTimeoutError } from './cdp/errors.ts'
import { prepare } from './element-queries.ts'
import { originRefusal } from './origin-refusal.ts'
import { originAndPath } from './page-url.ts'

/** Where to press an element that passed every check, and the guard it armed for the input. */
export type ActionTarget = { ok: true; point: Point; guard: Guard } | { ok: false; failure: Failure }

/** A navigation the browser has begun in the main frame. Its document replaces the current one when it commits. */
export type PendingNavigation = { url: string }

export type ActionabilityOptions = {
  world: IsolatedWorld
  locator: LocatorRecipe
  intent: ActionIntent
  deadline: Deadline
  /** The navigation the browser is on, if any. While there is one, the page is not looked at. */
  pendingNavigation: () => PendingNavigation | undefined
}

type Unready = Extract<Readiness, { status: 'missing' | 'blocked' }> | { status: 'navigating'; url: string }
type Look = { kind: 'settled'; target: ActionTarget } | { kind: 'unready'; unready: Unready }

const firstPauseMs = 20
const maxPauseMs = 200

const fieldTypes = 'a textarea, or an input of type text, search, email, url, tel, password or number'

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
 * Resolves the locator again and again until one element passes every check, then returns where to press.
 * More than one match, a field `fill` cannot use, or an origin it may not type into fails at once; anything else
 * waits for the deadline. While the browser is opening another document in the frame, the page is not looked
 * at: the element is looked for in the document that arrives.
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
    seen = await prepare(world, locator, intent, deadline)
  } catch (error) {
    // The deadline ran out during a look, so the previous look is the latest answer there is.
    if (last !== undefined && error instanceof CdpTimeoutError) return { kind: 'settled', target: failed(unready(last, locator, intent, deadline)) }
    throw error
  }
  const { value: readiness, context } = seen
  switch (readiness.status) {
    case 'ready':
      return { kind: 'settled', target: { ok: true, point: { x: readiness.x, y: readiness.y }, guard: { context, token: readiness.token } } }
    case 'ambiguous':
      return { kind: 'settled', target: failed(ambiguous(readiness.count, locator, intent)) }
    case 'unsupported':
      return { kind: 'settled', target: failed(unsupported(readiness, locator, intent)) }
    case 'refused':
      return { kind: 'settled', target: failed(originRefusal(readiness, intent, locator)) }
    default:
      return { kind: 'unready', unready: readiness }
  }
}

function failed(failure: Failure): ActionTarget {
  return { ok: false, failure }
}

function ambiguous(count: number, locator: LocatorRecipe, { action }: ActionIntent): Failure {
  return {
    class: 'ambiguous',
    message: `Could not ${action} ${describeLocator(locator)}: it matches ${count} elements, and a locator must match exactly one. Retest did not ${action} any of them.`,
    details: { count },
  }
}

function unsupported(readiness: Extract<Readiness, { status: 'unsupported' }>, locator: LocatorRecipe, { secret }: ActionIntent): Failure {
  const { field } = readiness
  if (readiness.reason === 'multiline') {
    const value = secret === undefined ? 'a line break' : `${secretPlaceholder(secret)}, which has a line break`
    return {
      class: 'unsupported',
      message: `Could not fill ${describeLocator(locator)} with ${value}: it is ${field}, which holds one line. Use a textarea for text with \\n or \\r.`,
      details: { field },
    }
  }
  return {
    class: 'unsupported',
    message: `Could not fill ${describeLocator(locator)}: it is ${field}, and fill supports ${fieldTypes}.`,
    details: { field },
  }
}

function unready(last: Unready, locator: LocatorRecipe, { action }: ActionIntent, deadline: Deadline): Failure {
  const target = describeLocator(locator)
  const waitedMs = deadline.budgetMs
  if (last.status === 'missing') {
    return {
      class: 'not_found',
      message: `Could not ${action} ${target}: no element matched within ${waitedMs} ms.`,
      details: { waitedMs },
    }
  }
  if (last.status === 'navigating') {
    const opening = describeAddress(last.url)
    return {
      class: 'not_actionable',
      message: `Could not ${action} ${target} within ${waitedMs} ms: the page was still opening ${opening}, and Retest does not ${action} in a document about to be replaced.`,
      details: { check: 'navigation', url: opening, waitedMs },
    }
  }
  const covering = last.check === 'hit-target' ? last.detail : null
  const reason = covering === null ? becauseOf[last.check] : `another element, ${covering}, covers its centre`
  return {
    class: 'not_actionable',
    message: `Could not ${action} ${target} within ${waitedMs} ms: ${reason}.`,
    details: { check: last.check, covering, waitedMs },
  }
}

// An address is recorded as its origin and path, since a query can carry what a page was given.
function describeAddress(url: string): string {
  const parsed = URL.parse(url)
  return parsed === null ? url : originAndPath(parsed)
}
