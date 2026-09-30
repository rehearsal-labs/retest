import type { LoadedConfig } from '../../config/loaded.ts'
import type { RunResult } from '../../protocol/result.ts'
import type { Reporter } from '../../reporters/reporter.ts'
import type { ChildOutput, RunApps, RunOptions } from '../../runner/contract.ts'
import type { CliDependencies, Command } from '../command.ts'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { defaultRunFolder } from '../../protocol/run-folder.ts'
import { defaultTimeouts, formatTimeouts, mergeTimeouts, parseTimeouts, type Timeouts } from '../../protocol/timeouts.ts'
import { createAgentReporter } from '../../reporters/agent.ts'
import { retestCommand } from '../../reporters/commands.ts'
import { createHumanReporter } from '../../reporters/human.ts'
import { createJsonlReporter } from '../../reporters/jsonl.ts'
import { createStyle } from '../../reporters/style.ts'
import { interruptedExitCode } from '../../runner/outcome.ts'
import { resolveSecrets } from '../../runner/secrets.ts'
import { listWords } from '../../shared/list-words.ts'
import { isCodingAgent } from '../agent-detection.ts'
import { flag, list, parseArguments, value, type ParsedArguments } from '../arguments.ts'
import { configBaseUrls, singleBaseUrl } from '../base-urls.ts'
import { defaultConfigFile, findConfig } from '../config-file.ts'
import { CliError, UsageError } from '../errors.ts'
import { statIfPresent } from '../file-system.ts'
import { readTestScope, selectionArguments, selectionOptions } from '../selection.ts'
import { shouldUseColor } from '../terminal.ts'

const reporterNames = ['human', 'jsonl', 'agent'] as const
type ReporterName = (typeof reporterNames)[number]

const timeoutList = formatTimeouts(defaultTimeouts)

const options = {
  config: value({ placeholder: '<path>', description: `Config file. Default: ${defaultConfigFile}` }),
  browser: value({
    placeholder: '<path>',
    description: 'Run without a config, in this Chromium or Chrome executable.\nNot allowed when a config exists',
  }),
  'base-url': list({
    placeholder: '<url>',
    description: 'Address relative page.goto paths resolve against.\nWith a config, app=url sets one app. Repeat for other apps',
  }),
  ...selectionOptions,
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
  headed: flag('Show every browser window'),
  agent: flag('Print the short report for coding agents'),
  'no-agent': flag('Print the report for people, even when a coding agent is detected'),
}

export const runCommand: Command = {
  name: 'run',
  usage: '[files...] [options]',
  summary: 'Run the tests in each file',
  description: [
    `Runs the tests with the apps and browsers in ${defaultConfigFile}, one file after another.`,
    'With no files, it runs every .retest.ts file under this folder. Add :line to a file to run the test on that line.',
    'Add #row after the line to run one row of a test.for, counted from 1, such as a.retest.ts:12#2.',
    'Without a config, --browser runs the named files in one browser.',
    'The run folder keeps events.jsonl, result.json, logs and screenshots.',
    'When a coding agent is detected, the short agent report is printed unless you pick --reporter or --no-agent.',
  ].join('\n'),
  options,
  notes:
    'Exit codes: 0 every test passed, 1 a test failed its checks, 2 the run could not check everything, 130 interrupted, 143 stopped by SIGTERM.',
  async run(args, dependencies) {
    const plan = await planRun(parseArguments(options, args), dependencies)
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
type Parsed = ParsedArguments<typeof options>

// Every check happens here, before the runner starts, so a bad command line never begins a run.
async function planRun(parsed: Parsed, dependencies: CliDependencies): Promise<RunPlan> {
  const { cwd } = dependencies
  const mode = await chooseMode(parsed, dependencies)
  const config = mode.kind === 'config' ? mode.config : undefined
  const scope = readTestScope({ cwd, positionals: parsed.positionals, config, flags: selectionArguments(parsed) })
  const commandLineTimeouts = readTimeouts(parsed.value('timeouts'))
  const reporter = chooseReporter({
    reporter: parsed.value('reporter'),
    agent: parsed.flag('agent'),
    noAgent: parsed.flag('no-agent'),
    detected: isCodingAgent(dependencies.env),
  })
  const runFolder = parsed.value('output') ?? defaultRunFolder(new Date())
  const outputDir = resolve(cwd, runFolder)
  checkRunFolder(runFolder, outputDir)
  const apps = mode.kind === 'config' ? configApps(parsed, mode.config, dependencies) : browserApps(parsed, mode.browser, cwd)
  const runOptions: RunOptions = {
    files: scope.files,
    rootDir: cwd,
    apps,
    timeouts: mergeTimeouts(defaultTimeouts, config?.timeouts ?? {}, commandLineTimeouts),
    commandLineTimeouts,
    outputDir,
    headless: !parsed.flag('headed'),
    ...(scope.selection === undefined ? {} : { selection: scope.selection }),
    signal: dependencies.signal,
  }
  return { options: runOptions, reporter, runFolder }
}

type Mode = { kind: 'browser'; browser: string } | { kind: 'config'; config: LoadedConfig }

// A config and --browser are two ways to say what to run in, so only one may be given.
async function chooseMode(parsed: Parsed, dependencies: CliDependencies): Promise<Mode> {
  const given = parsed.value('config')
  const browser = parsed.value('browser')
  if (browser === undefined) {
    const config = await findConfig({ cwd: dependencies.cwd, given }, dependencies)
    if (config !== undefined) return { kind: 'config', config }
    throw new UsageError(
      `No ${defaultConfigFile} here. Run ${retestCommand} init to write one, or pass --browser <path> to run without a config.`,
    )
  }
  if (given !== undefined) throw new UsageError('--browser runs without a config, so it cannot go with --config.')
  if (statIfPresent(resolve(dependencies.cwd, defaultConfigFile)) !== undefined) {
    throw new UsageError(`--browser runs without a config, but ${defaultConfigFile} is here. Leave out --browser to use its targets.`)
  }
  return { kind: 'browser', browser }
}

function browserApps(parsed: Parsed, browser: string, cwd: string): RunApps {
  const baseUrl = singleBaseUrl(parsed.list('base-url'))
  return { kind: 'browser', browserPath: resolve(cwd, browser), ...(baseUrl === undefined ? {} : { baseUrl }) }
}

function configApps(parsed: Parsed, config: LoadedConfig, dependencies: CliDependencies): RunApps {
  const baseUrls = configBaseUrls(parsed.list('base-url'), config)
  const secrets = resolveSecrets(config.secrets, dependencies.env)
  if (!secrets.ok) throw new CliError(secrets.failure.message)
  return { kind: 'config', config, ...(baseUrls === undefined ? {} : { baseUrls }), secrets: secrets.secrets }
}

function readTimeouts(text: string | undefined): Partial<Timeouts> {
  if (text === undefined) return {}
  const parsed = parseTimeouts(text)
  if (!parsed.ok) throw new UsageError(`--timeouts: ${parsed.failure.message}`)
  return parsed.value
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
