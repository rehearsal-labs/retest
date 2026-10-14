import type { PendingNavigation } from './actionability.ts'
import type { CdpSession } from './cdp/session.ts'
import type { BrowserCommand } from './contract.ts'
import type { Dispatch } from './dispatch.ts'
import type { Check, Readiness } from './element-queries.ts'
import type { Point } from './input.ts'
import type { Guard, GuardVerdict } from './input-guard.ts'
import type { IsolatedWorld } from './isolated-world.ts'
import type { CommandResult } from '../protocol/commands.ts'
import type { DragThrough } from '../protocol/drag.ts'
import type { Failure } from '../protocol/failures.ts'
import type { EmptyStep, LocatorRecipe } from '../protocol/locator.ts'
import type { PageFacts } from '../protocol/page-facts.ts'
import { waitBeforeRead } from '../assertions/wait-before-read.ts'
import { Deadline } from '../protocol/deadline.ts'
import { defaultDragSteps, dragProblem } from '../protocol/drag.ts'
import { describeEmptyStep, describeLocator, describeStep, locatorSteps } from '../protocol/locator.ts'
import { s } from '../protocol/schema.ts'
import { CdpAbortedError, CdpTimeoutError } from './cdp/errors.ts'
import { readProtocol, request, sendOptions } from './cdp-results.ts'
import { documentFactsSchema, pageFactsOf } from './document-facts.ts'
import { prepare } from './element-queries.ts'
import { disarmGuard, guardInput } from './input-guard.ts'
import { isGoneContext } from './isolated-world.ts'
import { locatorArguments } from './locate.ts'
import { originAndPath } from './page-url.ts'
import { locatorHelpers, pageFactsFunction } from './page-scripts.ts'

// Drag and drop on a Chromium page. The mouse is pressed on the source, moved through the steps to the target and
// released there, which drives a page that follows the mouse itself, such as a sortable list. Chrome does not run an
// HTML drag (`draggable`, `dragstart`, `drop`) from mouse events a test sends: once the press and a move begin one, it
// hands the drag to Retest instead (`Input.setInterceptDrags`), and Retest carries it on with drag events to the target
// and drops it there, so the page's `drop` handler reads the drag's `dataTransfer`. A drag is the browser's once Chrome
// hands it over; Chrome tells of it after the move that began it, sometimes after answering that move, so Retest asks the
// page whether a `dragstart` it did not cancel was heard, by a listener of Retest's own that hears it before the page's,
// before it waits for the drag. A drag that fails part way is cancelled, so the page takes input again.

/** A page as a drag needs it: its session, Retest's world in its main frame, its navigation and its input's cause. */
export type DragPage = {
  readonly session: CdpSession
  readonly world: IsolatedWorld
  readonly touch: boolean
  readonly pendingNavigation: () => PendingNavigation | undefined
  /** Runs the work that delivers the drag's input, so a navigation it starts is the drag's. */
  readonly delivering: <T>(work: () => Promise<T>) => Promise<T>
}

type DragCommand = Extract<BrowserCommand, { kind: 'dragTo' }>

/** Which of a drag's two elements a look or a failure is about. */
type Role = 'source' | 'target'

/** The drag as Chrome handed it over: what it carries and the operations it allows, passed back as Chrome gave them. */
type DragData = {
  items: { mimeType: string; data: string; title?: string; baseURL?: string }[]
  files?: string[]
  dragOperationsMask: number
}

const dragDataSchema = s.object({
  items: s.array(s.object({ mimeType: s.string(), data: s.string(), title: s.optional(s.string()), baseURL: s.optional(s.string()) })),
  files: s.optional(s.array(s.string())),
  dragOperationsMask: s.number({ integer: true }),
})
const interceptedSchema = s.object({ data: dragDataSchema })

/** Where the target stands for a drop, read without arming anything: its visible centre, or why there is none. */
type Spot =
  | { status: 'ready'; point: Point; covered: string | null }
  | { status: 'missing' }
  | { status: 'ambiguous'; count: number }
  | { status: 'hidden' }
  | { status: 'outside' }

const spotSchema = s.discriminatedUnion('status', [
  s.object({ status: s.literal('ready'), point: s.object({ x: s.number(), y: s.number() }), covered: s.nullable(s.string()) }),
  s.object({ status: s.literal('missing') }),
  s.object({ status: s.literal('ambiguous'), count: s.number({ integer: true, min: 2 }) }),
  s.object({ status: s.literal('hidden') }),
  s.object({ status: s.literal('outside') }),
])

