import type { SourceLocation } from './failures.ts'

/** A line as a person names it on the command line: a file, a line, and for one `test.for` row, its number from 1. */
export type LinePlace = { file: string; line: number; row?: number | undefined }

/** @example formatLocation({ file: 'a.retest.ts', line: 7, column: 3 }) // 'a.retest.ts:7:3' */
export function formatLocation(location: SourceLocation): string {
  return `${location.file}:${location.line}:${location.column}`
}

/**
 * A place as `file:line` names it, with `#row` for one row of a `test.for`.
 *
 * @example formatLine({ file: 'a.retest.ts', line: 7, row: 2 }) // 'a.retest.ts:7#2'
 */
export function formatLine(place: LinePlace): string {
  return `${place.file}:${place.line}${place.row === undefined ? '' : `#${place.row}`}`
}
