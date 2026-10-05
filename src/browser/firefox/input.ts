import type { CdpSession } from '../cdp/session.ts'
import type { Dispatch } from '../dispatch.ts'
import type { SelectPlan } from '../element-queries.ts'
import type { Deadline } from '../../protocol/deadline.ts'
import type { Key, ModifierName, NamedKey } from '../../protocol/keys.ts'
import { keyStroke } from '../keys.ts'

// Real input through WebDriver BiDi: each action is one `input.performActions` sequence, which Firefox dispatches as
// trusted events and answers once, after the last of them. It goes through the command's `Dispatch` like Chromium's
// input, so a sequence that may have gone is counted, and never sent again.

/** A point in the viewport, in CSS pixels. */
export type Point = { x: number; y: number }

const mouse = { type: 'pointer', id: 'retest-mouse', parameters: { pointerType: 'mouse' } } as const
const wheel = { type: 'wheel', id: 'retest-wheel' } as const
const keyboard = { type: 'key', id: 'retest-keyboard' } as const

// The key values WebDriver reserves for named keys, in the Private Use Area Firefox reads them from.
const namedKeyValues: Readonly<Record<NamedKey, string>> = {
  Enter: '',
  Tab: '',
  Escape: '',
  Backspace: '',
  Delete: '',
  Space: ' ',
  ArrowUp: '',
  ArrowDown: '',
  ArrowLeft: '',
  ArrowRight: '',
  Home: '',
  End: '',
  PageUp: '',
  PageDown: '',
}

const modifierValues: Readonly<Record<Exclude<ModifierName, 'ControlOrMeta'>, string>> = {
  Shift: '',
  Control: '',
  Alt: '',
  Meta: '',
}

// Firefox reads these code points in a key action as named keys, so text holding one cannot be typed as text.
const reservedKeyValues = /[-]/

/**
 * Firefox's input actions take whole pixels: the point an element was checked at, rounded. The input guard watches the
 * element that rounded point reaches, so a point that lands off a sub-pixel element is stopped, never sent elsewhere.
 *
 * @example wholePoint({ x: 100.5, y: 300.25 }) // { x: 101, y: 300 }
 */
export function wholePoint(point: Point): Point {
  return { x: Math.round(point.x), y: Math.round(point.y) }
}

/** Moves the mouse to the point, then presses and releases the left button there. The move is input too. */
export async function clickAt(session: CdpSession, context: string, point: Point, deadline: Deadline, dispatch: Dispatch): Promise<void> {
  const { x, y } = wholePoint(point)
  const actions = [{ type: 'pointerMove', x, y, origin: 'viewport' }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }]
  await perform(session, context, [{ ...mouse, actions }], deadline, dispatch)
}

let hovers = 0

/**
 * Moves the mouse to the point, as a person's hand on the mouse does before anything else. Firefox sends nothing for a
 * move to where its pointer already is, so each hover moves a pointer of its own, which arrives at the point from
 * nowhere: the page hears the mouse arrive, as Chromium's move to the same point lets it hear.
 */
export async function moveTo(session: CdpSession, context: string, point: Point, deadline: Deadline, dispatch: Dispatch): Promise<void> {
  const { x, y } = wholePoint(point)
  hovers += 1
  await perform(session, context, [{ ...mouse, id: `retest-hover-${hovers}`, actions: [{ type: 'pointerMove', x, y, origin: 'viewport' }] }], deadline, dispatch)
}

/**
 * Turns the mouse wheel once at the point, by `delta` in whole CSS pixels. Firefox scrolls whatever scrolls under the
 * point, as it does for a person's wheel, and at most one page of it for one turn of the wheel.
 */
export async function wheelAt(session: CdpSession, context: string, point: Point, delta: Point, deadline: Deadline, dispatch: Dispatch): Promise<void> {
  const { x, y } = wholePoint(point)
  const actions = [{ type: 'scroll', x, y, deltaX: Math.round(delta.x), deltaY: Math.round(delta.y), origin: 'viewport' }]
  await perform(session, context, [{ ...wheel, actions }], deadline, dispatch)
}

/**
 * Presses and releases a key, which goes to whatever holds the keyboard focus: the modifiers it is pressed with go
 * down first and come up last.
 */
export async function pressKey(session: CdpSession, context: string, key: Key, deadline: Deadline, dispatch: Dispatch): Promise<void> {
  await perform(session, context, [{ ...keyboard, actions: keyActions(key) }], deadline, dispatch)
}

