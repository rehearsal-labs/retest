import type { ActionIntent } from './element-queries.ts'
import type { IsolatedWorld } from './isolated-world.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { Failure } from '../protocol/failures.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import { describeLocator } from '../protocol/locator.ts'
import { s } from '../protocol/schema.ts'
import { secretPlaceholder } from '../protocol/secret.ts'
import { isGoneContext } from './isolated-world.ts'
import { originRefusal } from './origin-refusal.ts'
import { disarmFunction, strayFunction, verdictFunction } from './page-scripts.ts'

const guardedEvents = [
  'pointerdown',
  'touchstart',
  'mousedown',
  'pointerup',
  'touchend',
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
 * the one with the keyboard focus, when the guard was done. `leaving` is the origin a fill bound to origins saw
 * the page set off to open before the text arrived; the guard cancelled that navigation and stopped the typing.
 * `replaced` means the page moved to a new document before the guard was done, and `stopped` that the new
 * document's own guard stopped typing that arrived there, meant for the document it replaced.
 */
export type GuardVerdict =
  | { kind: 'seen'; reached: GuardedEvent[]; intercepted: Interception | null; landed: string | null; leaving: string | null }
  | { kind: 'replaced' }
  | { kind: 'stopped'; event: GuardedEvent; by: string; origin: string }

type Interception = { event: GuardedEvent; by: string }

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown }

// The events that start each action's input: a press, a touch, a key, or text.
const firstEvents: Record<ActionIntent['action'], GuardedEvent[]> = {
  click: ['pointerdown'],
  tap: ['pointerdown', 'touchstart'],
  fill: ['keydown', 'beforeinput'],
}

type Press = Exclude<ActionIntent['action'], 'fill'>

// Which part of a press each guarded event belongs to. A tap's own events all go to the element it touched first,
// and the click it makes afterwards is hit-tested again.
const pressStages: Record<Press, Partial<Record<GuardedEvent, 'press' | 'release' | 'click'>>> = {
  click: { pointerdown: 'press', mousedown: 'press', pointerup: 'release', mouseup: 'release', click: 'click' },
  tap: { pointerdown: 'press', touchstart: 'press', pointerup: 'release', touchend: 'release', mousedown: 'click', mouseup: 'click', click: 'click' },
}

const pressWords: Record<Press, { noun: string; done: string; doneAt: string }> = {
  click: { noun: 'press', done: 'pressed', doneAt: 'pressed at' },
  tap: { noun: 'touch', done: 'touched it', doneAt: 'touched' },
}

const eventSchema = s.enum(guardedEvents)

const seenSchema = s.object({
  reached: s.array(eventSchema),
  intercepted: s.nullable(s.object({ event: eventSchema, by: s.string() })),
  landed: s.nullable(s.string()),
  leaving: s.nullable(s.string()),
})

const straySchema = s.nullable(s.object({ event: eventSchema, by: s.string(), origin: s.string() }))

/**
 * Sends an action's input while the guard its element armed watches, then ends the guard and returns what it saw.
 * An event meant for the element that reaches another one is stopped before any listener of the page hears it.
 * When the document has gone by the time the guard would answer, the document that replaced it is asked whether
 * it stopped typing that arrived there.
 *
 * @example const verdict = await guardInput(world, target.guard, deadline, () => clickAt(session, point, deadline, dispatch))
 */
export async function guardInput(
  world: IsolatedWorld,
  guard: Guard,
  deadline: Deadline,
  input: () => Promise<void>,
): Promise<GuardVerdict> {
  // Asked before the input goes, so the answer still comes when the input makes the page open a new document.
  // When the input itself fails, that failure is the answer, and this one is never read.
  const verdict = settled(world.callIn(guard.context, verdictFunction, [guard.token], seenSchema, deadline))
  await input()
  await disarmGuard(world, guard, deadline)
  const answer = await verdict
  if (answer.ok) return { kind: 'seen', ...answer.value }
  if (!isGoneContext(answer.error)) throw answer.error
  const stray = await world.call(strayFunction, [], straySchema, deadline)
  return stray === null ? { kind: 'replaced' } : { kind: 'stopped', ...stray }
}

/**
 * Ends an arming in the guard's own document. A document that has gone took the arming with it.
 *
 * @example await disarmGuard(world, target.guard, deadline)
 */
