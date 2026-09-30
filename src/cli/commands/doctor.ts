import type { LoadedConfig } from '../../config/loaded.ts'
import type { Command } from '../command.ts'
import type { Check } from '../doctor/checks.ts'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { doctorFolder } from '../../protocol/run-folder.ts'
import { defaultTimeouts, mergeTimeouts } from '../../protocol/timeouts.ts'
import { retestCommand } from '../../reporters/commands.ts'
import { plural } from '../../reporters/format.ts'
import { createStyle, type Style } from '../../reporters/style.ts'
import { interruptedExitCode } from '../../runner/outcome.ts'
import { parseArguments, value } from '../arguments.ts'
import { defaultConfigFile, findConfig, missingConfig } from '../config-file.ts'
import { runChecks } from '../doctor/checks.ts'
import { UsageError } from '../errors.ts'
import { shouldUseColor } from '../terminal.ts'

const options = {
  config: value({ placeholder: '<path>', description: `Config file. Default: ${defaultConfigFile}` }),
}

const subjectColumn = 25

export const doctorCommand: Command = {
  name: 'doctor',
  usage: '[options]',
  summary: 'Check that every browser and app in the config is ready',
  description: [
    `Loads ${defaultConfigFile}, launches each target's browser once and closes it, and checks that each app answers.`,
    'An app with start is started and stopped again, unless it is already running. Secrets read from the environment',
    'must be set. A target with a proxy shows its address; the proxy itself is not checked.',
    'Each problem comes with its fix. No test runs.',
    'When a fix points to a log, the logs stay in .retest/doctor. Otherwise they are removed.',
  ].join('\n'),
  options,
  notes: 'Exit codes: 0 everything is ready, 2 something is not, 130 interrupted, 143 stopped by SIGTERM.',
  async run(args, dependencies) {
    const parsed = parseArguments(options, args)
    if (parsed.positionals.length > 0) throw new UsageError(`doctor takes no files, received ${parsed.positionals.join(' ')}.`)
    const config = await findConfig({ cwd: dependencies.cwd, given: parsed.value('config') }, dependencies)
    if (config === undefined) throw missingConfig('doctor checks the browsers and apps in a config.')
    const timeouts = mergeTimeouts(defaultTimeouts, config.timeouts)
    const logFolder = resolve(dependencies.cwd, doctorFolder(new Date()))
    const checks = await runChecks(config, { dependencies, timeouts, logFolder })
    const problems = checks.filter((check) => !check.ok).length
    if (dependencies.signal.aborted || !pointsInto(checks, logFolder)) removeLogs(logFolder)
    if (dependencies.signal.aborted) return interruptedExitCode(dependencies.signal)
    const style = createStyle(shouldUseColor(dependencies.stdout, dependencies.env))
    dependencies.stdout.write(renderChecks(checks, config, style))
    return problems === 0 ? 0 : 2
  },
}

// The logs are kept only when a problem or its fix names a file among them.
function pointsInto(checks: readonly Check[], folder: string): boolean {
  return checks.some((check) => !check.ok && [check.text, check.fix].some((line) => line?.includes(folder) === true))
}

// The browsers and servers make the folder as they write to it, so an empty folder of doctor runs goes with it.
function removeLogs(folder: string): void {
  rmSync(folder, { recursive: true, force: true })
  const runs = dirname(folder)
  if (existsSync(runs) && readdirSync(runs).length === 0) rmSync(runs, { recursive: true, force: true })
}

function renderChecks(checks: readonly Check[], config: LoadedConfig, style: Style): string {
  const groupWidth = Math.max(...checks.map((check) => check.group.length)) + 3
  const subjectWidth = Math.max(subjectColumn, ...checks.map((check) => check.subject.length + 3))
  const detailed = checks.filter((check) => check.detail !== undefined)
  const textWidth = Math.max(0, ...detailed.map((check) => check.text.length + 3))
  const fixIndent = ' '.repeat(2 + groupWidth + subjectWidth + 2)
  const lines: string[] = []
  let group: string | undefined
  for (const check of checks) {
    const shownGroup = check.group === group ? '' : check.group
    group = check.group
    const mark = check.ok ? style.green('✓') : style.red('✗')
    const text = check.detail === undefined ? check.text : `${check.text.padEnd(textWidth)}${style.dim(check.detail)}`
    lines.push(`  ${style.cyan(shownGroup.padEnd(groupWidth))}${check.subject.padEnd(subjectWidth)}${mark} ${text}`)
    if (check.fix !== undefined) lines.push(`${fixIndent}${check.fix}`)
  }
  const problems = checks.filter((check) => !check.ok).length
  const targets = [...config.apps.values()].reduce((sum, app) => sum + app.targets.size, 0)
  const summary =
    problems === 0
      ? `Ready. ${plural(config.apps.size, 'app')}, ${plural(targets, 'target')}.`
      : `${plural(problems, 'problem')}. Fix ${problems === 1 ? 'it' : 'them'} and run ${retestCommand} doctor again.`
  return `\n${lines.join('\n')}\n\n  ${problems === 0 ? summary : style.red(summary)}\n`
}
