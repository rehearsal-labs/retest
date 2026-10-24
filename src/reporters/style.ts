export type Paint = (text: string) => string

/**
 * The marks a report draws for something that passed or failed, for a step that starts, and in place of a line break
 * kept on one line.
 */
export type Marks = { passed: string; failed: string; step: string; lineBreak: string }

/** The marks a terminal with the glyphs draws, and every report that is not written to a terminal. */
export const unicodeMarks: Marks = { passed: '✓', failed: '✗', step: '▸', lineBreak: '⏎' }

/**
 * The marks for a Windows console whose fonts lack the glyphs. Consolas and Lucida Console, the fonts of the console
 * host behind cmd.exe and PowerShell, have no ✓, ✗ or ⏎, Lucida Console has no ▸, and that console draws a box for a
 * glyph its font lacks; both fonts have √, ×, ► and ¶.
 */
export const consoleMarks: Marks = { passed: '√', failed: '×', step: '►', lineBreak: '¶' }

export type Style = {
  bold: Paint
  dim: Paint
  red: Paint
  green: Paint
  yellow: Paint
  cyan: Paint
  marks: Marks
}

/** Something text can be written to, such as `process.stdout`. */
export type Writer = { write(text: string): unknown }

/**
 * ANSI styles, or plain text when `enabled` is false, with the marks the terminal draws.
 *
 * @example createStyle(false).red('failed') // 'failed'
 */
export function createStyle(enabled: boolean, marks: Marks = unicodeMarks): Style {
  const paint = (open: number, close: number): Paint =>
    enabled ? (text) => `\u001b[${open}m${text}\u001b[${close}m` : (text) => text
  return {
    bold: paint(1, 22),
    dim: paint(2, 22),
    red: paint(31, 39),
    green: paint(32, 39),
    yellow: paint(33, 39),
    cyan: paint(36, 39),
    marks,
  }
}

/** The length of text as a terminal shows it, without colour codes. */
export function visibleLength(text: string): number {
  return text.replace(/\u001b\[\d+m/g, '').length
}
