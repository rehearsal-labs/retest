import type { RetestEvent } from '../../protocol/events.ts'
import type { TestResult } from '../../protocol/result.ts'
import type { CliDependencies, Command } from '../command.ts'
import type { RunFolder } from '../inspect/read-run-folder.ts'
import { resolve } from 'node:path'
import { testCard } from '../../reporters/failure-card.ts'
import { renderCard } from '../../reporters/human-card.ts'
import { createHumanReporter } from '../../reporters/human.ts'
import { recordEvents } from '../../reporters/run-record.ts'
import { createStyle } from '../../reporters/style.ts'
import { flag, parseArguments, value } from '../arguments.ts'
import { CliError, UsageError } from '../errors.ts'
import { readRunFolder } from '../inspect/read-run-folder.ts'
import { renderTimeline } from '../inspect/test-timeline.ts'
import { suggest } from '../suggest.ts'
import { shouldUseColor } from '../terminal.ts'

/** What `inspect --test <id> --json` prints: the test's result and its events, in order. */
export type TestReport = {
  schemaVersion: 1
  runId: string
  /** Whether the run itself finished. */
  complete: boolean
  test: TestResult
  events: RetestEvent[]
}

const listedTests = 10

const options = {
  json: flag('Print one JSON document: the run result, or the test with --test'),
  test: value({ placeholder: '<id>', description: 'Show one test, such as "examples/task.retest.ts > saves a task"' }),
}

export const inspectCommand: Command = {
  name: 'inspect',
  usage: '<run-folder> [options]',
  summary: 'Read a run folder without running anything',
  description: [
    'Reads the result of a run from its folder. It never runs a test or opens a browser.',
    'A run that stopped early has no result.json; its result is rebuilt from events.jsonl and marked incomplete.',
  ].join('\n'),
  options,
  notes: 'Exit codes: 0 the folder was read, 2 it is missing or cannot be read.',
  async run(args, dependencies) {
    const parsed = parseArguments(options, args)
    const [shown, ...extra] = parsed.positionals
    if (shown === undefined) throw new UsageError('Name the run folder to read, such as .retest/runs/<time>.')
    if (extra.length > 0) throw new UsageError(`inspect reads one run folder, received ${parsed.positionals.length}.`)
    const folder = readRunFolder(resolve(dependencies.cwd, shown), shown)
    for (const warning of folder.warnings) dependencies.stderr.write(`warning: ${warning}\n`)
    const testId = parsed.value('test')
    const json = parsed.flag('json')
    if (testId !== undefined) writeTest({ folder, shown, testId, json }, dependencies)
    else if (json) dependencies.stdout.write(`${JSON.stringify(folder.result, null, 2)}\n`)
    else writeRun(folder, shown, dependencies)
    return 0
  },
}

type TestRequest = { folder: RunFolder; shown: string; testId: string; json: boolean }

function writeTest(request: TestRequest, dependencies: CliDependencies): void {
  const { folder, shown, testId } = request
  const test = findTest(folder, testId)
  const record = recordEvents(folder.events)
  const events = record.tests.get(testId)?.events ?? []
  const { stdout } = dependencies
  if (request.json) {
    const { runId, complete } = folder.result
    const report: TestReport = { schemaVersion: 1, runId, complete, test, events }
    stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }
  const style = createStyle(shouldUseColor(stdout, dependencies.env))
  stdout.write(`\n${renderTimeline(test, events, { style, runFolder: shown })}`)
  if (test.status === 'passed') return
  const card = testCard(test, { record, runFolder: shown })
  stdout.write(`\n${renderCard(card, { style, runFolder: shown, rootDir: record.started?.rootDir })}`)
}

// The same report a run prints, replayed from the folder.
function writeRun(folder: RunFolder, shown: string, dependencies: CliDependencies): void {
  const reporter = createHumanReporter({
    stdout: dependencies.stdout,
    stderr: dependencies.stderr,
    color: shouldUseColor(dependencies.stdout, dependencies.env),
    runFolder: shown,
  })
  for (const event of folder.events) reporter.onEvent(event)
  reporter.onRunEnd(folder.result)
}

function findTest(folder: RunFolder, testId: string): TestResult {
  const tests = folder.result.files.flatMap((file) => file.tests)
  const test = tests.find((candidate) => candidate.testId === testId)
  if (test !== undefined) return test
  const ids = tests.map((candidate) => candidate.testId)
  const guess = suggest(testId, ids)
  const hint = guess === undefined ? '' : ` Did you mean "${guess}"?`
  const listed = ids.slice(0, listedTests).map((id) => `\n  ${id}`)
  const more = ids.length > listedTests ? [`\n  and ${ids.length - listedTests} more`] : []
  const known = ids.length === 0 ? '\nThe run has no tests.' : `\nTests in this run:${[...listed, ...more].join('')}`
  throw new CliError(`No test "${testId}" in this run.${hint}${known}`)
}
