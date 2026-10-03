import type { LoadedChromiumTarget } from '../../config/loaded.ts'
import type { CliDependencies, Command } from '../command.ts'
import type { AnswerDefaults, AnswerFlags } from '../init/answers.ts'
import type { PackageManager } from '../init/package-manager.ts'
import type { FileChange, PackageJson } from '../init/project-files.ts'
import type { InitAnswers } from '../init/templates.ts'
import { join } from 'node:path'
import { browserNames } from '../../config/types.ts'
import { createStyle } from '../../reporters/style.ts'
import { interruptedExitCode } from '../../runner/outcome.ts'
import { listWords } from '../../shared/list-words.ts'
import { isCodingAgent } from '../agent-detection.ts'
import { flag, parseArguments, value, type ParsedArguments } from '../arguments.ts'
import { defaultConfigFile } from '../config-file.ts'
import { statIfPresent } from '../file-system.ts'
import { gatherAnswers, readApp } from '../init/answers.ts'
import { detectPackageManager } from '../init/package-manager.ts'
import { addScripts, createFile, ignoreRunFolders, readPackageJson } from '../init/project-files.ts'
import { renderInitReport } from '../init/report.ts'
import { configSource, exampleTestFile, exampleTestSource, testTsconfigFile, testTsconfigSource, workflowFile, workflowSource } from '../init/templates.ts'
import { shouldUseColor } from '../terminal.ts'

const options = {
  app: value({ placeholder: '<name=url>', description: 'The app the tests open, such as web=http://localhost:3000' }),
  start: value({ placeholder: '<command>', description: 'The command that starts the app, such as "npm run dev"' }),
  browser: value({ placeholder: '<name>', description: `The browser: ${listWords(browserNames)}`, choices: browserNames }),
  ci: value({ placeholder: '<name>', description: 'Also write a workflow for this CI. The one there is: github', choices: ['github'] }),
  yes: flag('Ask nothing, and take the default for each question without a flag'),
}

export const initCommand: Command = {
  name: 'init',
  usage: '[options]',
  summary: 'Write a config, an example test and a tsconfig',
  description: [
    `Writes ${defaultConfigFile}, ${exampleTestFile} and ${testTsconfigFile}, adds the test:e2e and typecheck:e2e`,
    'scripts to package.json, and adds .retest/ to .gitignore. A file that is already there is left as is.',
    'It asks questions only at a terminal where no coding agent is detected; each question has a flag.',
    'It installs nothing, and prints the install command.',
  ].join('\n'),
  options,
  notes: 'Exit codes: 0 the files are in place, 2 a flag or a file is wrong or a question had no answer, 130 interrupted.',
  async run(args, dependencies) {
    const parsed = parseArguments(options, args)
    const flags = answerFlags(parsed)
    const { cwd, stdout } = dependencies
    const style = createStyle(shouldUseColor(stdout, dependencies.env))
    const packageJson = readPackageJson(cwd)
    const manager = detectPackageManager(cwd, stringField(packageJson, 'packageManager'))
    const configExists = statIfPresent(join(cwd, defaultConfigFile)) !== undefined
    stdout.write(`\n  ${style.bold(`Retest ${dependencies.version}`)}\n\n`)
    const answers = configExists ? undefined : await askAnswers(flags, { packageJson, manager, dependencies })
    if (!configExists && answers === undefined) return stopped(dependencies)
    const config: FileChange =
      answers === undefined ? { path: defaultConfigFile, change: 'left as is' } : createFile(cwd, defaultConfigFile, configSource(answers))
    const changes = [
      config,
      createFile(cwd, exampleTestFile, exampleTestSource),
      createFile(cwd, testTsconfigFile, testTsconfigSource(projectTsconfig(cwd))),
      ...(parsed.value('ci') === 'github' ? [workflowChange(createFile(cwd, workflowFile, workflowSource), manager)] : []),
      ...addScripts(cwd, packageJson),
      ignoreRunFolders(cwd),
    ]
    const unused = configExists ? unusedFlags(flags) : []
    stdout.write(renderInitReport({ changes, unused, answers, packageJson, manager, style }))
    return 0
  },
}

