import type { Key, NamedKey } from '../protocol/keys.ts'

/** The parameters of one `Input.dispatchKeyEvent`. */
export type KeyEvent = {
  type: 'keyDown' | 'rawKeyDown' | 'keyUp'
  key: string
  code: string
  windowsVirtualKeyCode: number
  modifiers: number
  text?: string
  unmodifiedText?: string
  commands?: string[]
}

/** A key's press and release, as a person's keyboard sends them. */
export type KeyStroke = { down: KeyEvent; up: KeyEvent }

type KeyDefinition = { key: string; code: string; keyCode: number; text?: string; shift?: boolean }

// A key that types sends its text with the key down; any other is a raw key down, which types nothing.
const namedKeys: Readonly<Record<NamedKey, KeyDefinition>> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
}

// macOS's standard key bindings, which a headed browser there edits text by, alone and with Shift. Bindings that
// insert text are left out: with one, Chrome treats the key down as handled and the page hears no keypress.
const macCommands: Readonly<Partial<Record<NamedKey, readonly [plain: string, shifted: string]>>> = {
  Backspace: ['deleteBackward', 'deleteBackward'],
  Delete: ['deleteForward', 'deleteForward'],
  ArrowUp: ['moveUp', 'moveUpAndModifySelection'],
  ArrowDown: ['moveDown', 'moveDownAndModifySelection'],
  ArrowLeft: ['moveLeft', 'moveLeftAndModifySelection'],
  ArrowRight: ['moveRight', 'moveRightAndModifySelection'],
  Home: ['scrollToBeginningOfDocument', 'moveToBeginningOfDocumentAndModifySelection'],
  End: ['scrollToEndOfDocument', 'moveToEndOfDocumentAndModifySelection'],
  PageUp: ['scrollPageUp', 'pageUpAndModifySelection'],
  PageDown: ['scrollPageDown', 'pageDownAndModifySelection'],
}

// The US layout's symbol keys: each key's code and virtual key code, then the character it types alone and with Shift.
const symbolKeys: readonly [code: string, keyCode: number, plain: string, shifted: string][] = [
  ['Backquote', 192, '`', '~'],
  ['Digit1', 49, '1', '!'],
  ['Digit2', 50, '2', '@'],
  ['Digit3', 51, '3', '#'],
  ['Digit4', 52, '4', '$'],
  ['Digit5', 53, '5', '%'],
  ['Digit6', 54, '6', '^'],
  ['Digit7', 55, '7', '&'],
  ['Digit8', 56, '8', '*'],
  ['Digit9', 57, '9', '('],
  ['Digit0', 48, '0', ')'],
  ['Minus', 189, '-', '_'],
  ['Equal', 187, '=', '+'],
  ['BracketLeft', 219, '[', '{'],
  ['BracketRight', 221, ']', '}'],
  ['Backslash', 220, '\\', '|'],
  ['Semicolon', 186, ';', ':'],
  ['Quote', 222, "'", '"'],
  ['Comma', 188, ',', '<'],
  ['Period', 190, '.', '>'],
  ['Slash', 191, '/', '?'],
]

const usCharacters: ReadonlyMap<string, KeyDefinition> = new Map(
  symbolKeys.flatMap(([code, keyCode, plain, shifted]): [string, KeyDefinition][] => [
    [plain, { key: plain, code, keyCode, text: plain }],
    [shifted, { key: shifted, code, keyCode, text: shifted, shift: true }],
  ]),
)

const shiftModifier = 8
const asciiLetter = /^[a-z]$/i

/**
 * The key events for a key, as a person presses it on a US keyboard. An uppercase letter, and a symbol typed
 * with Shift, carry Shift. A character no US key types, such as `é`, is sent as its text with no key code.
 * On macOS the key down carries the editing command a headed browser needs.
 *
 * @example keyStroke({ kind: 'named', name: 'Tab', shift: true }, 'linux').down // { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 }
 */
export function keyStroke(key: Key, platform: NodeJS.Platform = process.platform): KeyStroke {
  const definition = key.kind === 'named' ? namedKeys[key.name] : characterKey(key.character)
  const shift = key.shift || definition.shift === true
  const base = { key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.keyCode, modifiers: shift ? shiftModifier : 0 }
  const binding = key.kind === 'named' && platform === 'darwin' ? macCommands[key.name] : undefined
  const commands = binding === undefined ? {} : { commands: [shift ? binding[1] : binding[0]] }
  const { text } = definition
  const down: KeyEvent = text === undefined ? { type: 'rawKeyDown', ...base, ...commands } : { type: 'keyDown', ...base, text, unmodifiedText: text, ...commands }
  return { down, up: { type: 'keyUp', ...base } }
}

function characterKey(character: string): KeyDefinition {
  if (asciiLetter.test(character)) {
    const upper = character.toUpperCase()
    return { key: character, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: character }
  }
  return usCharacters.get(character) ?? { key: character, code: '', keyCode: 0, text: character }
}
