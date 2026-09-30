export type Paint = (text: string) => string

export type Style = {
  bold: Paint
  dim: Paint
  red: Paint
  green: Paint
  yellow: Paint
  cyan: Paint
}

/** Something text can be written to, such as `process.stdout`. */
export type Writer = { write(text: string): unknown }

/**
 * ANSI styles, or plain text when `enabled` is false.
 *
 * @example createStyle(false).red('failed') // 'failed'
 */
export function createStyle(enabled: boolean): Style {
  const paint = (open: number, close: number): Paint =>
    enabled ? (text) => `\u001b[${open}m${text}\u001b[${close}m` : (text) => text
  return {
    bold: paint(1, 22),
    dim: paint(2, 22),
    red: paint(31, 39),
    green: paint(32, 39),
    yellow: paint(33, 39),
    cyan: paint(36, 39),
  }
}
