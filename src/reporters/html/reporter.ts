import type { RetestEvent } from '../../protocol/events.ts'
import type { Reporter } from '../reporter.ts'
import type { Writer } from '../style.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { errorMessage } from '../../protocol/failures.ts'
import { eventsFile } from '../../protocol/run-folder.ts'
import { readEvents } from '../../store/read-run-folder.ts'
import { buildReport } from './build-report.ts'
import { reportPath, writeReport } from './write-report.ts'

export type HtmlReporterOptions = {
  /** The terminal report printed beside the file, which receives every event first. */
  terminal: Reporter
  stdout: Writer
  /** The run folder as the person gave it, used in the printed path and in the report's commands. */
  runFolder: string
  /** The run folder's absolute path, where the report is written and artifacts are read. */
  directory: string
}

/**
 * Prints the terminal report and, once the run ends, writes `report.html` into the run folder from the run's events and
 * the result it ended with, then prints where it is. The report is made by the same code as `retest report`; the run
 * writes `result.json` after its reporters end, so this report reads the result the run handed them. The events are read
 * back from `events.jsonl`, where the run writes each one before any reporter receives it, so a long run's events are
 * not all held in memory until it ends. A report that cannot be written fails this reporter, which the run records as
 * output it could not keep.
 *
 * @example runFiles(options, [createHtmlReporter({ terminal: human, stdout, runFolder, directory })])
 */
export function createHtmlReporter(options: HtmlReporterOptions): Reporter {
  let received: number | undefined
  return {
    name: 'html',
    async onEvent(event) {
      received = event.sequence
      await options.terminal.onEvent(event)
    },
    async onRunEnd(result, context) {
      await options.terminal.onRunEnd(result)
      const events = received === undefined ? [] : writtenEvents(options.directory, received)
      writeReport(options.directory, await buildReport({ directory: options.directory, shown: options.runFolder, source: 'run', result, events, warnings: [], ...(context === undefined ? {} : { redactText: context.redactText }) }))
      options.stdout.write(`  Report  ${join(options.runFolder, reportPath)}\n\n`)
    },
  }
}

// The events the reporter received, up to the one numbered `last`, as the run wrote them. A file that lacks any of them,
// as one the run could not write to does, fails the report rather than leaving their steps out.
function writtenEvents(directory: string, last: number): RetestEvent[] {
  const problem = (reason: string): Error => new Error(`Retest could not read the run's events back from ${eventsFile} for the report: ${reason}`)
  let text: string
  try {
    text = readFileSync(join(directory, eventsFile), 'utf8')
  } catch (error) {
    throw problem(errorMessage(error))
  }
  const reading = readEvents(text)
  if (!reading.ok) throw problem(`${reading.problem}.`)
  const events = reading.events.filter((event) => event.sequence <= last)
  if (events.at(-1)?.sequence !== last) throw problem(`it ends before event ${last}, the last one the report received.`)
  return events
}
