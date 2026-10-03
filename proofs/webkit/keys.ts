/** One key press in the form WebKit's `Input.dispatchKeyEvent` takes it, on a US layout. */
export type KeyStroke = {
  readonly key: string
  readonly code: string
  /** The Windows virtual key code, which WebKit takes on every platform. */
  readonly keyCode: number
  readonly text: string
  readonly shift: boolean
}

/** WebKit's modifier bits: Shift 1, Control 2, Alt 4, Meta 8. Chromium's CDP orders them the other way round. */
export const SHIFT_MODIFIER = 1

/** The Shift key itself, pressed around a capital letter. */
export const SHIFT_KEY: KeyStroke = { key: 'Shift', code: 'ShiftLeft', keyCode: 16, text: '', shift: false }

const punctuation: Readonly<Record<string, Omit<KeyStroke, 'text' | 'shift'>>> = {
  ' ': { key: ' ', code: 'Space', keyCode: 32 },
  '.': { key: '.', code: 'Period', keyCode: 190 },
  ',': { key: ',', code: 'Comma', keyCode: 188 },
  '-': { key: '-', code: 'Minus', keyCode: 189 },
}

/**
 * The key presses that type `text`: letters, digits, space and `. , -`. Any other character is refused rather
 * than inserted some other way, and the refusal names its position, never the text, which may be a secret.
 *
 * @example keyStrokes('Hi') // [{ key: 'H', code: 'KeyH', keyCode: 72, text: 'H', shift: true }, { key: 'i', … }]
 */
export function keyStrokes(text: string): KeyStroke[] {
  return Array.from(text, (character, index) => {
    const stroke = keyStroke(character)
    if (stroke === undefined) throw new RangeError(`Character ${index + 1} of the text has no key on the proof's keyboard`)
    return stroke
  })
}

function keyStroke(character: string): KeyStroke | undefined {
  if (/^[a-z]$/.test(character)) {
    const upper = character.toUpperCase()
    return { key: character, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: character, shift: false }
  }
  if (/^[A-Z]$/.test(character)) return { key: character, code: `Key${character}`, keyCode: character.charCodeAt(0), text: character, shift: true }
  if (/^[0-9]$/.test(character)) return { key: character, code: `Digit${character}`, keyCode: character.charCodeAt(0), text: character, shift: false }
  const mark = punctuation[character]
  return mark === undefined ? undefined : { ...mark, text: character, shift: false }
}
