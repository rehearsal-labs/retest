import type { RetestTypeError } from '../config/register.ts'
import type { ModifierName, NamedKey } from '../protocol/keys.ts'

// The rule is `parseKey`'s, read in the same order. The types cannot read Unicode's categories, and TypeScript 7
// counts a character by code point where 6 counts code units, so past ASCII's whitespace only `parseKey` knows
// which single characters type; it runs in the test process before the press is sent, and in the parent again.
// A modifier written twice is refused there too.

type Messages = {
  forms: 'press() takes a named key such as Enter or ArrowDown, one character, or modifiers and a key, such as Control+A.'
  modifier: 'press() takes the modifiers Shift, Control, Alt, Meta or ControlOrMeta before a key.'
  shift: 'Shift+ goes with a named key, or with Control, Alt or Meta. For an uppercase letter, press the letter itself, such as A.'
}

type Whitespace = ' ' | '\t' | '\n' | '\v' | '\f' | '\r'

// The part after the last `+`, and the parts before it.
type LastPart<Text extends string> = Text extends `${string}+${infer Rest}` ? LastPart<Rest> : Text
type LeadingParts<Text extends string, Found extends string = never> = Text extends `${infer Part}+${infer Rest}`
  ? LeadingParts<Rest, Found | Part>
  : Found

// A literal becomes a property, which `{}` lacks. `string`, or a pattern such as `${number}`, becomes an index
// signature, which `{}` meets.
type IsLiteral<Text extends string> = {} extends Record<Text, 1> ? false : true

type IsOneCharacter<Text extends string> = Text extends `${string}${infer Rest}` ? (Rest extends '' ? true : false) : false

type ChordKey<K extends string, Modifiers extends string, Key extends string> = [Exclude<Modifiers, ModifierName>] extends [never]
  ? Key extends NamedKey
    ? K
    : IsOneCharacter<Key> extends true
      ? Key extends Whitespace
        ? RetestTypeError<Messages['forms']>
        : [Exclude<Modifiers, 'Shift'>] extends [never]
          ? RetestTypeError<Messages['shift']>
          : K
      : RetestTypeError<Messages['forms']>
  : RetestTypeError<Messages['modifier']>

type LiteralKey<K extends string> = K extends NamedKey
  ? K
  : IsOneCharacter<K> extends true
    ? K extends Whitespace
      ? RetestTypeError<Messages['forms']>
      : K
    : K extends `${infer Modifiers}++`
      ? Modifiers extends ''
        ? RetestTypeError<Messages['forms']>
        : ChordKey<K, LeadingParts<Modifiers> | LastPart<Modifiers>, '+'>
      : K extends `${string}+${string}`
        ? ChordKey<K, LeadingParts<K>, LastPart<K>>
        : RetestTypeError<Messages['forms']>

/**
 * `K` when `press` takes it, and otherwise an error naming what it takes: a named key, one character, or modifiers
 * and a key, such as `Control+A`. A key whose text the types cannot see, such as a `string`, is checked when the test
 * runs.
 *
 * @example
 * async function submit<const K extends string>(field: Locator, key: KeyArgument<K>) { await field.press(key) }
 */
export type KeyArgument<K extends string> = K extends unknown ? (IsLiteral<K> extends true ? LiteralKey<K> : K) : never
