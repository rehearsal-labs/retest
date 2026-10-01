import type { ActionIntent, Pointer } from './element-queries.ts'
import type { IsolatedWorld } from './isolated-world.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { Failure } from '../protocol/failures.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import { describeLocator } from '../protocol/locator.ts'
import { s } from '../protocol/schema.ts'
import { secretPlaceholder } from '../protocol/secret.ts'
import { shorten } from '../protocol/text.ts'
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
  'keypress',
  'beforeinput',
  'input',
  'keyup',
  'wheel',
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

/** An action the guard watches: every one but `select`, whose input is Retest's own script. */
export type GuardedIntent = Exclude<ActionIntent, { action: 'select' }>

// The events that start each input: a press, a touch, a key, text, or the wheel.
const firstEvents: Record<Pointer | 'fill' | 'press' | 'scroll', GuardedEvent[]> = {
  click: ['pointerdown'],
  tap: ['pointerdown', 'touchstart'],
  fill: ['keydown', 'beforeinput'],
  press: ['keydown'],
  scroll: ['wheel'],
}

// Which part of a pointer's input each guarded event belongs to. A tap's own events all go to the element it
// touched first, and the click it makes afterwards is hit-tested again.
const pointerStages: Record<Pointer, Partial<Record<GuardedEvent, 'press' | 'release' | 'click'>>> = {
  click: { pointerdown: 'press', mousedown: 'press', pointerup: 'release', mouseup: 'release', click: 'click' },
  tap: { pointerdown: 'press', touchstart: 'press', pointerup: 'release', touchend: 'release', mousedown: 'click', mouseup: 'click', click: 'click' },
}

