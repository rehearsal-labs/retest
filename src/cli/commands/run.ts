import type { RunResult } from '../../protocol/result.ts'
import type { Reporter } from '../../reporters/reporter.ts'
import type { ChildOutput, RunOptions } from '../../runner/contract.ts'
import type { CliDependencies, Command } from '../command.ts'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { defaultRunFolder } from '../../protocol/run-folder.ts'
import { defaultTimeouts, parseTimeouts, type Timeouts } from '../../protocol/timeouts.ts'
import { createAgentReporter } from '../../reporters/agent.ts'
import { createHumanReporter } from '../../reporters/human.ts'
import { createJsonlReporter } from '../../reporters/jsonl.ts'
import { createStyle } from '../../reporters/style.ts'
import { interruptedExitCode } from '../../runner/outcome.ts'
import { isCodingAgent } from '../agent-detection.ts'
import { flag, listWords, parseArguments, value, type ParsedArguments } from '../arguments.ts'
import { CliError, UsageError } from '../errors.ts'
import { statIfPresent } from '../file-system.ts'
import { shouldUseColor } from '../terminal.ts'
import { resolveTestFiles } from '../test-files.ts'

const reporterNames = ['human', 'jsonl', 'agent'] as const
type ReporterName = (typeof reporterNames)[number]

const timeoutList = Object.entries(defaultTimeouts)
  .map(([name, milliseconds]) => `${name}=${milliseconds}`)
  .join(',')

const options = {
  browser: value({ placeholder: '<path>', description: 'Chromium or Chrome executable to launch. Required.' }),
  'base-url': value({ placeholder: '<url>', description: 'Address that relative page.goto paths resolve against' }),
  reporter: value({
    placeholder: '<name>',
    description: `Terminal output: ${listWords(reporterNames)}. jsonl prints only event lines`,
    choices: reporterNames,
  }),
  output: value({ placeholder: '<dir>', description: 'New folder for the run. Default: .retest/runs/<time>' }),
  timeouts: value({
    placeholder: '<list>',
    description: `Budgets in milliseconds, such as action=500,test=3000.\nDefaults: ${timeoutList}`,
  }),
  headed: flag('Show the browser window'),
  agent: flag('Print the short report for coding agents'),
  'no-agent': flag('Print the report for people, even when a coding agent is detected'),
}

export const runCommand: Command = {
  name: 'run',
  usage: '<files...> --browser <path> [options]',
  summary: 'Run the tests in each file in Chromium',
  description: [
    'Runs the tests in each file, one file after another, in a Chromium browser launched for this run.',
    'Files end in .retest.ts. Pass files, not folders.',
    'The run folder keeps events.jsonl, result.json, logs and screenshots.',
    'When a coding agent is detected, the short agent report is printed unless you pick --reporter or --no-agent.',
  ].join('\n'),
  options,
  notes:
    'Exit codes: 0 every test passed, 1 a test failed its checks, 2 the run could not check everything, 130 interrupted, 143 stopped by SIGTERM.',
  async run(args, dependencies) {
    const plan = planRun(parseArguments(options, args), dependencies)
    const { reporter, onOutput } = createReporter(plan.reporter, plan.runFolder, dependencies)
    const watched = watchRunEnd(reporter)
    const runOptions = { ...plan.options, ...(onOutput === undefined ? {} : { onOutput }) }
    const result = await dependencies.runFiles(runOptions, [watched.reporter])
    const unseen = result.failure
    if (unseen !== undefined && !isDeepStrictEqual(unseen, watched.shown()?.failure)) {
      const label = createStyle(shouldUseColor(dependencies.stderr, dependencies.env)).red('error')
      dependencies.stderr.write(`${label}: ${unseen.message}\n`)
    }
    return dependencies.signal.aborted ? interruptedExitCode(dependencies.signal) : result.exitCode
  },
}

type WatchedReporter = { reporter: Reporter; shown: () => RunResult | undefined }

