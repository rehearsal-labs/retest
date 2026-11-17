import type { LoadedChromiumTarget } from '../../config/loaded.ts'
import type { ExitCode } from '../../protocol/events.ts'
import type { CliDependencies, Command } from '../command.ts'
import type { AnswerDefaults, AnswerFlags } from '../init/answers.ts'
import type { InstallEnd } from '../init/package-install.ts'
import type { InstallCommand, PackageManager } from '../init/package-manager.ts'
import type { FileChange, PackageJson } from '../init/project-files.ts'
import type { InitReport } from '../init/report.ts'
import type { InitAnswers } from '../init/templates.ts'
import { join } from 'node:path'
import { browserNames } from '../../config/types.ts'
import { createStyle } from '../../reporters/style.ts'
import { interruptedExitCode } from '../../runner/outcome.ts'
import { listWords } from '../../shared/list-words.ts'
import { isCodingAgent } from '../agent-detection.ts'
import { flag, parseArguments, value, type ParsedArguments } from '../arguments.ts'
import { defaultConfigFile } from '../config-file.ts'
import { UsageError } from '../errors.ts'
import { statIfPresent } from '../file-system.ts'
import { chooseInstall, gatherAnswers, readApp } from '../init/answers.ts'
import { detectPackageManager, installCommand } from '../init/package-manager.ts'
import { createFile, ignoreRunFolders, missingPackages, readPackageJson, updatePackageJson } from '../init/project-files.ts'
import { renderChanges, renderInitReport } from '../init/report.ts'
import { configSource, exampleTestFile, exampleTestSource, packageName, projectPackages, testTsconfigFile, testTsconfigSource, workflowFile, workflowSource } from '../init/templates.ts'
import { shouldUseColor } from '../terminal.ts'

const options = {
  app: value({ placeholder: '<name=url>', description: 'The app the tests open, such as web=http://localhost:3000' }),
  start: value({ placeholder: '<command>', description: 'The command that starts the app, such as "npm run dev"' }),
  browser: value({ placeholder: '<name>', description: `The browser: ${listWords(browserNames)}`, choices: browserNames }),
  ci: value({ placeholder: '<name>', description: 'Also write a workflow for this CI. The one there is: github', choices: ['github'] }),
  install: flag("Run the package manager's install without asking"),
  'no-install': flag('Leave the install to you, and print its command'),
  yes: flag('Ask nothing, and take the default for each question without a flag'),
}

export const initCommand: Command = {
  name: 'init',
  usage: '[options]',
  summary: 'Set up a project: a config, an example test, a tsconfig and the packages',
  description: [
    `Writes ${defaultConfigFile}, ${exampleTestFile} and ${testTsconfigFile}, adds the test:e2e and typecheck:e2e`,
    'scripts to package.json, and adds .retest/ to .gitignore. A file that is already there is left as is.',
    `It adds ${packageName}, typescript and @types/node to devDependencies when package.json does not list them,`,
    "creating package.json when there is none, and then runs the package manager's install, such as npm install.",
    'It asks questions only at a terminal where no coding agent is detected; each question has a flag.',
  ].join('\n'),
  options,
  notes: 'Exit codes: 0 the files are in place, 2 a flag or a file is wrong, a question had no answer or the install failed, 130 interrupted, 143 stopped by SIGTERM.',
  async run(args, dependencies) {
    const parsed = parseArguments(options, args)
    const flags = answerFlags(parsed)
    const installFlag = readInstallFlag(parsed)
    const { cwd, stdout } = dependencies
    const style = createStyle(shouldUseColor(stdout, dependencies.env))
    const packageJson = readPackageJson(cwd)
    const manager = detectPackageManager({ folder: cwd, declared: stringField(packageJson, 'packageManager'), userAgent: dependencies.env['npm_config_user_agent'] })
    const command = installCommand(manager, process.platform)
    const packages = missingPackages(packageJson, projectPackages(dependencies.version))
    const added = Object.keys(packages)
    const configExists = statIfPresent(join(cwd, defaultConfigFile)) !== undefined
    const interactive = dependencies.prompt.isTTY && stdout.isTTY && !isCodingAgent(dependencies.env) && !flags.yes
    stdout.write(`\n  ${style.bold(`Retest ${dependencies.version}`)}\n\n`)
    const answers = configExists ? undefined : await askAnswers(flags, { packageJson, manager, dependencies, interactive })
    if (!configExists && answers === undefined) return stopped(dependencies)
    // The install is asked about only when init adds a package; --install runs it even when it adds none.
    const installing = added.length === 0 ? installFlag === true : await chooseInstall({ flag: installFlag, yes: flags.yes, command: command.text, packages: added, prompt: dependencies.prompt, interactive })
    if (installing === undefined) return stopped(dependencies)
    if (interactive && (!configExists || (added.length > 0 && installFlag === undefined))) stdout.write('\n')
    const config: FileChange =
      answers === undefined ? { path: defaultConfigFile, change: 'left as is' } : createFile(cwd, defaultConfigFile, configSource(answers))
    const changes = [
      config,
      createFile(cwd, exampleTestFile, exampleTestSource),
      createFile(cwd, testTsconfigFile, testTsconfigSource(projectTsconfig(cwd))),
      ...(parsed.value('ci') === 'github' ? [workflowChange(createFile(cwd, workflowFile, workflowSource), manager)] : []),
      ...updatePackageJson(cwd, packageJson, packages),
      ignoreRunFolders(cwd),
    ]
    stdout.write(renderChanges(changes, style))
    const report: Omit<InitReport, 'install'> = { changes, unused: configExists ? unusedFlags(flags) : [], answers, packageJson, manager, style }
    if (installing) return install({ report, command, dependencies })
    stdout.write(renderInitReport({ ...report, install: { state: added.length === 0 ? 'not needed' : 'to do', command } }))
    return 0
  },
}