const pointerWords: Record<Pointer, { noun: string; done: string; doneAt: string }> = {
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
 * A `check` or `uncheck` is judged as the click or tap that made it.
 *
 * @example guardFailure({ kind: 'replaced' }, { action: 'click', multiline: false }, { by: 'testId', value: 'save' })
 */
export function guardFailure(verdict: GuardVerdict, intent: GuardedIntent, locator: LocatorRecipe | undefined): Failure | undefined {
  switch (intent.action) {
    case 'press':
      return keyFailure(verdict, intent.key, locator)
    case 'scroll':
      return wheelFailure(verdict, locator)
    case 'fill':
      return typingFailure(verdict, intent, elementOf(locator))
    case 'check':
    case 'uncheck':
      return pointerFailure(verdict, { verb: intent.action, pointer: intent.pointer }, elementOf(locator))
    default:
      return pointerFailure(verdict, { verb: intent.action, pointer: intent.action }, elementOf(locator))
  }
}

// A click or a tap, and the action it makes, which names it in messages: itself, or a check or an uncheck.
type PointerInput = { verb: string; pointer: Pointer }

function pointerFailure(verdict: GuardVerdict, { verb, pointer }: PointerInput, locator: LocatorRecipe): Failure | undefined {
  const target = describeLocator(locator)
  if (verdict.kind !== 'seen') return movedAway(verb, target)
  const { reached, intercepted, landed } = verdict
  if (intercepted !== null) return pointerTaken({ verb, pointer }, target, intercepted)
  if (reached.some((event) => firstEvents[pointer].includes(event))) return undefined
  const { noun, doneAt } = pointerWords[pointer]
  return {
    class: 'outcome_unknown',
    message: `Retest ${doneAt} the centre of ${target}, but the ${noun} never reached the element's document, and ${landed ?? 'no element'} is at that point. Retest cannot tell what received the ${pointer}.`,
    details: { landed },
  }
}

function typingFailure(verdict: GuardVerdict, intent: ActionIntent, locator: LocatorRecipe): Failure | undefined {
  const target = describeLocator(locator)
  if (verdict.kind === 'stopped') return typingStopped(verdict.origin, intent, locator)
  if (verdict.kind !== 'seen') return movedAway('fill', target)
  const { reached, intercepted, landed, leaving } = verdict
  if (leaving !== null) return originRefusal({ origin: leaving, leaving: true }, intent, locator)
  if (intercepted !== null) return typingTaken(target, intercepted)
  if (reached.some((event) => firstEvents.fill.includes(event))) return undefined
  return {
    class: 'outcome_unknown',
    message: `Retest typed into ${target}, but the text never reached the element's document, and the keyboard focus is on ${landed ?? 'no element'}. Retest cannot tell what received the text.`,
    details: { focus: landed },
  }
}

/**
 * The failure for the wheel turned at the centre of an element, or of the viewport for the page, or undefined when
 * its wheel event reached the element, or the page's document. A wheel another element took was stopped before
 * the page heard it, and nothing scrolled. A wheel that never reached the document, as over a frame, may have
 * scrolled anything.
 *
 * @example wheelFailure({ kind: 'replaced' }, undefined)
 */
export function wheelFailure(verdict: GuardVerdict, locator: LocatorRecipe | undefined): Failure | undefined {
  const target = locator === undefined ? 'the page' : describeLocator(locator)
  if (verdict.kind !== 'seen') return movedAway('scroll', target)
  const { reached, intercepted, landed } = verdict
  if (intercepted !== null) {
    return {
      class: 'not_actionable',
      message: `Could not scroll ${target}: another element, ${intercepted.by}, took the wheel. Retest stopped it before the page received it, and nothing scrolled.`,
      details: { check: 'hit-target', interceptedBy: intercepted.by, event: intercepted.event },
    }
  }
  if (reached.some((event) => firstEvents.scroll.includes(event))) return undefined
  const where = locator === undefined ? 'the viewport' : target
  const destination = locator === undefined ? "the page's document" : "the element's document"
  return {
    class: 'outcome_unknown',
    message: `Retest turned the wheel at the centre of ${where}, but it never reached ${destination}, and ${landed ?? 'no element'} is at that point. Retest cannot tell what received it.`,
    details: { landed },
  }
}

/**
 * The failure for a key, pressed on an element or, with no locator, on the page's keyboard, or undefined when
 * its keydown reached the element, or the page's document. The rest of the keystroke belongs to the page. A
 * keydown another element took was stopped before the page heard it. A key that never reached the document, as
 * when the focus is inside a frame, or whose document was replaced first, may have done anything.
 *
 * @example keyFailure({ kind: 'replaced' }, 'Enter', undefined)
 */
export function keyFailure(verdict: GuardVerdict, key: string, locator: LocatorRecipe | undefined): Failure | undefined {
  const target = locator === undefined ? '' : ` on ${describeLocator(locator)}`
  const pressed = `${shorten(key)}${target}`
  if (verdict.kind !== 'seen') {
    return {
      class: 'outcome_unknown',
      message: `The page moved to a new document while Retest pressed ${pressed}, so Retest cannot tell whether the key took effect.`,
      details: { reason: 'the page moved to a new document' },
    }
  }
  const { reached, intercepted, landed } = verdict
  if (intercepted !== null) {
    return {
      class: 'not_actionable',
      message: `Could not press ${pressed}: the keyboard focus moved to another element, ${intercepted.by}, before the key arrived. Retest stopped the key before the page received it.`,
      details: { check: 'focused', focus: intercepted.by, event: intercepted.event },
    }
  }
  if (reached.some((event) => firstEvents.press.includes(event))) return undefined
  const destination = locator === undefined ? "the page's document" : "the element's document"
  return {
    class: 'outcome_unknown',
    message: `Retest pressed ${pressed}, but the key never reached ${destination}, and the keyboard focus is on ${landed ?? 'no element'}. Retest cannot tell what received the key.`,
    details: { focus: landed },
  }
}

function pointerTaken({ verb, pointer }: PointerInput, target: string, { event, by }: Interception): Failure {
  const details = { check: 'hit-target', interceptedBy: by, event }
  const failure = (reason: string): Failure => ({ class: 'not_actionable', message: `Could not ${verb} ${target}: ${reason}`, details })
  const { noun, done } = pointerWords[pointer]
  switch (pointerStages[pointer][event]) {
    case 'press':
      return failure(`another element, ${by}, was on top of it when Retest ${done}. Retest stopped the ${pointer} before the page received it.`)
    case 'release':
      return failure(`it took the ${noun}, but another element, ${by}, took the release. Retest stopped the release and the click before the page received them.`)
    default:
      return pointer === 'click'
        ? failure(`it took the press and the release, but the click went to another element, ${by}. Retest stopped the click before the page received it.`)
        : failure(`it took the touch, but the click that follows a tap went to another element, ${by}. Retest stopped the click before the page received it.`)
  }
}

function movedAway(verb: string, target: string): Failure {
  return {
    class: 'outcome_unknown',
    message: `The page moved to a new document while Retest tried to ${verb} ${target}, so Retest cannot tell whether the ${verb} took effect.`,
    details: { reason: 'the page moved to a new document' },
  }
}

// Only an action on an element can be judged against one.
function elementOf(locator: LocatorRecipe | undefined): LocatorRecipe {
  if (locator === undefined) throw new Error('Retest judged input on an element without one')
  return locator
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