// A failure after the reporter's last call, such as a result.json that could not be written, or a
// reporter that broke, would otherwise end the run without a word.
function watchRunEnd(reporter: Reporter): WatchedReporter {
  let shown: RunResult | undefined
  return {
    reporter: {
      name: reporter.name,
      onEvent: (event) => reporter.onEvent(event),
      onRunEnd: (result) => {
        shown = result
        return reporter.onRunEnd(result)
      },
    },
    shown: () => shown,
  }
}

type RunPlan = { options: RunOptions; reporter: ReporterName; runFolder: string }

// Every check happens here, before the runner starts, so a bad command line never begins a run.
function planRun(parsed: ParsedArguments<typeof options>, dependencies: CliDependencies): RunPlan {
  const { cwd } = dependencies
  const files = resolveTestFiles(cwd, parsed.positionals)
  const browser = parsed.value('browser')
  if (browser === undefined) throw new UsageError('Name the browser to run in: --browser <path>.')
  const baseUrl = checkBaseUrl(parsed.value('base-url'))
  const timeouts = readTimeouts(parsed.value('timeouts'))
  const reporter = chooseReporter({
    reporter: parsed.value('reporter'),
    agent: parsed.flag('agent'),
    noAgent: parsed.flag('no-agent'),
    detected: isCodingAgent(dependencies.env),
  })
  const runFolder = parsed.value('output') ?? defaultRunFolder(new Date())
  const outputDir = resolve(cwd, runFolder)
  checkRunFolder(runFolder, outputDir)
  const runOptions: RunOptions = {
    files,
    rootDir: cwd,
    browserPath: resolve(cwd, browser),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    timeouts,
    outputDir,
    headless: !parsed.flag('headed'),
    signal: dependencies.signal,
  }
  return { options: runOptions, reporter, runFolder }
}

function checkBaseUrl(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const url = URL.parse(text)
  if (url?.protocol === 'http:' || url?.protocol === 'https:') return text
  throw new UsageError(
    `--base-url must be a full http or https address, such as http://127.0.0.1:4173, received ${JSON.stringify(text)}.`,
  )
}

function readTimeouts(text: string | undefined): Timeouts {
  if (text === undefined) return { ...defaultTimeouts }
  const parsed = parseTimeouts(text)
  if (!parsed.ok) throw new UsageError(`--timeouts: ${parsed.failure.message}`)
  return { ...defaultTimeouts, ...parsed.value }
}

type ReporterChoice = { reporter: string | undefined; agent: boolean; noAgent: boolean; detected: boolean }

function chooseReporter(choice: ReporterChoice): ReporterName {
  if (choice.agent && choice.noAgent) throw new UsageError('Use --agent or --no-agent, not both.')
  const named = reporterNames.find((name) => name === choice.reporter)
  if (named !== undefined && named !== 'agent' && choice.agent) {
    throw new UsageError(`--agent prints the agent report, so it cannot go with --reporter ${named}.`)
  }
  if (named === 'agent' && choice.noAgent) {
    throw new UsageError('--no-agent turns the agent report off, so it cannot go with --reporter agent.')
  }
  if (named !== undefined) return named
  if (choice.agent) return 'agent'
  return choice.detected && !choice.noAgent ? 'agent' : 'human'
}

// The runner guards this too, but stopping before any work is clearer.
function checkRunFolder(runFolder: string, outputDir: string): void {
  const stats = statIfPresent(outputDir)
  if (stats === undefined) return
  if (!stats.isDirectory()) throw new CliError(`${runFolder} is a file. Choose a new folder with --output.`)
  if (readdirSync(outputDir).length > 0) {
    throw new CliError(
      `${runFolder} already holds files. Retest never writes over a run; choose a new folder with --output.`,
    )
  }
}

type ChosenReporter = { reporter: Reporter; onOutput?: (output: ChildOutput) => void }

function createReporter(name: ReporterName, runFolder: string, dependencies: CliDependencies): ChosenReporter {
  const { stdout, stderr } = dependencies
  if (name === 'jsonl') return { reporter: createJsonlReporter({ stdout }) }
  if (name === 'agent') return { reporter: createAgentReporter({ stdout, runFolder }) }
  const human = createHumanReporter({ stdout, stderr, color: shouldUseColor(stdout, dependencies.env), runFolder })
  return { reporter: human, onOutput: (output) => human.onOutput(output) }
}