// The project's own tsconfig, as the tests' tsconfig extends it from the test folder.
function projectTsconfig(cwd: string): string | undefined {
  return statIfPresent(join(cwd, 'tsconfig.json'))?.isFile() === true ? '../tsconfig.json' : undefined
}

type AskContext = { packageJson: PackageJson | undefined; manager: PackageManager; dependencies: CliDependencies; interactive: boolean }

async function askAnswers(flags: AnswerFlags, context: AskContext): Promise<InitAnswers | undefined> {
  const { dependencies } = context
  const start = startCommand(context.packageJson, context.manager)
  const defaults: AnswerDefaults = {
    url: 'http://localhost:3000',
    ...(start === undefined ? {} : { start }),
    ...(flags.browser === undefined ? foundBrowser(dependencies) : { browser: flags.browser }),
  }
  return gatherAnswers({ flags, defaults, prompt: dependencies.prompt, interactive: context.interactive })
}

type InstallStep = { report: Omit<InitReport, 'install'>; command: InstallCommand; dependencies: CliDependencies }

// The package manager writes to the terminal itself, between the files and the next steps. The files stay whatever
// becomes of it, and a failure names the command to run by hand.
async function install({ report, command, dependencies }: InstallStep): Promise<ExitCode> {
  const { stdout, stderr, signal } = dependencies
  stdout.write(`\n  Running ${command.text}\n`)
  const end = await dependencies.runInstall({ command, cwd: dependencies.cwd, signal })
  if (signal.aborted) {
    stderr.write(`Stopped during ${command.text}. The files are written; run ${command.text} to install the packages.\n`)
    return interruptedExitCode(signal)
  }
  const problem = installProblem(end)
  stdout.write(renderInitReport({ ...report, install: { state: problem === undefined ? 'installed' : 'to do', command } }))
  if (problem === undefined) return 0
  stderr.write(`${command.text} ${problem}. The files are written; run ${command.text} yourself to install the packages.\n`)
  return 2
}

function installProblem(end: InstallEnd): string | undefined {
  if (end.kind === 'not started') return `could not start: ${end.problem}`
  if (end.kind === 'signalled') return `was ended by ${end.signal}`
  return end.code === 0 ? undefined : `failed with exit code ${end.code}`
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

// --install answers the install question yes, --no-install no, and neither leaves it to be asked.
function readInstallFlag(parsed: ParsedArguments<typeof options>): boolean | undefined {
  const install = parsed.flag('install')
  const skip = parsed.flag('no-install')
  if (install && skip) throw new UsageError('--install and --no-install answer the same question. Give one of them.')
  if (install) return true
  return skip ? false : undefined
}
