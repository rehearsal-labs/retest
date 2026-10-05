import { s } from '../../protocol/schema.ts'
import { readProtocol } from '../cdp-results.ts'

// The shared input code (`input.ts`, `keys.ts`) speaks CDP's `Input` domain. WebKit's input goes to the page proxy, in
// whole CSS pixels, with its own event names and modifier bits, and its text goes to the page target. These
// functions turn one into the other; anything WebKit cannot take is refused by name.

/** A command for WebKit: where it goes, its method and its parameters. */
export type WebKitInput = { readonly to: 'page proxy' | 'target'; readonly method: string; readonly params: Record<string, unknown> }

// CDP's bits are Alt 1, Control 2, Meta 4, Shift 8. The build's protocol.json documents the same, but the build sets
// shiftKey for 1, ctrlKey for 2, altKey for 4 and metaKey for 8, on key and mouse events alike, as the Phase 1 proof
// observed bit by bit; the driver follows what the build does, and a test holds it to that.
const modifierBits: readonly (readonly [cdp: number, webkit: number])[] = [
  [1, 4],
  [2, 2],
  [4, 8],
  [8, 1],
]

const mouseTypes: Readonly<Record<string, string>> = { mouseMoved: 'move', mousePressed: 'down', mouseReleased: 'up' }

const mouseSchema = s.object({
  type: s.string(),
  x: s.number(),
  y: s.number(),
  button: s.optional(s.string()),
  buttons: s.optional(s.number({ integer: true })),
  clickCount: s.optional(s.number({ integer: true })),
  modifiers: s.optional(s.number({ integer: true })),
  deltaX: s.optional(s.number()),
  deltaY: s.optional(s.number()),
})

const keySchema = s.object({
  type: s.enum(['keyDown', 'rawKeyDown', 'keyUp']),
  key: s.string(),
  code: s.string(),
  windowsVirtualKeyCode: s.number({ integer: true }),
  modifiers: s.number({ integer: true }),
  text: s.optional(s.string()),
  unmodifiedText: s.optional(s.string()),
  commands: s.optional(s.array(s.string())),
})

const textSchema = s.object({ text: s.string() })

// The macOS commands the shared key table names that WebKit carries out other than Chrome does with them: in a field,
// Chrome moves the caret to the start or the end for Home and End, and WebKit, following macOS, only scrolls the
// document. The driver sends WebKit the commands that move the caret, so the keys edit a field alike on both engines.
const commandsAsChrome: Readonly<Record<string, string>> = {
  scrollToBeginningOfDocument: 'moveToBeginningOfDocument',
  scrollToEndOfDocument: 'moveToEndOfDocument',
}

/**
 * WebKit's modifier bits for CDP's.
 *
 * @example webKitModifiers(8) // 1, Shift
 */
export function webKitModifiers(cdp: number): number {
  return modifierBits.reduce((bits, [from, to]) => ((cdp & from) === 0 ? bits : bits | to), 0)
}

/**
 * A CDP mouse event as WebKit takes it: a move, press or release on the page proxy at whole pixels, or the wheel as
 * `Input.dispatchWheelEvent`. A point is rounded down, so the centre of an element at least a pixel wide stays on it.
 *
 * @example mouseInput({ type: 'mousePressed', x: 10.5, y: 20.25, button: 'left', buttons: 1, clickCount: 1 }).params // { type: 'down', x: 10, y: 20, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 }
 */
export function mouseInput(params: unknown): WebKitInput {
  const event = readProtocol(mouseSchema, params, { method: 'Input.dispatchMouseEvent' })
  const point = { x: Math.floor(event.x), y: Math.floor(event.y) }
  const modifiers = webKitModifiers(event.modifiers ?? 0)
  if (event.type === 'mouseWheel') {
    const delta = { deltaX: Math.round(event.deltaX ?? 0), deltaY: Math.round(event.deltaY ?? 0) }
    return { to: 'page proxy', method: 'Input.dispatchWheelEvent', params: { ...point, ...delta, modifiers } }
  }
  const type = mouseTypes[event.type]
  if (type === undefined) throw new RangeError(`WebKit has no mouse event for CDP's ${event.type}`)
  const press = event.clickCount === undefined ? {} : { clickCount: event.clickCount }
  return { to: 'page proxy', method: 'Input.dispatchMouseEvent', params: { type, ...point, button: event.button ?? 'none', buttons: event.buttons ?? 0, ...press, modifiers } }
}

/**
 * A CDP key event as WebKit takes it on the page proxy. A raw key down is a key down with no text, as it is for
 * Chromium. The macOS editing commands go as WebKit names them, as selectors with their colon: a name without one
 * reaches no editing command, and Backspace then goes back in the history instead of deleting.
 *
 * @example keyInput({ type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, modifiers: 0, commands: ['deleteBackward'] }).params.macCommands // ['deleteBackward:']
 */
export function keyInput(params: unknown): WebKitInput {
  const event = readProtocol(keySchema, params, { method: 'Input.dispatchKeyEvent' })
  const down = event.type !== 'keyUp'
  const text = down && event.type === 'keyDown' && event.text !== undefined ? { text: event.text, unmodifiedText: event.unmodifiedText ?? event.text } : {}
  const commands = down ? macCommands(event.key, event.text, event.commands) : {}
  return {
    to: 'page proxy',
    method: 'Input.dispatchKeyEvent',
    params: { type: down ? 'keyDown' : 'keyUp', key: event.key, code: event.code, windowsVirtualKeyCode: event.windowsVirtualKeyCode, modifiers: webKitModifiers(event.modifiers), ...text, ...commands },
  }
}

// Return in a field is the command that ends a line, which in a one-line field WebKit leaves to the form, as a person's
// Return does; without it WebKit types the key's text and the form is never submitted.
function macCommands(key: string, text: string | undefined, commands: readonly string[] | undefined): { macCommands?: string[] } {
  const named = commands !== undefined && commands.length > 0 ? commands : key === 'Enter' && text === '\r' ? ['insertNewline'] : []
  return named.length === 0 ? {} : { macCommands: named.map((command) => `${commandsAsChrome[command] ?? command}:`) }
}

/**
 * CDP's `Input.insertText` as WebKit takes it: `Page.insertText` on the page target, which types into the focused field
 * with trusted `beforeinput` and `input` events, as the CDP command does.
 *
 * @example textInput({ text: 'hi' }) // { to: 'target', method: 'Page.insertText', params: { text: 'hi' } }
 */
export function textInput(params: unknown): WebKitInput {
  const { text } = readProtocol(textSchema, params, { method: 'Input.insertText' })
  return { to: 'target', method: 'Page.insertText', params: { text } }
}
