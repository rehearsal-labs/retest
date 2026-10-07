import type { RetestEvent } from '../../protocol/events.ts'
import type { Reporter } from '../reporter.ts'
import type { Writer } from '../style.ts'
import { join } from 'node:path'
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
 * writes `result.json` after its reporters end, so this report reads the result the run handed them. A report that
 * cannot be written fails this reporter, which the run records as output it could not keep.
 *
 * @example runFiles(options, [createHtmlReporter({ terminal: human, stdout, runFolder, directory })])
 */
export function createHtmlReporter(options: HtmlReporterOptions): Reporter {
  const events: RetestEvent[] = []
  return {
    name: 'html',
    async onEvent(event) {
      events.push(event)
      await options.terminal.onEvent(event)
    },
    async onRunEnd(result, context) {
      await options.terminal.onRunEnd(result)
      writeReport(options.directory, await buildReport({ directory: options.directory, shown: options.runFolder, source: 'run', result, events, warnings: [], ...(context === undefined ? {} : { redactText: context.redactText }) }))
      options.stdout.write(`  Report  ${join(options.runFolder, reportPath)}\n\n`)
    },
  }
}