// The project's own tsconfig, as the tests' tsconfig extends it from the test folder.
function projectTsconfig(cwd: string): string | undefined {
  return statIfPresent(join(cwd, 'tsconfig.json'))?.isFile() === true ? '../tsconfig.json' : undefined
}

type AskContext = { packageJson: PackageJson | undefined; manager: PackageManager; dependencies: CliDependencies }

async function askAnswers(flags: AnswerFlags, context: AskContext): Promise<InitAnswers | undefined> {
  const { dependencies } = context
  const interactive =
    dependencies.prompt.isTTY && dependencies.stdout.isTTY && !isCodingAgent(dependencies.env) && !flags.yes
  const start = startCommand(context.packageJson, context.manager)
  const defaults: AnswerDefaults = {
    url: 'http://localhost:3000',
    ...(start === undefined ? {} : { start }),
    ...(flags.browser === undefined ? foundBrowser(dependencies) : { browser: flags.browser }),
  }
  const answers = await gatherAnswers({ flags, defaults, prompt: dependencies.prompt, interactive })
  if (interactive && answers !== undefined) dependencies.stdout.write('\n')
  return answers
}

function stopped(dependencies: CliDependencies): 2 | 130 | 143 {
  const { stderr, signal } = dependencies
  if (signal.aborted) {
    stderr.write('Stopped. Nothing was written.\n')
    return interruptedExitCode(signal)
  }
  stderr.write('A question had no answer, so nothing was written.\n')
  return 2
}

// The first browser installed where Retest looks, so the example runs as written.
function foundBrowser(dependencies: CliDependencies): Pick<AnswerDefaults, 'browser' | 'browserPath'> {
  const candidates: LoadedChromiumTarget[] = [
    { name: 'chrome', browser: 'chrome', channel: 'stable', headless: true },
    { name: 'edge', browser: 'edge', channel: 'stable', headless: true },
    { name: 'chromium', browser: 'chromium', headless: true },
  ]
  for (const target of candidates) {
    const found = dependencies.resolveExecutable(target)
    if (found.ok) return { browser: target.browser, browserPath: found.path }
  }
  return { browser: 'chrome' }
}

function startCommand(packageJson: PackageJson | undefined, manager: PackageManager): string | undefined {
  const scripts = packageJson?.data['scripts']
  const has = (name: string): boolean => typeof scripts === 'object' && scripts !== null && Object.hasOwn(scripts, name)
  const script = ['dev', 'start'].find(has)
  return script === undefined ? undefined : `${manager.runScript} ${script}`
}

function workflowChange(change: FileChange, manager: PackageManager): FileChange {
  if (change.change !== 'created' || manager.name === 'npm') return change
  return { ...change, detail: `uses npm; change its install step for ${manager.name}` }
}

function unusedFlags(flags: AnswerFlags): string[] {
  return [
    ...(flags.app === undefined ? [] : ['--app']),
    ...(flags.start === undefined ? [] : ['--start']),
    ...(flags.browser === undefined ? [] : ['--browser']),
  ]
}

function stringField(packageJson: PackageJson | undefined, field: string): string | undefined {
  const found = packageJson?.data[field]
  return typeof found === 'string' ? found : undefined
}

function answerFlags(parsed: ParsedArguments<typeof options>): AnswerFlags {
  const text = parsed.value('app')
  const app = text === undefined ? undefined : readApp(text)
  const start = parsed.value('start')
  const browser = browserNames.find((name) => name === parsed.value('browser'))
  return {
    ...(app === undefined ? {} : { app }),
    ...(start === undefined ? {} : { start }),
    ...(browser === undefined ? {} : { browser }),
    yes: parsed.flag('yes'),
  }
}