// The target's visible centre in the viewport, as a press's look finds an element's, and what the hit test finds there,
// through open shadow roots. It arms no guard, so the source's arming stays the one the press is checked against.
const spotFunction = `function dragSpot(query, ...elements) {
  ${locatorHelpers}
  // A block of its own, so no name here meets one of the helpers'.
  {
    const resolved = resolve(query, elements)
    if (resolved.invalid !== null || resolved.found.length === 0) return { status: 'missing' }
    if (resolved.found.length > 1) return { status: 'ambiguous', count: resolved.found.length }
    const element = resolved.found[0]
    if (!element.isConnected || !isVisible(element)) return { status: 'hidden' }
    const box = element.getBoundingClientRect()
    const { offsetLeft, offsetTop, width, height } = visualViewport
    const left = Math.max(box.left, offsetLeft)
    const right = Math.min(box.right, offsetLeft + width)
    const top = Math.max(box.top, offsetTop)
    const bottom = Math.min(box.bottom, offsetTop + height)
    if (right <= left || bottom <= top) return { status: 'outside' }
    const point = { x: (left + right) / 2, y: (top + bottom) / 2 }
    let hit = document.elementFromPoint(point.x, point.y)
    while (hit !== null && hit.shadowRoot !== null) {
      const inner = hit.shadowRoot.elementFromPoint(point.x, point.y)
      if (inner === null || inner === hit) break
      hit = inner
    }
    let inside = false
    for (let node = hit; node !== null && node !== undefined; node = node.parentNode instanceof ShadowRoot ? node.parentNode.host : node.parentNode) {
      if (node === element) inside = true
    }
    return { status: 'ready', point, covered: inside ? null : hit === null ? 'nothing' : describe(hit) }
  }
}`

// Retest's world in every document hears each dragstart and drop the page hears, before any listener of the page's own:
// it is added as the document starts, so a page that stops a dragstart's propagation, or a drop's, still lets Retest
// hear it. It notes only while a drag of Retest's is armed, and keeps the first of each: the dragstart, which Retest reads
// once the page's own listeners ran to learn whether the page let the drag begin, and the element a drop reached.
const dragListener = String.raw`
  if (globalThis.retestDrags === undefined) {
    const drags = { armed: null }
    const heard = (event) => {
      const armed = drags.armed
      if (armed === null || !event.isTrusted) return
      if (event.type === 'dragstart') armed.start ??= event
      else armed.drop ??= event.composedPath()[0] ?? event.target
    }
    for (const type of ['dragstart', 'drop']) addEventListener(type, heard, { capture: true })
    globalThis.retestDrags = drags
  }
`

/** Installs Retest's drag listener in each new document, before the page's own scripts run. */
export const dragListenerScript: string = `(() => {
${dragListener}
})()`

// Arms the listener for one drag. A document that began before Retest added the listener, as an app's first window
// does, gets it now, after the page's own.
const armFunction = `function armDrags() {
  ${dragListener}
  globalThis.retestDrags.armed = { start: null, drop: null }
  return true
}`

const startedFunction = `function dragStarted() {
  const event = globalThis.retestDrags?.armed?.start ?? null
  return event === null ? 'none' : event.defaultPrevented ? 'prevented' : 'started'
}`

// Where the drop went: nowhere the page heard, the target or an element inside it, through open shadow roots, or another
// element, described.
const droppedFunction = `function dropped(query, ...elements) {
  ${locatorHelpers}
  {
    const reached = globalThis.retestDrags?.armed?.drop ?? null
    if (reached === null) return { status: 'none' }
    const resolved = resolve(query, elements)
    const target = resolved.invalid === null && resolved.found.length === 1 ? resolved.found[0] : null
    for (let node = reached; node !== null && node !== undefined; node = node.parentNode instanceof ShadowRoot ? node.parentNode.host : node.parentNode) {
      if (node === target) return { status: 'target' }
    }
    return { status: 'elsewhere', by: reached instanceof Element ? describe(reached) : 'the page' }
  }
}`

const disarmFunction = `function disarmDrags() {
  if (globalThis.retestDrags !== undefined) globalThis.retestDrags.armed = null
  return true
}`

