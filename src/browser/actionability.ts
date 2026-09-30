import type { ActionIntent, Check, Readiness } from './element-queries.ts'
import type { Guard } from './input-guard.ts'
import type { Point } from './input.ts'
import type { InDocument, IsolatedWorld } from './isolated-world.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { Failure } from '../protocol/failures.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import { setTimeout as sleep } from 'node:timers/promises'
import { describeLocator } from '../protocol/locator.ts'
import { CdpTimeoutError } from './cdp/errors.ts'
import { prepare } from './element-queries.ts'

/** Where to press an element that passed every check, and the guard it armed for the input. */
export type ActionTarget = { ok: true; point: Point; guard: Guard } | { ok: false; failure: Failure }

type Unready = Extract<Readiness, { status: 'missing' | 'blocked' }>

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
  'hit-target': 'no element takes a click at its centre',
  focused: 'it did not keep the keyboard focus',
}

/**
 * Resolves the locator again and again until one element passes every check, then returns where to press.
 * More than one match, or a field `fill` cannot use, fails at once; anything else waits for the deadline.
 */
export async function waitUntilActionable(
  world: IsolatedWorld,
  locator: LocatorRecipe,
  intent: ActionIntent,
  deadline: Deadline,
): Promise<ActionTarget> {
  let last: Unready | undefined
  for (let attempt = 0; ; attempt += 1) {
    let look: InDocument<Readiness>
    try {
      look = await prepare(world, locator, intent, deadline)
    } catch (error) {
      // The deadline ran out during a look, so the previous look is the latest answer there is.
      if (last !== undefined && error instanceof CdpTimeoutError) return failed(unready(last, locator, intent, deadline))
      throw error
    }
    const { value: readiness, context } = look
    switch (readiness.status) {
      case 'ready':
        return { ok: true, point: { x: readiness.x, y: readiness.y }, guard: { context, token: readiness.token } }
      case 'ambiguous':
        return failed(ambiguous(readiness.count, locator, intent))
      case 'unsupported':
        return failed(unsupported(readiness, locator))
    }
    last = readiness
    if (deadline.expired) return failed(unready(last, locator, intent, deadline))
    await sleep(Math.min(firstPauseMs * 2 ** attempt, maxPauseMs, deadline.remainingMs), undefined, { signal: deadline.signal })
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

function unsupported(readiness: Extract<Readiness, { status: 'unsupported' }>, locator: LocatorRecipe): Failure {
  const { field } = readiness
  if (readiness.reason === 'multiline') {
    return {
      class: 'unsupported',
      message: `Could not fill ${describeLocator(locator)} with a line break: it is ${field}, which holds one line. Use a textarea for text with \\n or \\r.`,
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
  const covering = last.check === 'hit-target' ? last.detail : null
  const reason = covering === null ? becauseOf[last.check] : `another element, ${covering}, covers its centre`
  return {
    class: 'not_actionable',
    message: `Could not ${action} ${target} within ${waitedMs} ms: ${reason}.`,
    details: { check: last.check, covering, waitedMs },
  }
}
