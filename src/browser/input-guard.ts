import type { ActionIntent } from './element-queries.ts'
import type { IsolatedWorld } from './isolated-world.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { Failure } from '../protocol/failures.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import type { Schema } from '../protocol/schema.ts'
import { describeLocator } from '../protocol/locator.ts'
import { s } from '../protocol/schema.ts'
import { isGoneContext } from './isolated-world.ts'
import { disarmFunction, verdictFunction } from './page-scripts.ts'

const guardedEvents = [
  'pointerdown',
  'mousedown',
  'pointerup',
  'mouseup',
  'click',
  'keydown',
  'beforeinput',
  'input',
  'keyup',
] as const

export type GuardedEvent = (typeof guardedEvents)[number]

/** The input guard an element armed when it passed its checks: the document it is in, and which arming. */
export type Guard = { context: number; token: number }

/**
 * What the guard saw of an action's input. `reached` lists the events that went to the element, `intercepted`
 * the first one another element took, which the guard stopped, and `landed` the element at the press point, or
 * the one with the keyboard focus, when the guard was done. `replaced` means the page moved to a new document
 * before the guard was done.
 */
export type GuardVerdict =
  | { kind: 'seen'; reached: GuardedEvent[]; intercepted: Interception | null; landed: string | null }
  | { kind: 'replaced' }

type Interception = { event: GuardedEvent; by: string }

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown }

// The events that start each action's input: a press, a key, or text.
const firstEvents: Record<ActionIntent['action'], GuardedEvent[]> = {
  click: ['pointerdown'],
  fill: ['keydown', 'beforeinput'],
}

const eventSchema = s.enum(guardedEvents)

const seenSchema = s.object({
  reached: s.array(eventSchema),
  intercepted: s.nullable(s.object({ event: eventSchema, by: s.string() })),
  landed: s.nullable(s.string()),
})

/**
 * Sends an action's input while the guard its element armed watches, then ends the guard and returns what it saw.
 * An event meant for the element that reaches another one is stopped before any listener of the page hears it.
 *
 * @example const verdict = await guardInput(world, target.guard, deadline, () => clickAt(session, point, deadline, dispatch))
 */
export async function guardInput(
  world: IsolatedWorld,
  guard: Guard,
  deadline: Deadline,
  input: () => Promise<void>,
): Promise<GuardVerdict> {
  const ask = <T>(functionDeclaration: string, schema: Schema<T>) =>
    world.callIn(guard.context, functionDeclaration, [guard.token], schema, deadline)
  // Asked before the input goes, so the answer still comes when the input makes the page open a new document.
  // When the input itself fails, that failure is the answer, and this one is never read.
  const verdict = settled(ask(verdictFunction, seenSchema))
  await input()
  try {
    await ask(disarmFunction, s.boolean())
  } catch (error) {
    if (!isGoneContext(error)) throw error
  }
  const answer = await verdict
  if (answer.ok) return { kind: 'seen', ...answer.value }
  if (isGoneContext(answer.error)) return { kind: 'replaced' }
  throw answer.error
}

/**
 * The failure for input that did not reach its element, or undefined when it did. Input that another element
 * took was stopped, so the element is not actionable. Input that never reached the element's document, or
 * that a new document replaced, may have done anything, so its outcome is unknown.
 *
 * @example guardFailure({ kind: 'replaced' }, { action: 'click', multiline: false }, { by: 'testId', value: 'save' })
 */
export function guardFailure(verdict: GuardVerdict, { action }: ActionIntent, locator: LocatorRecipe): Failure | undefined {
  const target = describeLocator(locator)
  if (verdict.kind === 'replaced') {
    return {
      class: 'outcome_unknown',
      message: `The page moved to a new document while Retest tried to ${action} ${target}, so Retest cannot tell whether the ${action} took effect.`,
      details: { reason: 'the page moved to a new document' },
    }
  }
  const { reached, intercepted, landed } = verdict
  if (intercepted !== null) return action === 'click' ? clickTaken(target, intercepted) : typingTaken(target, intercepted)
  if (reached.some((event) => firstEvents[action].includes(event))) return undefined
  const there = landed ?? 'no element'
  if (action === 'click') {
    return {
      class: 'outcome_unknown',
      message: `Retest pressed at the centre of ${target}, but the press never reached the element's document, and ${there} is at that point. Retest cannot tell what received the click.`,
      details: { landed },
    }
  }
  return {
    class: 'outcome_unknown',
    message: `Retest typed into ${target}, but the text never reached the element's document, and the keyboard focus is on ${there}. Retest cannot tell what received the text.`,
    details: { focus: landed },
  }
}

function clickTaken(target: string, { event, by }: Interception): Failure {
  const details = { check: 'hit-target', interceptedBy: by, event }
  if (event === 'pointerdown' || event === 'mousedown') {
    return {
      class: 'not_actionable',
      message: `Could not click ${target}: another element, ${by}, was on top of it when Retest pressed. Retest stopped the click before the page received it.`,
      details,
    }
  }
  if (event === 'pointerup' || event === 'mouseup') {
    return {
      class: 'not_actionable',
      message: `Could not click ${target}: it took the press, but another element, ${by}, took the release. Retest stopped the release and the click before the page received them.`,
      details,
    }
  }
  return {
    class: 'not_actionable',
    message: `Could not click ${target}: it took the press and the release, but the click went to another element, ${by}. Retest stopped the click before the page received it.`,
    details,
  }
}

function typingTaken(target: string, { event, by }: Interception): Failure {
  return {
    class: 'not_actionable',
    message: `Could not fill ${target}: the keyboard focus moved to another element, ${by}, before Retest typed. Retest stopped the typing before the page received it.`,
    details: { check: 'focused', focus: by, event },
  }
}

function settled<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value): Settled<T> => ({ ok: true, value }),
    (error: unknown): Settled<T> => ({ ok: false, error }),
  )
}
