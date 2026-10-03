import type { Key, ModifierName, NamedKey } from '../protocol/keys.ts'

/** The parameters of one `Input.dispatchKeyEvent`. */
export type KeyEvent = {
  type: 'keyDown' | 'rawKeyDown' | 'keyUp'
  key: string
  code: string
  windowsVirtualKeyCode: number
  modifiers: number
  location?: number
  text?: string
  unmodifiedText?: string
  commands?: string[]
}

/**
 * A key's press and release, as a person's keyboard sends them: the modifiers going down in order, the key down and
 * up with every modifier held, and the modifiers coming back up in the reverse order.
 */
export type KeyStroke = { held: KeyEvent[]; down: KeyEvent; up: KeyEvent; released: KeyEvent[] }

type KeyDefinition = { key: string; code: string; keyCode: number; text?: string; shift?: boolean }

type Modifier = Exclude<ModifierName, 'ControlOrMeta'>

// Each modifier's left key, and its bit in a key event's `modifiers`.
const modifierKeys: Readonly<Record<Modifier, { key: string; code: string; keyCode: number; bit: number }>> = {
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18, bit: 1 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17, bit: 2 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91, bit: 4 },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, bit: 8 },
}

const leftKey = 1
// A shortcut with any of these types nothing.
const shortcutModifiers: readonly Modifier[] = ['Control', 'Alt', 'Meta']
// The order chords are written in the table of macOS commands below.
const chordOrder: readonly Modifier[] = ['Control', 'Alt', 'Meta', 'Shift']

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
// insert text are left out: with one, Chrome treats the key down as handled and the page hears no keypress. Chrome on
// macOS edits only by these commands, which the window system would otherwise give it, so a key event carries them.
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

// macOS's standard bindings for the editing shortcuts Retest sends, by their modifiers in `chordOrder` and their key,
// a letter in lower case. A shortcut not listed reaches the page's own listeners, and Chrome edits nothing for it.
const macChords: Readonly<Record<string, string>> = {
  'Meta+a': 'selectAll',
  'Meta+z': 'undo',
  'Meta+Shift+z': 'redo',
  'Meta+ArrowLeft': 'moveToBeginningOfLine',
  'Meta+Shift+ArrowLeft': 'moveToBeginningOfLineAndModifySelection',
  'Meta+ArrowRight': 'moveToEndOfLine',
  'Meta+Shift+ArrowRight': 'moveToEndOfLineAndModifySelection',
  'Meta+ArrowUp': 'moveToBeginningOfDocument',
  'Meta+Shift+ArrowUp': 'moveToBeginningOfDocumentAndModifySelection',
  'Meta+ArrowDown': 'moveToEndOfDocument',
  'Meta+Shift+ArrowDown': 'moveToEndOfDocumentAndModifySelection',
  'Meta+Backspace': 'deleteToBeginningOfLine',
  'Alt+ArrowLeft': 'moveWordLeft',
  'Alt+Shift+ArrowLeft': 'moveWordLeftAndModifySelection',
  'Alt+ArrowRight': 'moveWordRight',
  'Alt+Shift+ArrowRight': 'moveWordRightAndModifySelection',
  'Alt+Backspace': 'deleteWordBackward',
  'Alt+Delete': 'deleteWordForward',
}

const usCharacters: ReadonlyMap<string, KeyDefinition> = new Map(
  symbolKeys.flatMap(([code, keyCode, plain, shifted]): [string, KeyDefinition][] => [
    [plain, { key: plain, code, keyCode, text: plain }],
    [shifted, { key: shifted, code, keyCode, text: shifted, shift: true }],
  ]),
)

const asciiLetter = /^[a-z]$/i

/**
 * The key events for a key, as a person presses it on a US keyboard. Each modifier the test named goes down before
 * the key and comes up after it, and the key carries every modifier held. An uppercase letter, and a symbol typed
 * with Shift, carry Shift with no Shift key of their own. A character no US key types, such as `é`, is sent as its
 * text with no key code. A shortcut with Control, Alt or Meta types nothing. On macOS the key down carries the editing
 * command a headed browser needs, alone, with Shift, or for the shortcuts in Retest's table.
 *
 * @example keyStroke({ kind: 'named', name: 'Tab', held: ['Shift'] }, 'linux').down // { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 }
 */
export function keyStroke(key: Key, platform: NodeJS.Platform = process.platform): KeyStroke {
  const held = key.held.map((name): Modifier => (name === 'ControlOrMeta' ? (platform === 'darwin' ? 'Meta' : 'Control') : name))
  const definition = key.kind === 'named' ? namedKeys[key.name] : characterKey(key.character, held.includes('Shift'))
  const mask = held.reduce((bits, modifier) => bits | modifierKeys[modifier].bit, (key.kind === 'character' && key.shift) || definition.shift === true ? modifierKeys.Shift.bit : 0)
  const base = { key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.keyCode, modifiers: mask }
  const commands = macCommandsFor(key, held, platform)
  const shortcut = held.some((modifier) => shortcutModifiers.includes(modifier))
  const text = shortcut ? undefined : definition.text
  const down: KeyEvent = text === undefined ? { type: 'rawKeyDown', ...base, ...commands } : { type: 'keyDown', ...base, text, unmodifiedText: text, ...commands }
  return { held: modifierEvents(held, 'down'), down, up: { type: 'keyUp', ...base }, released: modifierEvents(held, 'up') }
}

// Each modifier's own event carries the modifiers held at that moment: its own among them going down, not coming up.
function modifierEvents(held: readonly Modifier[], direction: 'down' | 'up'): KeyEvent[] {
  const events = held.map((modifier, index) => {
    const { key, code, keyCode, bit } = modifierKeys[modifier]
    const before = held.slice(0, index).reduce((bits, each) => bits | modifierKeys[each].bit, 0)
    const event: KeyEvent = { type: direction === 'down' ? 'rawKeyDown' : 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers: direction === 'down' ? before | bit : before, location: leftKey }
    return event
  })
  return direction === 'down' ? events : events.reverse()
}

function macCommandsFor(key: Key, held: readonly Modifier[], platform: NodeJS.Platform): { commands?: string[] } {
  if (platform !== 'darwin') return {}
  const shortcut = held.some((modifier) => shortcutModifiers.includes(modifier))
  if (!shortcut) {
    const binding = key.kind === 'named' ? macCommands[key.name] : undefined
    return binding === undefined ? {} : { commands: [held.includes('Shift') ? binding[1] : binding[0]] }
  }
  const written = chordOrder.filter((modifier) => held.includes(modifier))
  const name = key.kind === 'named' ? key.name : key.character
  const command = macChords[[...written, name].join('+')]
  return command === undefined ? {} : { commands: [command] }
}

function characterKey(character: string, shifted: boolean): KeyDefinition {
  if (asciiLetter.test(character)) {
    const upper = character.toUpperCase()
    const typed = shifted ? upper : character
    return { key: typed, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: typed }
  }
  return usCharacters.get(character) ?? { key: character, code: '', keyCode: 0, text: character }
}
