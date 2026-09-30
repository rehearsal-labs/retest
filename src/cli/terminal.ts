import type { ExitCode } from '../protocol/events.ts'
import type { Writer } from '../reporters/style.ts'

export type Environment = Readonly<Record<string, string | undefined>>

/** An output stream and whether a person's terminal is on the other end. */
export type Terminal = Writer & { readonly isTTY: boolean }

/** A process stream, such as `process.stdout`, that can report an error such as a closed pipe. */
export type OutputStream = Writer & {
  readonly isTTY?: boolean
  on(event: 'error', listener: (error: Error) => void): unknown
}

/** The terminal the report goes to, and the first error its stream reported. */
export type ReportTerminal = { terminal: Terminal; failure(): Error | undefined }

/**
 * Colour only on a terminal, and never when `NO_COLOR` is set to anything but an empty string.
 *
 * @example shouldUseColor(stdout, process.env)
 */
export function shouldUseColor(terminal: Terminal, env: Environment): boolean {
  const noColor = env['NO_COLOR']
  return terminal.isTTY && (noColor === undefined || noColor === '')
}

/**
 * The terminal for the report. A closed pipe does not crash the process; once the stream has failed,
 * writing throws, so the reporter fails and the run records that nobody could read its report.
 *
 * @example const stdout = reportTerminal(process.stdout)
 */
export function reportTerminal(stream: OutputStream): ReportTerminal {
  const failure = keepFirstError(stream)
  const terminal: Terminal = {
    write: (text) => {
      const error = failure()
      if (error !== undefined) throw new Error(`Cannot write the report to stdout: ${error.message}`)
      return stream.write(text)
    },
    isTTY: stream.isTTY === true,
  }
  return { terminal, failure }
}

/**
 * The terminal for messages beside the report, such as warnings and test output. A failure there changes
 * nothing: the report was delivered elsewhere.
 *
 * @example const stderr = messageTerminal(process.stderr)
 */
export function messageTerminal(stream: OutputStream): Terminal {
  keepFirstError(stream)
  return { write: (text) => stream.write(text), isTTY: stream.isTTY === true }
}

/**
 * The exit code once the report's stream is known to have failed: a report nobody could read is not a pass.
 *
 * @example exitCodeAfterOutput(0, true) // 2
 */
export function exitCodeAfterOutput(code: ExitCode, reportFailed: boolean): ExitCode {
  return reportFailed && code === 0 ? 2 : code
}

// A stream that emits `error` with no listener would end the process.
function keepFirstError(stream: OutputStream): () => Error | undefined {
  let first: Error | undefined
  stream.on('error', (error) => {
    first ??= error
  })
  return () => first
}