// Whether the guard armed with `token` stopped the press because another element took it. Read while the guard is still
// armed, so the release that frees the button is stopped too, with the click it would make. The guard's own state is
// read here because no answer of its verdict comes before it is disarmed.
const pressTakenFunction = `function pressTaken(token) {
  const armed = globalThis.retestGuard?.armed ?? null
  return armed !== null && armed.token === token && armed.intercepted !== null
}`

const startedSchema = s.enum(['none', 'prevented', 'started'])
const droppedSchema = s.discriminatedUnion('status', [s.object({ status: s.literal('none') }), s.object({ status: s.literal('target') }), s.object({ status: s.literal('elsewhere'), by: s.string() })])

/** Both elements ready, the source's guard armed for the press, and where to press and to drop. */
type Ready = { kind: 'ready'; from: Point; to: Point; guard: Guard; page: PageFacts }

/** Why the look is not ready yet, which the drag waits out, and says when its time runs out. */
type Unready =
  | { status: 'missing'; role: Role; empty: EmptyStep | null }
  | { status: 'blocked'; role: Role; check: Check; covering: string | null }
  | { status: 'apart' }
  | { status: 'navigating'; url: string }
  | { status: 'timeout'; error: CdpTimeoutError }

type Look = Ready | { kind: 'failed'; failure: Failure } | { kind: 'unready'; unready: Unready }

const firstPauseMs = 20
const maxPauseMs = 200
// How far apart, in CSS pixels, the target's centre at the drop may be from where the moves went without another move.
const dropTolerance = 1

const hover = { action: 'hover', multiline: false } as const
const click = { action: 'click', multiline: false } as const

/**
 * Drags the element `command.locator` finds onto the element `command.target` finds. Nothing is sent until both are
 * ready: the source as for a click, visible, stable, enabled and not covered, and the target visible, stable, in view
 * and not covered at its centre, both in view together. The press is guarded as a click's is; then the mouse moves in
 * `steps` from the source's centre to the target's, and is released there. A press and a move that begin an HTML drag
 * carry it on through drag events, and the drop ends it, with no release, as a person's drop ends one. A target gone
 * by the time of the drop fails `not_actionable`, after the drag is cancelled, or the mouse released where the moves
 * ended, and says so; so does an HTML drop another element covers or takes. Every other failure before the press sends
 * nothing, and one after it leaves no drag held and no button down.
 *
 * @example const result = await dragTo(page, { kind: 'dragTo', locator: card, target: column }, deadline, dispatch)
 */
export async function dragTo(page: DragPage, command: DragCommand, deadline: Deadline, dispatch: Dispatch): Promise<CommandResult> {
  const problem = dragProblem(command) ?? framed(command) ?? (page.touch ? touchRefused(command) : undefined)
  if (problem !== undefined) return { ok: false, failure: problem }
  for (;;) {
    const ready = await bothReady(page, command, deadline)
    if (ready.kind === 'failed') return { ok: false, failure: ready.failure }
    // A navigation the browser began after the looks would take the press into the document it opens, and a document
    // that has gone takes the look with it: the elements are looked for again in the one that came.
    if (page.pendingNavigation() !== undefined || !(await watching(page, ready, deadline))) {
      await disarmGuard(page.world, ready.guard, deadline)
      continue
    }
    return drag(page, command, ready, deadline, dispatch)
  }
}

async function bothReady(page: DragPage, command: DragCommand, deadline: Deadline): Promise<Ready | { kind: 'failed'; failure: Failure }> {
  let last: Unready | undefined
  for (let attempt = 0; ; attempt += 1) {
    const finalRead = deadline.reached
    const looked = await look(page, command, deadline, last)
    if (looked.kind !== 'unready') return looked
    last = looked.unready
    if (last.status === 'timeout' && finalRead) throw last.error
    if (finalRead) return { kind: 'failed', failure: unreadyFailure(last, command, deadline) }
    await waitBeforeRead(deadline, Math.min(firstPauseMs * 2 ** attempt, maxPauseMs))
  }
}

