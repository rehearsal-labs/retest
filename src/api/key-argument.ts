import type { RetestTypeError } from '../config/register.ts'
import type { NamedKey } from '../protocol/keys.ts'

// The rule is `parseKey`'s, read in the same order. The types cannot read Unicode's categories, and TypeScript 7
// counts a character by code point where 6 counts code units, so past ASCII's whitespace only `parseKey` knows
// which single characters type; it runs in the test process before the press is sent, and in the parent again.

type Messages = {
  forms: 'press() takes a named key such as Enter or ArrowDown, Shift+ and a named key, or one character.'
  modifier: "press() does not send Control, Alt or Meta. An editing shortcut needs the platform's own command."
  shift: 'Shift+ goes only with a named key. For an uppercase letter, press the letter itself, such as A.'
}

type Whitespace = ' ' | '\t' | '\n' | '\v' | '\f' | '\r'

type Parts<Text extends string, Found extends string = never> = Text extends `${infer Part}+${infer Rest}`
  ? Parts<Rest, Found | Part>
  : Found | Text

// A literal becomes a property, which `{}` lacks. `string`, or a pattern such as `${number}`, becomes an index
// signature, which `{}` meets.
type IsLiteral<Text extends string> = {} extends Record<Text, 1> ? false : true

type IsOneCharacter<Text extends string> = Text extends `${string}${infer Rest}` ? (Rest extends '' ? true : false) : false

type LiteralKey<K extends string> = K extends NamedKey | `Shift+${NamedKey}`
  ? K
  : IsOneCharacter<K> extends true
    ? K extends Whitespace
      ? RetestTypeError<Messages['forms']>
      : K
    : [Extract<Parts<K>, 'Control' | 'Alt' | 'Meta'>] extends [never]
      ? K extends `Shift+${string}`
        ? RetestTypeError<Messages['shift']>
        : RetestTypeError<Messages['forms']>
      : RetestTypeError<Messages['modifier']>

/**
 * `K` when `press` takes it, and otherwise an error naming what it takes: a named key, `Shift+` and a named key,
 * or one character. A key whose text the types cannot see, such as a `string`, is checked when the test runs.
 *
 * @example
 * async function submit<const K extends string>(field: Locator, key: KeyArgument<K>) { await field.press(key) }
 */
export type KeyArgument<K extends string> = K extends unknown ? (IsLiteral<K> extends true ? LiteralKey<K> : K) : never
