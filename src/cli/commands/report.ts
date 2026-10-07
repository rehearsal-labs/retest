import type { RunFolder } from '../../store/read-run-folder.ts'
import type { Command } from '../command.ts'
import { join, resolve } from 'node:path'
import { errorMessage } from '../../protocol/failures.ts'
import { buildReport } from '../../reporters/html/build-report.ts'
import { reportPath, writeReport } from '../../reporters/html/write-report.ts'
import { readRunFolder, RunFolderReadError } from '../../store/read-run-folder.ts'
import { parseArguments } from '../arguments.ts'
import { CliError, UsageError } from '../errors.ts'

const options = {}

export const reportCommand: Command = {
  name: 'report',
  usage: '<run-folder>',
  summary: 'Write an HTML report of a run folder',
  description: [
    `Writes ${reportPath} into the run folder from its events and result. It never runs a test or opens a browser.`,
    'A run that stopped early has no result.json; its result is rebuilt from events.jsonl and the report says it is incomplete.',
    `The report is one file that needs no server and loads nothing from the network. It replaces an earlier ${reportPath}.`,
  ].join('\n'),
  options,
  notes: 'Exit codes: 0 the report was written, 2 the folder cannot be read or the report cannot be written.',
  async run(args, dependencies) {
    const parsed = parseArguments(options, args)
    const [shown, ...extra] = parsed.positionals
    if (shown === undefined) throw new UsageError('Name the run folder to report on, such as .retest/runs/<time>.')
    if (extra.length > 0) throw new UsageError(`report reads one run folder, received ${parsed.positionals.length}.`)
    const directory = resolve(dependencies.cwd, shown)
    const folder = readFolder(directory, shown)
    for (const warning of folder.warnings) dependencies.stderr.write(`warning: ${warning}\n`)
    const report = await buildReport({ directory, shown, source: folder.source, result: folder.result, events: folder.events, warnings: folder.warnings })
    try {
      writeReport(directory, report)
    } catch (error) {
      throw new CliError(`Retest could not write ${join(shown, reportPath)}: ${errorMessage(error)}`, { cause: error })
    }
    dependencies.stdout.write(`${join(shown, reportPath)}\n`)
    return 0
  },
}

// A folder that is not a run folder is an expected failure, told as the store tells it.
function readFolder(directory: string, shown: string): RunFolder {
  try {
    return readRunFolder(directory, shown)
  } catch (error) {
    if (error instanceof RunFolderReadError) throw new CliError(error.message, { cause: error })
    throw error
  }
}