// The target is looked at first, and its guard let go of at once; then the source, whose guard stays armed for the
// press; then the target again, without arming, since bringing the source into view may have moved it.
async function look(page: DragPage, command: DragCommand, deadline: Deadline, last: Unready | undefined): Promise<Look> {
  const pending = page.pendingNavigation()
  if (pending !== undefined) return { kind: 'unready', unready: { status: 'navigating', url: pending.url } }
  const { world } = page
  try {
    const target = await prepare(world, command.target, hover, deadline)
    const targetLook = judged(target.value, 'target', command)
    if (targetLook.kind !== 'ready') return targetLook
    await disarmGuard(world, { context: target.context, token: targetLook.token }, deadline)
    const source = await prepare(world, command.locator, click, deadline)
    const sourceLook = judged(source.value, 'source', command)
    if (sourceLook.kind !== 'ready') return sourceLook
    const guard = { context: source.context, token: sourceLook.token }
    const spot = await readSpot(world, command.target, deadline)
    if (spot.status === 'ready' && spot.covered === null) return { kind: 'ready', from: sourceLook.point, to: spot.point, guard, page: sourceLook.page }
    await disarmGuard(world, guard, deadline)
    return { kind: 'unready', unready: spotUnready(spot) }
  } catch (error) {
    // A look whose time ran out keeps the reason before it, and the drag tries again until its own time is up.
    if (error instanceof CdpTimeoutError) return { kind: 'unready', unready: last ?? { status: 'timeout', error } }
    throw error
  }
}

type Judged = { kind: 'ready'; point: Point; token: number; page: PageFacts } | Exclude<Look, Ready>

function judged(readiness: Readiness, role: Role, command: DragCommand): Judged {
  const locator = role === 'source' ? command.locator : command.target
  switch (readiness.status) {
    case 'ready': {
      const { point, token, page } = readiness
      if (point === null || token === null) throw new Error("Retest's page script readied a drag's element without a point or a guard")
      return { kind: 'ready', point, token, page: pageFactsOf(page) }
    }
    case 'missing':
      return { kind: 'unready', unready: { status: 'missing', role, empty: readiness.empty } }
    case 'blocked':
      return { kind: 'unready', unready: { status: 'blocked', role, check: readiness.check, covering: readiness.check === 'hit-target' ? readiness.detail : null } }
    case 'ambiguous':
      return failedWith({ class: 'ambiguous', message: `${couldNot(command)}: ${describeLocator(locator)} matches ${readiness.count} elements, and a locator must match exactly one. Retest did not drag.`, details: { count: readiness.count, element: role } })
    case 'invalid': {
      const step = locatorSteps(locator)[readiness.step]
      const selector = step === undefined ? describeLocator(locator) : describeStep(step, locator.dialect)
      return failedWith({ class: 'usage', message: `${couldNot(command)}: the page cannot read the CSS selector in ${selector}. ${readiness.message}`, details: { selector } })
    }
    case 'shadow':
      return failedWith({
        class: 'unsupported',
        message: `${couldNot(command)}: the page holds an open shadow root, in ${readiness.host}. Playwright looks inside shadow roots and Retest does not, so Retest refuses the lookup rather than find less than Playwright would.`,
        details: { host: readiness.host },
      })
    case 'moved':
      return failedWith({ class: 'not_actionable', message: `${couldNot(command)}: ${describeLocator(locator)} finds another element than the one Retest was asked to drag, and Retest sent nothing.`, details: { refused: 'moved', inputSent: false } })
    default:
      throw new Error(`Retest's page script answered ${readiness.status} for a drag's ${role}`)
  }
}

function failedWith(failure: Failure): { kind: 'failed'; failure: Failure } {
  return { kind: 'failed', failure }
}

// Read in the document the page holds now, which is the one the press went to unless the drag opened another.
async function readSpot(world: IsolatedWorld, target: LocatorRecipe, deadline: Deadline): Promise<Spot> {
  try {
    return await world.call(spotFunction, locatorArguments(target, []), spotSchema, deadline)
  } catch (error) {
    if (isGoneContext(error)) return { status: 'missing' }
    throw error
  }
}

function spotUnready(spot: Spot): Unready {
  switch (spot.status) {
    case 'ready':
      return { status: 'blocked', role: 'target', check: 'hit-target', covering: spot.covered === 'nothing' ? null : spot.covered }
    case 'missing':
    case 'ambiguous':
      return { status: 'missing', role: 'target', empty: null }
    case 'hidden':
      return { status: 'blocked', role: 'target', check: 'visible', covering: null }
    case 'outside':
      return { status: 'apart' }
  }
}

/**
 * How far a drag's input got, which its end reads to leave the page taking input again: the drag Chrome handed over, if
 * one, whether it ended with a drop or a cancel, whether the button went down and came up, and where the mouse is.
 */
type DragState = { held: DragData | undefined; ended: boolean; pressed: boolean; released: boolean; at: Point }

