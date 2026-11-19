import { truncateText } from '../../protocol/failures.ts'
import { printable } from '../../reporters/format.ts'

// Enough for a few errors with their source lines and notes, and for a line that names a file by a path as long as
// Windows allows. A whole build log is never printed: a linker's error alone quotes the linker's command line, which
// runs to kilobytes on one line.
const maximumLines = 40
const maximumLineLength = 400

// How rustc and cargo begin an error, `error: ...` or `error[E0308]: ...`, at the start of a line.
const errorStart = /^error(\[[A-Z]+\d+\])?: /
// Cargo's own last line, which the install's refusal quotes already, and rustc's, which cargo replaces with its own.
const closingLine = /^error: (could not compile|aborting due to) /
// A note or a help rustc prints on its own after an error, such as the linker's advice.
const errorNote = /^(note|help): /
// Cargo right-aligns the verb of a progress line to end at the twelfth column: `   Compiling windows-sys v0.61.2`.
const cargoProgress = /^ *[A-Z][a-z]+ /
const progressColumn = 12

/**
 * The compiler's errors from a failed `cargo build`, as lines a terminal can print. Each error runs from its `error`
 * line through its file, line, source and notes, and through the causes cargo gives for an error of its own. Warnings,
 * cargo's progress and cargo's closing line are left out. A long line is cut, and lines past the bound are counted, not
 * printed.
 *
 * @example compilerErrorLines('error[E0425]: cannot find value `x` in this scope\n --> src/main.rs:2:5\n\nerror: could not compile `x` (bin "x") due to 1 previous error\n') // ['error[E0425]: cannot find value `x` in this scope', ' --> src/main.rs:2:5']
 */
export function compilerErrorLines(stderr: string): string[] {
  const kept: string[] = []
  // `paused` is the blank line after an error: the error ends there unless cargo's causes or a note of rustc's follow.
  let state: 'outside' | 'inside' | 'paused' = 'outside'
  for (const line of stderr.split(/\r?\n/)) {
    if (errorStart.test(line)) {
      if (closingLine.test(line)) {
        state = 'outside'
        continue
      }
      if (kept.length > 0) kept.push('')
      kept.push(line)
      state = 'inside'
    } else if (state === 'outside') {
      continue
    } else if (line.trim() === '') {
      state = 'paused'
    } else if (isCargoProgress(line)) {
      state = 'outside'
    } else if (state === 'inside' || line.startsWith('Caused by:') || line.startsWith(' ') || errorNote.test(line)) {
      // After a blank line, cargo's causes, the indented output a cause quotes and rustc's notes still belong to it.
      if (state === 'paused') kept.push('')
      kept.push(line)
      state = 'inside'
    } else {
      state = 'outside'
    }
  }
  const shown = kept.slice(0, maximumLines).map(printableLine)
  const left = kept.length - shown.length
  return left > 0 ? [...shown, `${left} more ${left === 1 ? 'line' : 'lines'} of the compiler's errors are not shown.`] : shown
}

function isCargoProgress(line: string): boolean {
  const verb = cargoProgress.exec(line)
  return verb !== null && verb[0].length === progressColumn + 1
}

function printableLine(line: string): string {
  const cut = truncateText(printable(line), maximumLineLength)
  return cut.truncated ? `${cut.text} ...` : cut.text
}
