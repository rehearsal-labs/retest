import type { Reporter } from './reporter.ts'
import type { Writer } from './style.ts'

/**
 * Writes each event as one JSON line and nothing else, so every line of stdout parses as an event.
 *
 * @example runFiles(options, [createJsonlReporter({ stdout: process.stdout })])
 */
export function createJsonlReporter(options: { stdout: Writer }): Reporter {
  return {
    name: 'jsonl',
    onEvent(event) {
      options.stdout.write(`${JSON.stringify(event)}\n`)
    },
    onRunEnd() {},
  }
}