// How long the end of a drag that failed may take to cancel the drag Chrome holds or release the button, past the
// action's own time, which may be spent: a page busy in its own handlers answers late.
const settleMs = 3000

// Every input of the drag goes once both elements are ready. The press is the guarded part; the moves and the drop
// belong to the page, which may draw anything under the mouse while it drags. Whatever ends the drag, a drag Chrome
// still holds is cancelled and a button still down is released, so the page takes input again.
async function drag(page: DragPage, command: DragCommand, ready: Ready, deadline: Deadline, dispatch: Dispatch): Promise<CommandResult> {
  const { session } = page
  const state: DragState = { held: undefined, ended: false, pressed: false, released: false, at: ready.from }
  const handed = Promise.withResolvers<DragData>()
  const stopListening = session.on('Input.dragIntercepted', (params) => {
    const { data } = readProtocol(interceptedSchema, params, { method: 'Input.dragIntercepted', sessionId: session.id })
    state.held ??= data
    handed.resolve(data)
  })
  try {
    await request(session, 'Input.setInterceptDrags', { enabled: true }, s.object({}), sendOptions(deadline))
    return await page.delivering(async () => {
      const pressed = await press(page, ready, state, deadline, dispatch)
      const refused = pressFailure(pressed, command, ready)
      if (refused !== undefined) {
        if (refused.release) await release(session, state, deadline, dispatch)
        return { ok: false, failure: refused.failure }
      }
      return carry({ page, command, ready, state, deadline, dispatch, handed: handed.promise })
    })
  } finally {
    stopListening()
    await settle(session, state, dispatch)
    await letGo(page, ready.guard.context)
  }
}

// The page's dragstart and drop are listened for in the document the press goes to, before anything is sent there.
async function watching({ world }: DragPage, ready: Ready, deadline: Deadline): Promise<boolean> {
  try {
    return await world.callIn(ready.guard.context, armFunction, [], s.boolean(), deadline)
  } catch (error) {
    if (isGoneContext(error)) return false
    throw error
  }
}

async function press(page: DragPage, ready: Ready, state: DragState, deadline: Deadline, dispatch: Dispatch): Promise<GuardVerdict> {
  const { session, world } = page
  return guardInput(world, ready.guard, deadline, async () => {
    await mouse(session, 'mouseMoved', ready.from, deadline, dispatch, 0)
    state.pressed = true
    await mouse(session, 'mousePressed', ready.from, deadline, dispatch)
    const taken = await world.callIn(ready.guard.context, pressTakenFunction, [ready.guard.token], s.boolean(), deadline)
    if (taken) await release(session, state, deadline, dispatch)
  })
}

/** A press that did not reach the source: the failure, and whether the button still has to be released. */
type PressRefusal = { failure: Failure; release: boolean }

function pressFailure(verdict: GuardVerdict, command: DragCommand, ready: Ready): PressRefusal | undefined {
  const source = describeLocator(command.locator)
  if (verdict.kind === 'unregistered') {
    return { failure: { class: 'not_actionable', message: `${couldNot(command)}: the page moved to a new document before Retest sent input.`, details: { reason: 'the page moved to a new document', inputSent: false } }, release: false }
  }
  if (verdict.kind !== 'seen') {
    const message = `The page moved to a new document while Retest pressed ${source} to drag it, so Retest cannot tell what the press did. Retest released the mouse button there.`
    return { failure: { class: 'outcome_unknown', message, details: { reason: 'the page moved to a new document' } }, release: true }
  }
  const { reached, intercepted, landed } = verdict
  if (intercepted !== null) {
    const message = `${couldNot(command)}: another element, ${intercepted.by}, was on top of ${source} when Retest pressed. Retest stopped the press and its release before the page received them.`
    return { failure: { class: 'not_actionable', message, details: { check: 'hit-target', interceptedBy: intercepted.by, event: intercepted.event } }, release: false }
  }
  if (reached.includes('pointerdown')) return undefined
  const at = `(${Math.round(ready.from.x)}, ${Math.round(ready.from.y)})`
  const message = `Retest pressed the centre of ${source} at ${at} to drag it, but the press never reached the element's document, and ${landed ?? 'no element'} is at that point. Retest released the mouse button there and cannot tell what received the press.`
  return { failure: { class: 'outcome_unknown', message, details: { landed } }, release: true }
}

type Carrying = {
  readonly page: DragPage
  readonly command: DragCommand
  readonly ready: Ready
  readonly state: DragState
  readonly deadline: Deadline
  readonly dispatch: Dispatch
  readonly handed: Promise<DragData>
}

