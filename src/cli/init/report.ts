import type { Style } from '../../reporters/style.ts'
import type { InstallCommand, PackageManager } from './package-manager.ts'
import type { FileChange, PackageJson } from './project-files.ts'
import type { InitAnswers } from './templates.ts'
import { defaultConfigFile } from '../../reporters/commands.ts'
import { visibleLength } from '../../reporters/style.ts'
import { listWords } from '../../shared/list-words.ts'
import { exampleTestFile } from './templates.ts'

/**
 * Where the install stands once `init` is done: run and finished; to do, because packages were added and the
 * install did not run or failed; or not needed, because no package was added and none was asked for.
 */
export type InstallState = 'installed' | 'to do' | 'not needed'

/**
 * What `init` did and found, for the lines it prints after the files. `unused` are flags a config already there made
 * pointless, and `packageJson` is package.json as it was before `init`.
 */
export type InitReport = {
  changes: readonly FileChange[]
  unused: readonly string[]
  answers: InitAnswers | undefined
  packageJson: PackageJson | undefined
  manager: PackageManager
  install: { state: InstallState; command: InstallCommand }
  style: Style
}

const nextColumn = 25

/**
 * One line for each change to a file, package.json's scripts and dev dependencies each on a line of their own.
 *
 * @example stdout.write(renderChanges(changes, style)) // '  created  retest.config.ts\n...'
 */
export function renderChanges(changes: readonly FileChange[], style: Style): string {
  return `${changeLines(changes, style).join('\n')}\n`
}

/**
 * What follows the files: whether the packages are installed, what the person must do first, then the next commands:
 * the install when it is still to do, `doctor` and `run`.
 *
 * @example stdout.write(renderInitReport({ changes, unused: [], answers, packageJson, manager, install, style }))
 */
export function renderInitReport(report: InitReport): string {
  const { style } = report
  const lines: string[] = report.install.state === 'installed' ? ['', '  The packages are installed.'] : []
  const notes = reportNotes(report)
  if (notes.length > 0) lines.push('', ...notes.map((note) => `  ${note}`))
  const steps = nextSteps(report)
  const width = Math.max(nextColumn, ...steps.map(([command]) => command.length + 3))
  const rows = steps.map(([command, why]) => `    ${command.padEnd(width)}${style.dim(why)}`)
  lines.push('', `  ${style.bold('Next')}`, ...rows)
  return `${lines.join('\n')}\n`
}

function changeLines(changes: readonly FileChange[], style: Style): string[] {
  const verbWidth = Math.max(...changes.map((change) => change.change.length))
  const pathWidth = Math.max(0, ...changes.filter((change) => change.detail !== undefined).map((change) => change.path.length + 3))
  const paint: Record<FileChange['change'], (text: string) => string> = {
    created: style.green,
    updated: style.yellow,
    'left as is': style.dim,
  }
  return changes.map((change) => {
    const verb = paint[change.change](change.change) + ' '.repeat(verbWidth - visibleLength(change.change))
    const detail = change.detail === undefined ? change.path : `${change.path.padEnd(pathWidth)}${style.dim(change.detail)}`
    return `  ${verb}  ${detail}`
  })
}

// What the person must do before the next steps work, as sentences.
function reportNotes(report: InitReport): string[] {
  const { unused, packageJson, answers, manager } = report
  const notes: string[] = []
  if (unused.length > 0) {
    notes.push(`${defaultConfigFile} is left as is, so ${listWords(unused, 'and')} ${unused.length === 1 ? 'was' : 'were'} not used.`)
  }
  if (packageJson !== undefined && packageJson.data['type'] !== 'module') {
    notes.push('Add "type": "module" to package.json, so Node reads the tests as ES modules without guessing.')
  }
  if (answers?.browser === 'chromium') {
    notes.push(`Run ${manager.exec} retest install chromium here and in CI: chromium() runs what it installs.`)
  }
  return notes
}

function nextSteps(report: InitReport): [string, string][] {
  const { manager, install } = report
  const example = report.changes.some((change) => change.path === exampleTestFile && change.change === 'created')
  const steps: [string, string][] = install.state === 'to do' ? [[install.command.text, 'install the packages in package.json']] : []
  steps.push([`${manager.exec} retest doctor`, 'check the browser and the app'])
  steps.push([`${manager.exec} retest run`, example ? `run ${exampleTestFile}` : 'run the tests'])
  return steps
}
