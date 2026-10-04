import type { Failure, FailureDetail } from '../protocol/failures.ts'

const maxOutputLineLength = 64 * 1024

/** Holds split values until a whole line can be redacted; oversized lines are discarded whole and reported. */
export class NativeOutputLines {
  readonly #redact: (text: string) => string
  readonly #write: (text: string) => void
  readonly #problem: ((message: string) => void) | undefined
  #held = ''
  #oversized = false
  #reported = false

  constructor(redact: (text: string) => string, write: (text: string) => void, problem?: (message: string) => void) {
    this.#redact = redact
    this.#write = write
    this.#problem = problem
  }

  push(chunk: string): void {
    for (let offset = 0; offset < chunk.length;) {
      const end = chunk.indexOf('\n', offset)
      const through = end < 0 ? chunk.length : end + 1
      if (!this.#oversized) {
        if (this.#held.length + through - offset > maxOutputLineLength) {
          this.#held = ''
          this.#oversized = true
          if (!this.#reported) {
            this.#reported = true
            this.#problem?.(`Native process output exceeded the maximum line length of ${maxOutputLineLength} characters; oversized lines were discarded.`)
          }
        } else this.#held += chunk.slice(offset, through)
      }
      offset = through
      if (end >= 0) this.#finishLine(true)
    }
  }

  end(): void {
    if (this.#held !== '' || this.#oversized) this.#finishLine(false)
  }

  #finishLine(newline: boolean): void {
    if (this.#oversized) this.#write(`{{native-output-line-discarded}}${newline ? '\n' : ''}`)
    else this.#line(this.#held)
    this.#held = ''
    this.#oversized = false
  }

  #line(line: string): void {
    // XCTest abbreviates typed text and macOS logs individual keys. Neither is a whole value the run's
    // redactor can recognise. Keep the activity kind, never its input-bearing name, even for ordinary text.
    const activity = /\b(?:Type(?:\s+key|\s+text)?\s+['"“‘]|Synthesize event\b)/i.exec(line)
    const safe = activity === null ? line : `${line.slice(0, activity.index)}${activity[0].startsWith('Synthesize') ? 'Synthesize event' : 'Type'} {{native-input}}${line.endsWith('\n') ? '\n' : ''}`
    this.#write(this.#redact(safe))
  }
}

/** Executor failure text is untrusted output too, including truncated detail fields. */
export function redactNativeFailure(failure: Failure, redact: (text: string) => string): Failure {
  const detail = (value: FailureDetail): FailureDetail => typeof value === 'string' ? redact(value) : value !== null && typeof value === 'object' ? { ...value, text: redact(value.text) } : value
  return { ...failure, message: redact(failure.message), ...(failure.details === undefined ? {} : { details: Object.fromEntries(Object.entries(failure.details).map(([key, value]) => [key, detail(value)])) }) }
}