// The moves go to the target's centre as it stands once the press is in, since a page may lay itself out again when an
// item is lifted. A drag is the browser's once Chrome hands it over, and from then on every position is a drag event.
// Chrome tells of it after the move that began it, sometimes after answering that move, so after each move the page is
// asked whether it heard a dragstart it let go on, and then Retest waits for the drag Chrome holds.
async function carry({ page, command, ready, state, deadline, dispatch, handed }: Carrying): Promise<CommandResult> {
  const { session, world } = page
  const context = ready.guard.context
  const afterPress = await readSpot(world, command.target, deadline)
  const to = afterPress.status === 'ready' ? afterPress.point : ready.to
  const steps = command.steps ?? defaultDragSteps
  let entered = false
  let listening = true
  for (let step = 1; step <= steps; step += 1) {
    state.at = between(ready.from, to, step / steps)
    if (entered && state.held !== undefined) {
      await dragEvent(session, 'dragOver', state.at, state.held, deadline, dispatch)
      continue
    }
    await mouse(session, 'mouseMoved', state.at, deadline, dispatch)
    if (state.held === undefined && listening) {
      const started = await world.callIn(context, startedFunction, [], startedSchema, deadline)
      if (started === 'prevented') listening = false
      if (started === 'started') await handedWithin(handed, deadline)
    }
    if (state.held === undefined) continue
    await dragEvent(session, 'dragEnter', state.at, state.held, deadline, dispatch)
    entered = true
  }
  // A drag Chrome handed over after the last move is carried on from where the mouse is.
  if (!entered && state.held !== undefined) await dragEvent(session, 'dragEnter', state.at, state.held, deadline, dispatch)
  return drop({ page, command, state, deadline, dispatch })
}

// Chrome hands over the drag a dragstart began within the move that began it, or soon after it answered that move.
async function handedWithin(handed: Promise<DragData>, deadline: Deadline): Promise<DragData> {
  const command = { method: 'Input.dragIntercepted', sessionId: undefined }
  const waited = Promise.withResolvers<DragData>()
  const timer = setTimeout(() => waited.reject(new CdpTimeoutError(command, { timeoutMs: deadline.budgetMs, written: true })), deadline.remainingMs)
  const stop = (): void => waited.reject(new CdpAbortedError(command, { written: true }))
  deadline.signal?.addEventListener('abort', stop, { once: true })
  handed.then(waited.resolve, waited.reject)
  try {
    return await waited.promise
  } finally {
    clearTimeout(timer)
    deadline.signal?.removeEventListener('abort', stop)
  }
}

type Dropping = {
  readonly page: DragPage
  readonly command: DragCommand
  readonly state: DragState
  readonly deadline: Deadline
  readonly dispatch: Dispatch
}

// The target is read once more before the drop: one the page moved meanwhile gets one more move to its centre, and one
// that left the page gets no drop at all. Drag events go to the element at the point, so a drag whose target another
// element covers by then is cancelled, and a drop the page heard on another element fails. A mouse drag is released
// whatever is at the point, since a page that follows the mouse often draws what it drags there.
async function drop({ page, command, state, deadline, dispatch }: Dropping): Promise<CommandResult> {
  const { session, world } = page
  const spot = await readSpot(world, command.target, deadline)
  const held = state.held
  const through: DragThrough = held === undefined ? 'mouse' : 'drag-events'
  if (spot.status !== 'ready') {
    if (held !== undefined) await cancel(session, state, deadline, dispatch)
    else await release(session, state, deadline, dispatch)
    return { ok: false, failure: targetLeft(command, through, state.at, spot) }
  }
  if (held !== undefined && spot.covered !== null) {
    await cancel(session, state, deadline, dispatch)
    return { ok: false, failure: dropCovered(command, spot.covered) }
  }
  const point = distance(spot.point, state.at) > dropTolerance ? spot.point : state.at
  if (point !== state.at) {
    state.at = point
    if (held !== undefined) await dragEvent(session, 'dragOver', point, held, deadline, dispatch)
    else await mouse(session, 'mouseMoved', point, deadline, dispatch)
  }
  if (held === undefined) {
    await release(session, state, deadline, dispatch)
  } else {
    await dragEvent(session, 'drop', point, held, deadline, dispatch)
    state.ended = true
    const reached = await world.call(droppedFunction, locatorArguments(command.target, []), droppedSchema, deadline)
    if (reached.status === 'elsewhere') return { ok: false, failure: droppedElsewhere(command, reached.by) }
  }
  const facts = await pageFacts(world, deadline)
  return { ok: true, kind: 'dragTo', through, ...(facts === undefined ? {} : { page: facts }) }
}