export async function disarmGuard(world: IsolatedWorld, guard: Guard, deadline: Deadline): Promise<void> {
  try {
    await world.callIn(guard.context, disarmFunction, [guard.token], s.boolean(), deadline)
  } catch (error) {
    if (!isGoneContext(error)) throw error
  }
}

/**
 * The failure for input that did not reach its element, or undefined when it did. Input that another element
 * took was stopped, so the element is not actionable, and so was typing held back from a page that set off for
 * another document, or stopped by the document that replaced it. Input that never reached the element's
 * document, or that a new document replaced without a trace, may have done anything, so its outcome is unknown.
 *
 * @example guardFailure({ kind: 'replaced' }, { action: 'click', multiline: false }, { by: 'testId', value: 'save' })
 */
export function guardFailure(verdict: GuardVerdict, intent: ActionIntent, locator: LocatorRecipe): Failure | undefined {
  const { action } = intent
  const target = describeLocator(locator)
  if (verdict.kind === 'stopped' && action === 'fill') return typingStopped(verdict.origin, intent, locator)
  if (verdict.kind !== 'seen') {
    return {
      class: 'outcome_unknown',
      message: `The page moved to a new document while Retest tried to ${action} ${target}, so Retest cannot tell whether the ${action} took effect.`,
      details: { reason: 'the page moved to a new document' },
    }
  }
  const { reached, intercepted, landed, leaving } = verdict
  if (leaving !== null) return originRefusal({ origin: leaving, leaving: true }, intent, locator)
  if (intercepted !== null) return action === 'fill' ? typingTaken(target, intercepted) : pressTaken(action, target, intercepted)
  if (reached.some((event) => firstEvents[action].includes(event))) return undefined
  const there = landed ?? 'no element'
  if (action === 'fill') {
    return {
      class: 'outcome_unknown',
      message: `Retest typed into ${target}, but the text never reached the element's document, and the keyboard focus is on ${there}. Retest cannot tell what received the text.`,
      details: { focus: landed },
    }
  }
  const { noun, doneAt } = pressWords[action]
  return {
    class: 'outcome_unknown',
    message: `Retest ${doneAt} the centre of ${target}, but the ${noun} never reached the element's document, and ${there} is at that point. Retest cannot tell what received the ${action}.`,
    details: { landed },
  }
}

function pressTaken(action: Press, target: string, { event, by }: Interception): Failure {
  const details = { check: 'hit-target', interceptedBy: by, event }
  const failure = (reason: string): Failure => ({ class: 'not_actionable', message: `Could not ${action} ${target}: ${reason}`, details })
  const { noun, done } = pressWords[action]
  switch (pressStages[action][event]) {
    case 'press':
      return failure(`another element, ${by}, was on top of it when Retest ${done}. Retest stopped the ${action} before the page received it.`)
    case 'release':
      return failure(`it took the ${noun}, but another element, ${by}, took the release. Retest stopped the release and the click before the page received them.`)
    default:
      return action === 'click'
        ? failure(`it took the press and the release, but the click went to another element, ${by}. Retest stopped the click before the page received it.`)
        : failure(`it took the touch, but the click that follows a tap went to another element, ${by}. Retest stopped the click before the page received it.`)
  }
}

function typingTaken(target: string, { event, by }: Interception): Failure {
  return {
    class: 'not_actionable',
    message: `Could not fill ${target}: the keyboard focus moved to another element, ${by}, before Retest typed. Retest stopped the typing before the page received it.`,
    details: { check: 'focused', focus: by, event },
  }
}

// An opaque origin, such as `about:blank`'s, arrives as `'null'`.
function typingStopped(origin: string, intent: ActionIntent, locator: LocatorRecipe): Failure {
  const text = intent.secret === undefined ? 'the text' : secretPlaceholder(intent.secret)
  const opaque = origin === 'null'
  const where = opaque ? 'a page with no web origin' : origin
  return {
    class: 'not_actionable',
    message: `Could not fill ${describeLocator(locator)} with ${text}: the page moved to ${where} before the text arrived. Retest stopped the typing before that document received it, and typed nothing.`,
    details: { origin: opaque ? null : origin, moved: true },
  }
}

function settled<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value): Settled<T> => ({ ok: true, value }),
    (error: unknown): Settled<T> => ({ ok: false, error }),
  )
}
