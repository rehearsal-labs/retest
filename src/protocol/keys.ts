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

/**
 * A key as `press` sends it: a named key, or the one character a key types. `shift` holds Shift down for the
 * press: `Shift+` and a named key, or an uppercase letter, which a person types with Shift.
 */
export type Key = { kind: 'named'; name: NamedKey; shift: boolean } | { kind: 'character'; character: string; shift: boolean }

export type ParsedKey = { ok: true; key: Key } | { ok: false; failure: Failure }

// An editing shortcut needs each platform's own command, so these never reach the page.
const refusedModifiers: readonly string[] = ['Control', 'Alt', 'Meta']
const shiftPrefix = 'Shift+'
// One UTF-16 code unit that types something: a letter, a digit, punctuation or a symbol.
const character = /^[\p{L}\p{N}\p{P}\p{S}]$/u
const uppercaseLetter = /^\p{Lu}$/u

const keyForms = `a named key (${namedKeys.slice(0, -1).join(', ')} or ${namedKeys.at(-1)}), Shift+ and a named key, such as Shift+Tab, or one character, such as a, 7 or é`

/**
 * Reads the key `press` was given. Control, Alt and Meta are `unsupported`; anything else it does not take is
 * `usage`, and the message lists what it takes.
 *
 * @example parseKey('Shift+Tab') // { ok: true, key: { kind: 'named', name: 'Tab', shift: true } }
 */
export function parseKey(text: string): ParsedKey {
  const named = namedKey(text)
  if (named !== undefined) return { ok: true, key: { kind: 'named', name: named, shift: false } }
  if (text.length === 1 && character.test(text)) {
    return { ok: true, key: { kind: 'character', character: text, shift: uppercaseLetter.test(text) } }
  }
  if (text.length > 1 && text.split('+').some((part) => refusedModifiers.includes(part))) {
    return refused(
      'unsupported',
      `press() does not send Control, Alt or Meta, received ${quoteText(text)}. An editing shortcut needs the platform's own command, and the platforms differ.`,
    )
  }
  if (!text.startsWith(shiftPrefix)) return refused('usage', `press() takes ${keyForms}, received ${quoteText(text)}.`)
  const shifted = namedKey(text.slice(shiftPrefix.length))
  if (shifted !== undefined) return { ok: true, key: { kind: 'named', name: shifted, shift: true } }
  return refused('usage', `Shift+ goes only with a named key, received ${quoteText(text)}. For an uppercase letter, press the letter itself, such as A.`)
}

function namedKey(text: string): NamedKey | undefined {
  return namedKeys.find((name) => name === text)
}

function refused(kind: 'unsupported' | 'usage', message: string): ParsedKey {
  return { ok: false, failure: { class: kind, message } }
}