async function release(session: CdpSession, state: DragState, deadline: Deadline, dispatch: Dispatch): Promise<void> {
  state.released = true
  await mouse(session, 'mouseReleased', state.at, deadline, dispatch)
}

async function cancel(session: CdpSession, state: DragState, deadline: Deadline, dispatch: Dispatch): Promise<void> {
  if (state.held === undefined) return
  state.ended = true
  await dragEvent(session, 'dragCancel', state.at, state.held, deadline, dispatch)
}

// A drag that failed part way, its time spent or an answer lost, leaves Chrome holding the drag, which takes every later
// mouse event of the page, or the button down: the drag is cancelled, as when a person presses Escape, or the button
// released where the mouse is, within a moment of its own. A drop that went is not undone.
async function settle(session: CdpSession, state: DragState, dispatch: Dispatch): Promise<void> {
  const moment = new Deadline(settleMs)
  try {
    if (state.held !== undefined && !state.ended) await cancel(session, state, moment, dispatch)
    else if (state.held === undefined && state.pressed && !state.released) await release(session, state, moment, dispatch)
  } catch {
    // The page has gone, or answers nothing: there is no input of its left to end.
  }
}

// The page the drop left, as every action names the page it went to; a page too busy to answer keeps none.
async function pageFacts(world: IsolatedWorld, deadline: Deadline): Promise<PageFacts | undefined> {
  try {
    return pageFactsOf(await world.call(pageFactsFunction, [], documentFactsSchema, deadline))
  } catch (error) {
    if (error instanceof CdpTimeoutError || isGoneContext(error)) return undefined
    throw error
  }
}

// Nothing of this is input: the page's listener and Chrome's hand-over end with the drag, however it ended. They are
// let go of within a moment of their own, since the drag's time may be spent.
async function letGo(page: DragPage, context: number): Promise<void> {
  const moment = new Deadline(1000)
  await request(page.session, 'Input.setInterceptDrags', { enabled: false }, s.object({}), sendOptions(moment)).catch(() => undefined)
  await page.world.callIn(context, disarmFunction, [], s.boolean(), moment).catch(() => undefined)
}

