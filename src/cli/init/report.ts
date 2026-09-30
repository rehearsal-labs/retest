import type { Style } from '../../reporters/style.ts'
import type { PackageManager } from './package-manager.ts'
import type { FileChange, PackageJson } from './project-files.ts'
import type { InitAnswers } from './templates.ts'
import { defaultConfigFile } from '../../reporters/commands.ts'
import { visibleLength } from '../../reporters/style.ts'
import { listWords } from '../../shared/list-words.ts'
import { exampleTestFile, packageName } from './templates.ts'

/** What `init` did and found, for the lines it prints. `unused` are flags a config already there made pointless. */
export type InitReport = {
  changes: readonly FileChange[]
  unused: readonly string[]
  answers: InitAnswers | undefined
  packageJson: PackageJson | undefined
  manager: PackageManager
  style: Style
}

const installed = [packageName, 'typescript', '@types/node']
const nextColumn = 25

/**
 * One line per file, then what the person must do first, then the next commands: the install line when a
 * package is missing, `doctor` and `run`.
 *
 * @example stdout.write(renderInitReport({ changes, unused: [], answers, packageJson, manager, style }))
 */
export function renderInitReport(report: InitReport): string {
  const { style } = report
  const lines = changeLines(report.changes, style)
  const notes = reportNotes(report)
  if (notes.length > 0) lines.push('', ...notes.map((note) => `  ${note}`))
  const steps = nextSteps(report)
  const width = Math.max(nextColumn, ...steps.flatMap(([command, why]) => (why === undefined ? [] : [command.length + 3])))
  const rows = steps.map(([command, why]) => (why === undefined ? `    ${command}` : `    ${command.padEnd(width)}${style.dim(why)}`))
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
  const { unused, packageJson, answers } = report
  const notes: string[] = []
  if (unused.length > 0) {
    notes.push(`${defaultConfigFile} is left as is, so ${listWords(unused, 'and')} ${unused.length === 1 ? 'was' : 'were'} not used.`)
  }
  if (packageJson !== undefined && packageJson.data['type'] !== 'module') {
    notes.push('Add "type": "module" to package.json, so the type check reads the tests as ES modules.')
  }
  if (answers?.browser === 'chromium') {
    notes.push("Set RETEST_CHROMIUM to the browser's path, here and in CI: chromium() runs the browser it points to.")
  }
  return notes
}

function nextSteps(report: InitReport): [string, string?][] {
  const { manager, packageJson } = report
  const missing = installed.filter((name) => !hasDependency(packageJson, name))
  const example = report.changes.some((change) => change.path === exampleTestFile && change.change === 'created')
  const steps: [string, string?][] = missing.length === 0 ? [] : [[`${manager.addDev} ${missing.join(' ')}`]]
  steps.push([`${manager.exec} retest doctor`, 'check the browser and the app'])
  steps.push([`${manager.exec} retest run`, example ? `run ${exampleTestFile}` : 'run the tests'])
  return steps
}

function hasDependency(packageJson: PackageJson | undefined, name: string): boolean {
  return ['dependencies', 'devDependencies'].some((field) => {
    const dependencies = packageJson?.data[field]
    return typeof dependencies === 'object' && dependencies !== null && Object.hasOwn(dependencies, name)
  })
}