/**
 * The key actions of one press: each modifier down in the order written, the key down and up, then the modifiers up
 * in reverse. `ControlOrMeta` is Meta on macOS and Control elsewhere. A character is typed as itself, with Shift held
 * when a person's US keyboard needs it, an uppercase letter or a shifted symbol: Firefox's key action sets no modifier
 * of its own, so Shift is pressed as a person presses it, and the page hears its key go down and up.
 *
 * @example keyActions({ kind: 'named', name: 'Tab', held: ['Shift'] }).length // 4
 */
export function keyActions(key: Key, platform: NodeJS.Platform = process.platform): { type: 'keyDown' | 'keyUp'; value: string }[] {
  const named = key.held.map((name) => (name === 'ControlOrMeta' ? (platform === 'darwin' ? 'Meta' : 'Control') : name))
  const shifted = key.kind === 'character' && !named.includes('Shift') && typedWithShift(key)
  const held = [...named, ...(shifted ? ['Shift' as const] : [])].map((name) => modifierValues[name])
  const value = key.kind === 'named' ? namedKeyValues[key.name] : key.character
  return [
    ...held.map((each) => ({ type: 'keyDown' as const, value: each })),
    { type: 'keyDown', value },
    { type: 'keyUp', value },
    ...held.reverse().map((each) => ({ type: 'keyUp' as const, value: each })),
  ]
}

/**
 * The keys that type `text`, one press for each character a person sees, a line break as Enter, and Shift held for
 * the characters a US keyboard types with it. An empty text is a press of Delete, which clears a selected value as
 * typing over it would.
 *
 * @example typedKeys('a\nB').length // 8
 */
export function typedKeys(text: string): { type: 'keyDown' | 'keyUp'; value: string }[] {
  if (text === '') return keyActions({ kind: 'named', name: 'Delete', held: [] })
  const segments = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].map(({ segment }) => segment)
  return segments.flatMap((segment) => {
    if (segment === '\r\n' || segment === '\n' || segment === '\r') return keyActions({ kind: 'named', name: 'Enter', held: [] })
    return keyActions({ kind: 'character', character: segment, shift: asciiUppercase.test(segment), held: [] })
  })
}

const asciiUppercase = /^[A-Z]$/

// Whether a US keyboard types the character with Shift, as Chromium's key events say through their modifiers.
function typedWithShift(key: Extract<Key, { kind: 'character' }>): boolean {
  return (keyStroke(key).down.modifiers & shiftModifier) !== 0
}

const shiftModifier = 8

/** How many keys typing `text` presses, each released once: what the input guard counts to know the typing is over. */
export function typedStrokes(text: string): number {
  return releases(typedKeys(text))
}

/**
 * How many keys one press holds and presses, each released once, Shift among them when Retest holds it for a shifted
 * character: what the input guard counts to know the press is over.
 *
 * @example pressedStrokes({ kind: 'character', character: '!', shift: false, held: [] }) // 2
 */
export function pressedStrokes(key: Key): number {
  return releases(keyActions(key))
}

function releases(actions: readonly { type: 'keyDown' | 'keyUp' }[]): number {
  return actions.filter((action) => action.type === 'keyUp').length
}

/**
 * Why Firefox cannot type `text` as text, or undefined when it can: it reads the code points WebDriver reserves for
 * named keys as those keys.
 *
 * @example typingProblem('ab') // 'it holds U+E007, which Firefox reads as a named key'
 */
export function typingProblem(text: string): string | undefined {
  const reserved = reservedKeyValues.exec(text)?.[0]
  if (reserved === undefined) return undefined
  return `it holds U+${reserved.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0')}, which Firefox reads as a named key`
}

/** A native list's focused option is not exposed by BiDi, so a missed move cannot be checked before a toggle. */
export function selectionProblem(plan: SelectPlan): string | undefined {
  return plan.keys.some((planned) => planned.toggle)
    ? 'Firefox cannot verify the native option holding keyboard focus before toggling it. A move can leave that focus unchanged, so Retest refuses multiple-select keyboard input before an unrequested option could be selected.'
    : undefined
}

/** Types `text` into whatever holds the keyboard focus, as one sequence of key presses. */
export async function typeText(session: CdpSession, context: string, text: string, deadline: Deadline, dispatch: Dispatch): Promise<void> {
  await perform(session, context, [{ ...keyboard, actions: typedKeys(text) }], deadline, dispatch)
}

async function perform(session: CdpSession, context: string, actions: readonly object[], deadline: Deadline, dispatch: Dispatch): Promise<void> {
  await dispatch.send(session, 'input.performActions', { context, actions }, deadline)
}