async function mouse(session: CdpSession, type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', point: Point, deadline: Deadline, dispatch: Dispatch, buttons = type === 'mouseReleased' ? 0 : 1): Promise<void> {
  const pressing = type === 'mouseMoved' ? {} : { clickCount: 1 }
  const button = type === 'mouseMoved' && buttons === 0 ? 'none' : 'left'
  await dispatch.send(session, 'Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button, buttons, ...pressing }, deadline)
}

async function dragEvent(session: CdpSession, type: 'dragEnter' | 'dragOver' | 'drop' | 'dragCancel', point: Point, data: DragData, deadline: Deadline, dispatch: Dispatch): Promise<void> {
  await dispatch.send(session, 'Input.dispatchDragEvent', { type, x: point.x, y: point.y, data }, deadline)
}

/**
 * The position `fraction` of the way from `from` to `to`, on the straight line between them.
 *
 * @example between({ x: 0, y: 0 }, { x: 100, y: 50 }, 0.2) // { x: 20, y: 10 }
 */
export function between(from: Point, to: Point, fraction: number): Point {
  return { x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction }
}

function distance(first: Point, second: Point): number {
  return Math.hypot(first.x - second.x, first.y - second.y)
}

function couldNot(command: DragCommand): string {
  return `Could not drag ${describeLocator(command.locator)} to ${describeLocator(command.target)}`
}

const checkWords: Readonly<Record<Check, string>> = {
  attached: 'was removed from the page while Retest checked it',
  visible: 'is not visible',
  enabled: 'is disabled',
  editable: 'is read-only',
  stable: 'kept moving',
  'in-view': 'stays outside the viewport after scrolling',
  'hit-target': 'has no element at its centre',
  focused: 'did not keep the keyboard focus',
}

function unreadyFailure(last: Unready, command: DragCommand, deadline: Deadline): Failure {
  const waitedMs = deadline.budgetMs
  switch (last.status) {
    case 'timeout':
      throw last.error
    case 'missing': {
      const locator = last.role === 'source' ? command.locator : command.target
      const step = last.empty === null ? undefined : describeEmptyStep(locator, last.empty)
      const message = `${couldNot(command)}: no element matched ${describeLocator(locator)} within ${waitedMs} ms.${step === undefined ? '' : ` ${step}`}`
      return { class: 'not_found', message, details: { element: last.role, waitedMs } }
    }
    case 'blocked': {
      const locator = describeLocator(last.role === 'source' ? command.locator : command.target)
      const reason = last.covering === null ? `${locator} ${checkWords[last.check]}` : `another element, ${last.covering}, covers the centre of ${locator}`
      return { class: 'not_actionable', message: `${couldNot(command)} within ${waitedMs} ms: ${reason}.`, details: { element: last.role, check: last.check, covering: last.covering, waitedMs } }
    }
    case 'apart':
      return {
        class: 'not_actionable',
        message: `${couldNot(command)} within ${waitedMs} ms: the two do not fit in the viewport together, and Retest does not scroll while it drags.`,
        details: { element: 'target', check: 'in-view', waitedMs },
      }
    case 'navigating': {
      const parsed = URL.parse(last.url)
      const opening = parsed === null ? last.url : originAndPath(parsed)
      return {
        class: 'not_actionable',
        message: `${couldNot(command)} within ${waitedMs} ms: the page was still opening ${opening}, and Retest does not drag in a document about to be replaced.`,
        details: { check: 'navigation', url: opening, waitedMs },
      }
    }
  }
}

function targetLeft(command: DragCommand, through: DragThrough, at: Point, spot: Spot): Failure {
  const target = describeLocator(command.target)
  const gone =
    spot.status === 'hidden'
      ? `${target} was hidden`
      : spot.status === 'outside'
        ? `${target} moved out of the viewport`
        : spot.status === 'ambiguous'
          ? `${target} came to match ${spot.count} elements`
          : `${target} left the page`
  const ending =
    through === 'drag-events'
      ? 'Retest cancelled the drag, so nothing was dropped.'
      : `Retest released the mouse where the moves ended, at (${Math.round(at.x)}, ${Math.round(at.y)}), and the page may have taken that as a drop.`
  return { class: 'not_actionable', message: `${couldNot(command)}: ${gone} while Retest dragged. ${ending}`, details: { element: 'target', check: 'attached', through, inputSent: true } }
}

function dropCovered(command: DragCommand, covered: string): Failure {
  const target = describeLocator(command.target)
  const what = covered === 'nothing' ? `no element was at the centre of ${target}` : `another element, ${covered}, covered the centre of ${target}`
  return {
    class: 'not_actionable',
    message: `${couldNot(command)}: ${what} when Retest was to drop. Retest cancelled the drag, so nothing was dropped.`,
    details: { element: 'target', check: 'hit-target', covering: covered === 'nothing' ? null : covered, through: 'drag-events', inputSent: true },
  }
}

function droppedElsewhere(command: DragCommand, by: string): Failure {
  return {
    class: 'not_actionable',
    message: `${couldNot(command)}: the drop went to another element, ${by}, which the page heard in its place.`,
    details: { element: 'target', check: 'hit-target', droppedOn: by, through: 'drag-events', inputSent: true },
  }
}

// A frame's element is reached through a world of its own, and a drag moves through the page's own document only.
function framed(command: DragCommand): Failure | undefined {
  const inFrame = [command.locator, command.target].find((locator) => locator.frame !== undefined && locator.frame.length > 0)
  if (inFrame === undefined) return undefined
  return { class: 'unsupported', message: `${couldNot(command)}: ${describeLocator(inFrame)} is inside a frame, and dragTo() drags between elements of the page itself.`, details: { inputSent: false } }
}

function touchRefused(command: DragCommand): Failure {
  return { class: 'unsupported', message: `${couldNot(command)}: the page emulates a touch screen, and dragTo() drags with the mouse.`, details: { inputSent: false } }
}

/**
 * The failure an engine without drag and drop gives `dragTo()`, naming the engine. Nothing is sent.
 *
 * @example dragRefused('Firefox').message // 'dragTo() is not available on Firefox yet. Retest drags on Chrome, Chromium, Edge and Electron.'
 */
export function dragRefused(engine: string): Failure {
  return { class: 'unsupported', message: `dragTo() is not available on ${engine} yet. Retest drags on Chrome, Chromium, Edge and Electron.`, details: { inputSent: false } }
}
