import type { RetestEvent } from '../../protocol/events.ts'
import type { TestResult } from '../../protocol/result.ts'
import type { Variant } from '../../protocol/variant.ts'
import type { RunFolder } from '../../store/read-run-folder.ts'
import type { SessionDiagnostics } from '../inspect/diagnostics.ts'
import type { CliDependencies, Command } from '../command.ts'
import { resolve } from 'node:path'
import { matchesTargets, variantKey } from '../../protocol/variant.ts'
import { createStyle } from '../../reporters/style.ts'
import { listWords } from '../../shared/list-words.ts'
import { readTargetPairs } from '../app-pairs.ts'
import { flag, list, parseArguments, value } from '../arguments.ts'
import { CliError, UsageError } from '../errors.ts'
import { suggest } from '../suggest.ts'
import { shouldUseColor, terminalMarks } from '../terminal.ts'

/**
 * What `inspect --test <id> --json` prints: the test's result and its events, in order, and each session's diagnostics
 * with the lines of its artifact, or why they could not be read.
 */
export type TestReport = {
  schemaVersion: 1
  runId: string
  /** Whether the run itself finished. */
  complete: boolean
  test: TestResult
  events: RetestEvent[]
  diagnostics?: SessionDiagnostics[]
}

const listedTests = 10

const options = {
  json: flag('Print one JSON document: the run result, or the test with --test'),
  test: value({ placeholder: '<id>', description: 'Show one test, such as "examples/task.retest.ts > saves a task"' }),
  target: list({
    placeholder: '<app=name>',
    description: 'With --test, the target it ran on, when it ran on several.\nRepeat for other apps',
  }),
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
    const folder = await readFolder(resolve(dependencies.cwd, shown), shown)
    for (const warning of folder.warnings) dependencies.stderr.write(`warning: ${warning}\n`)
    const testId = parsed.value('test')
    const json = parsed.flag('json')
    const targets = readTargets(parsed.list('target'))
    if (testId === undefined && targets !== undefined) throw new UsageError('--target picks a test\'s target, so it needs --test.')
    if (testId !== undefined) await writeTest({ folder, shown, path: resolve(dependencies.cwd, shown), testId, targets, json }, dependencies)
    else if (json) dependencies.stdout.write(`${JSON.stringify(folder.result, null, 2)}\n`)
    else await writeRun(folder, shown, dependencies)
    return 0
  },
}

// A folder that is not a run folder is an expected failure, told as the store tells it. The store's reader, like the
// views below, loads only when inspect runs, not with every other command.
async function readFolder(folder: string, shown: string): Promise<RunFolder> {
  const { readRunFolder, RunFolderReadError } = await import('../../store/read-run-folder.ts')
  try {
    return readRunFolder(folder, shown)
  } catch (error) {
    if (error instanceof RunFolderReadError) throw new CliError(error.message, { cause: error })
    throw error
  }
}

type TestRequest = { folder: RunFolder; shown: string; path: string; testId: string; targets: Variant | undefined; json: boolean }

async function writeTest(request: TestRequest, dependencies: CliDependencies): Promise<void> {
  const [{ recordEvents }, { readTestDiagnostics, renderTestDiagnostics }, { runTargets }, { renderTimeline }, { testCard }, { renderCard }] = await Promise.all([
    import('../../reporters/run-record.ts'),
    import('../inspect/diagnostics.ts'),
    import('../../reporters/targets.ts'),
    import('../inspect/test-timeline.ts'),
    import('../../reporters/failure-card.ts'),
    import('../../reporters/human-card.ts'),
  ])
  const { folder, shown, testId } = request
  const test = findTest(folder, testId, request.targets)
  const record = recordEvents(folder.events)
  const events = record.test(testId, test.variantKey)?.events ?? []
  const diagnostics = readTestDiagnostics(request.path, test)
  const { stdout } = dependencies
  if (request.json) {
    const { runId, complete } = folder.result
    const report: TestReport = { schemaVersion: 1, runId, complete, test, events, ...(diagnostics.length === 0 ? {} : { diagnostics }) }
    stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }
  const style = createStyle(shouldUseColor(stdout, dependencies.env), terminalMarks(stdout, dependencies.env))
  const targets = runTargets(record, folder.result)
  stdout.write(`\n${renderTimeline(test, events, { style, runFolder: shown, targets })}`)
  stdout.write(renderTestDiagnostics(diagnostics, events, { style, runFolder: shown }))
  if (test.status === 'passed' || test.status === 'skipped') return
  const card = testCard(test, { record, runFolder: shown, targets })
  stdout.write(`\n${renderCard(card, { style, runFolder: shown, rootDir: record.started?.rootDir })}`)
}

// The same report a run prints, replayed from the folder.
async function writeRun(folder: RunFolder, shown: string, dependencies: CliDependencies): Promise<void> {
  const { createHumanReporter } = await import('../../reporters/human.ts')
  const reporter = createHumanReporter({
    stdout: dependencies.stdout,
    stderr: dependencies.stderr,
    color: shouldUseColor(dependencies.stdout, dependencies.env),
    marks: terminalMarks(dependencies.stdout, dependencies.env),
    runFolder: shown,
  })
  for (const event of folder.events) reporter.onEvent(event)
  reporter.onRunEnd(folder.result)
}

function readTargets(texts: readonly string[]): Variant | undefined {
  return texts.length === 0 ? undefined : readTargetPairs(texts)
}

function findTest(folder: RunFolder, testId: string, targets: Variant | undefined): TestResult {
  const tests = folder.result.files.flatMap((file) => file.tests)
  const matching = tests.filter((candidate) => candidate.testId === testId)
  if (matching.length === 0) throw unknownTest(testId, tests)
  const kept = matching.filter((candidate) => matchesTargets(candidate.variant, targets ?? {}))
  const [only] = kept
  if (kept.length === 1 && only !== undefined) return only
  const ran = listWords(matching.map((candidate) => (candidate.variant === undefined ? 'no target' : variantKey(candidate.variant))), 'and')
  if (kept.length === 0) {
    throw new CliError(`"${testId}" did not run on ${variantKey(targets ?? {})} in this run. It ran on ${ran}.`)
  }
  throw new UsageError(`"${testId}" ran on ${ran}. Name one with --target, such as --target ${kept[0]?.variantKey ?? ''}.`)
}

function unknownTest(testId: string, tests: readonly TestResult[]): CliError {
  const ids = [...new Set(tests.map((candidate) => candidate.testId))]
  const guess = suggest(testId, ids)
  const hint = guess === undefined ? '' : ` Did you mean "${guess}"?`
  const listed = ids.slice(0, listedTests).map((id) => `\n  ${id}`)
  const more = ids.length > listedTests ? [`\n  and ${ids.length - listedTests} more`] : []
  const known = ids.length === 0 ? '\nThe run has no tests.' : `\nTests in this run:${[...listed, ...more].join('')}`
  return new CliError(`No test "${testId}" in this run.${hint}${known}`)
}
