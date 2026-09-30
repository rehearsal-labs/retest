import type { LoadedConfig } from '../config/loaded.ts'
import type { LastRunTest } from '../protocol/last-run.ts'
import type { FileLine, Selection, TagExpression } from '../runner/contract.ts'
import type { FlagOption, ListOption, ParsedArguments, ValueOption } from './arguments.ts'
import { join } from 'node:path'
import { errorMessage } from '../protocol/failures.ts'
import { lastRunFile, lastRunSchema } from '../protocol/last-run.ts'
import { formatLine } from '../protocol/location.ts'
import { parse } from '../protocol/schema.ts'
import { testFileSuffix } from '../shared/test-files.ts'
import { parseTargets } from './app-pairs.ts'
import { flag, list, value } from './arguments.ts'
import { CliError, UsageError } from './errors.ts'
import { readTextIfPresent } from './file-system.ts'
import { parseTagExpression, TagExpressionError } from './tag-expression.ts'
import { everyTestFile, readFileArguments } from './test-files.ts'

export type SelectionOptions = { grep: ValueOption; tag: ValueOption; target: ListOption; 'last-failed': FlagOption }

/** The options that choose tests, the same for `run` and `list`. */
export const selectionOptions: SelectionOptions = {
  grep: value({ placeholder: '<text>', description: 'Keep tests whose full title contains the text,\nor matches /pattern/flags' }),
  tag: value({ placeholder: '<expression>', description: 'Keep tests whose tags match, such as "smoke and not slow"' }),
  target: list({ placeholder: '<app=name>', description: 'Keep only this target of the app, such as web=beta.\nRepeat for other apps' }),
  'last-failed': flag(`Keep the tests the last run did not pass, from ${lastRunFile}`),
}

export type SelectionArguments = { grep?: string; tag?: string; targets: string[]; lastFailed: boolean }

/** The tests a command works on: files as POSIX paths relative to the root, and what keeps tests in them. */
export type TestScope = { files: string[]; selection?: Selection }

export type ScopeRequest = {
  cwd: string
  positionals: readonly string[]
  /** Without a config, files must be named; with one, no files means every test file under the root. */
  config: LoadedConfig | undefined
  flags: SelectionArguments
}

/** Reads the selection flags from any command's parsed arguments that include `selectionOptions`. */
export type SelectionFlagReader = Pick<ParsedArguments<typeof selectionOptions>, 'value' | 'list' | 'flag'>

/** @example selectionArguments(parseArguments(options, args)) */
export function selectionArguments(parsed: SelectionFlagReader): SelectionArguments {
  const grep = parsed.value('grep')
  const tag = parsed.value('tag')
  return {
    ...(grep === undefined ? {} : { grep }),
    ...(tag === undefined ? {} : { tag }),
    targets: parsed.list('target'),
    lastFailed: parsed.flag('last-failed'),
  }
}

/**
 * Checks the files and the selection flags, and reads them into what the runner takes. Every check happens here,
 * before anything starts.
 *
 * @example readTestScope({ cwd, positionals: ['tests/a.retest.ts:7'], config, flags })
 */
export function readTestScope(request: ScopeRequest): TestScope {
  const { cwd, config, flags } = request
  const named = request.positionals.length > 0
  if (!named && config === undefined) {
    throw new UsageError(`Name at least one test file, such as examples/task${testFileSuffix}.`)
  }
  const { files, locations } = named ? readFileArguments(cwd, request.positionals) : { files: everyTestFile(cwd), locations: [] }
  const lastFailed = flags.lastFailed ? readLastFailed(cwd) : undefined
  const selection: Selection = {
    ...(flags.grep === undefined ? {} : { grep: parseGrep(flags.grep) }),
    ...(flags.tag === undefined ? {} : { tags: readTags(flags.tag, config) }),
    ...(locations.length === 0 ? {} : { locations }),
    ...(lastFailed === undefined ? {} : { lastFailed }),
    ...(flags.targets.length === 0 ? {} : { targets: readTargets(flags.targets, config) }),
  }
  const scoped = named || lastFailed === undefined ? files : filesWithTests(files, lastFailed)
  return Object.keys(selection).length === 0 ? { files: scoped } : { files: scoped, selection }
}

/**
 * `--grep` as text, or as a pattern when written `/pattern/flags`. The `g` and `y` flags make a pattern
 * remember where it last matched, so they are refused.
 *
 * @example parseGrep('/^cart > .*total$/i') // /^cart > .*total$/i
 */
function parseGrep(text: string): string | RegExp {
  const match = /^\/(.+)\/([a-z]*)$/s.exec(text)
  if (match === null) return text
  const [, pattern = '', flags = ''] = match
  if (/[gy]/.test(flags)) {
    throw new UsageError(`--grep ${text}: leave out the g and y flags, which change what a pattern matches from one test to the next.`)
  }
  try {
    return new RegExp(pattern, flags)
  } catch (error) {
    throw new UsageError(`--grep ${text} is not a valid pattern: ${errorMessage(error)}.`)
  }
}

/**
 * What a selection was made from, as a person wrote it, for a message that says nothing matched.
 *
 * @example describeSelection(flags, [{ file: 'a.retest.ts', line: 7 }]) // ['--tag "smoke"', 'a.retest.ts:7']
 */
export function describeSelection(flags: SelectionArguments, locations: readonly FileLine[] = []): string[] {
  return [
    ...(flags.grep === undefined ? [] : [`--grep ${JSON.stringify(flags.grep)}`]),
    ...(flags.tag === undefined ? [] : [`--tag ${JSON.stringify(flags.tag)}`]),
    ...flags.targets.map((target) => `--target ${target}`),
    ...locations.map(formatLine),
    ...(flags.lastFailed ? ['--last-failed'] : []),
  ]
}

function readTags(text: string, config: LoadedConfig | undefined): TagExpression {
  try {
    return parseTagExpression(text, config?.tags)
  } catch (error) {
    if (!(error instanceof TagExpressionError)) throw error
    throw new UsageError(`--tag: ${error.message}\n  ${text}\n  ${' '.repeat(error.index)}^`)
  }
}

function readTargets(texts: readonly string[], config: LoadedConfig | undefined): Record<string, string> {
  if (config === undefined) throw new UsageError('--target picks a target from the config. With --browser there is one browser.')
  return parseTargets(texts, config)
}

/**
 * The tests `.retest/last-run.json` says the last run did not pass. A missing or unreadable record, or one
 * with nothing to run again, stops the command with the reason.
 */
function readLastFailed(root: string): LastRunTest[] {
  const text = readTextIfPresent(join(root, lastRunFile))
  if (text === undefined) throw new UsageError(`--last-failed reads ${lastRunFile}, which is not there yet. Run the tests once first.`)
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new CliError(`${lastRunFile} is not valid JSON. Run the tests again to write it anew.`)
  }
  const parsed = parse(lastRunSchema, json)
  if (!parsed.ok) throw new CliError(`${lastRunFile} is not a record Retest wrote. Run the tests again to write it anew.`)
  if (parsed.value.tests.length === 0) throw new CliError('The last run passed every test it ran, so --last-failed has nothing to run.')
  return parsed.value.tests
}

// Only the files that hold a test the last run did not pass need collecting.
function filesWithTests(files: readonly string[], tests: readonly LastRunTest[]): string[] {
  const kept = files.filter((file) => tests.some((test) => test.testId.startsWith(`${file} > `)))
  if (kept.length > 0) return kept
  throw new CliError('The tests the last run did not pass are in no test file here any more. Run the tests again.')
}
