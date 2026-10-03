import type { Failure } from './failures.ts'
import { quoteText } from './text.ts'

/** The keys `press` takes by name. */
export const namedKeys = [
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
] as const

export type NamedKey = (typeof namedKeys)[number]

/** The modifiers a key can be pressed with. `ControlOrMeta` is Meta on macOS and Control elsewhere. */
export const modifierNames = ['Shift', 'Control', 'Alt', 'Meta', 'ControlOrMeta'] as const

export type ModifierName = (typeof modifierNames)[number]

/**
 * A key as `press` sends it: a named key, or the one character a key types. `held` are the modifiers pressed before
 * it and released after it, in the order the test wrote them. A character's `shift` types it with Shift and no Shift
 * key of its own, as an uppercase letter is typed.
 */
export type Key =
  | { kind: 'named'; name: NamedKey; held: ModifierName[] }
  | { kind: 'character'; character: string; shift: boolean; held: ModifierName[] }

export type ParsedKey = { ok: true; key: Key } | { ok: false; failure: Failure }

// One UTF-16 code unit that types something: a letter, a digit, punctuation or a symbol.
const character = /^[\p{L}\p{N}\p{P}\p{S}]$/u
const uppercaseLetter = /^\p{Lu}$/u
const letter = /^\p{L}$/u
// Control and Meta are one key each, and ControlOrMeta is one of them, so it stands with neither.
const overlapping: readonly ModifierName[] = ['Control', 'Meta']

const keyForms = `a named key (${namedKeys.slice(0, -1).join(', ')} or ${namedKeys.at(-1)}), one character, such as a, 7 or é, or modifiers and a key, such as Control+A, Shift+Tab or Meta+Shift+Z`
const modifierForms = `Shift, Control, Alt, Meta or ControlOrMeta`

/**
 * Reads the key `press` was given. Anything it does not take is `usage`, and the message says what it takes.
 *
 * @example parseKey('Control+Shift+T') // { ok: true, key: { kind: 'character', character: 't', shift: false, held: ['Control', 'Shift'] } }
 */
export function parseKey(text: string): ParsedKey {
  const named = namedKey(text)
  if (named !== undefined) return { ok: true, key: { kind: 'named', name: named, held: [] } }
  if (text.length === 1 && character.test(text)) {
    return { ok: true, key: { kind: 'character', character: text, shift: uppercaseLetter.test(text), held: [] } }
  }
  const split = splitChord(text)
  if (split === undefined) return refused(`press() takes ${keyForms}, received ${quoteText(text)}.`)
  return chord(text, split)
}

type Chord = { modifiers: string[]; key: string }

// `Control++` presses the plus key; any other `+` separates a modifier from what follows it.
function splitChord(text: string): Chord | undefined {
  if (text.endsWith('++') && text.length > 2) return { modifiers: text.slice(0, -2).split('+'), key: '+' }
  const parts = text.split('+')
  const key = parts.pop()
  return key === undefined || parts.length === 0 ? undefined : { modifiers: parts, key }
}

function chord(text: string, { modifiers, key }: Chord): ParsedKey {
  const held: ModifierName[] = []
  for (const name of modifiers) {
    const modifier = modifierName(name)
    if (modifier === undefined) return refused(`press() takes the modifiers ${modifierForms} before a key, received ${quoteText(text)}.`)
    if (held.includes(modifier) || (modifier === 'ControlOrMeta' && held.some((each) => overlapping.includes(each)))) {
      return refused(`press() takes each modifier once, received ${quoteText(text)}.`)
    }
    if (overlapping.includes(modifier) && held.includes('ControlOrMeta')) return refused(`press() takes each modifier once, received ${quoteText(text)}.`)
    held.push(modifier)
  }
  const named = namedKey(key)
  if (named !== undefined) return { ok: true, key: { kind: 'named', name: named, held } }
  if (key.length !== 1 || !character.test(key)) return refused(`press() takes ${keyForms}, received ${quoteText(text)}.`)
  if (held.every((modifier) => modifier === 'Shift')) {
    return refused(`Shift+ goes with a named key, or with Control, Alt or Meta, received ${quoteText(text)}. For an uppercase letter, press the letter itself, such as A.`)
  }
  // A letter in a shortcut names its key, whatever its case; Shift is pressed only when written.
  const typed = letter.test(key) ? key.toLowerCase() : key
  return { ok: true, key: { kind: 'character', character: typed, shift: false, held } }
}

function namedKey(text: string): NamedKey | undefined {
  return namedKeys.find((name) => name === text)
}

function modifierName(text: string): ModifierName | undefined {
  return modifierNames.find((name) => name === text)
}

function refused(message: string): ParsedKey {
  return { ok: false, failure: { class: 'usage', message } }
}

/**
 * How many keys a press holds and presses: its modifiers and the key, each released once.
 *
 * @example keyStrokes({ kind: 'named', name: 'Tab', held: ['Shift'] }) // 2
 */
export function keyStrokes(key: Key): number {
  return key.held.length + 1
}
