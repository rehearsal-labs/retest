import type { CollectedTest } from '../../protocol/events.ts'
import type { CollectResult } from '../../runner/contract.ts'
import type { Command } from '../command.ts'
import { formatLocation } from '../../protocol/location.ts'
import { defaultTimeouts, mergeTimeouts } from '../../protocol/timeouts.ts'
import { variantKey } from '../../protocol/variant.ts'
import { plural, titleWithin } from '../../reporters/format.ts'
import { createStyle, visibleLength, type Style } from '../../reporters/style.ts'
import { interruptedExitCode } from '../../runner/outcome.ts'
import { listWords } from '../../shared/list-words.ts'
import { flag, parseArguments, value } from '../arguments.ts'
import { defaultConfigFile, findConfig } from '../config-file.ts'
import { describeSelection, readTestScope, selectionArguments, selectionOptions } from '../selection.ts'
import { shouldUseColor } from '../terminal.ts'

const options = {
  config: value({ placeholder: '<path>', description: `Config file. Default: ${defaultConfigFile}` }),
  ...selectionOptions,
  json: flag('Print one JSON document'),
}

export const listCommand: Command = {
  name: 'list',
  usage: '[files...] [options]',
  summary: 'List the tests in each file without opening a browser',
  description: [
    'Loads each file the way a run does and lists the tests it declares, with their source lines, tags, apps and targets.',
    `With ${defaultConfigFile} and no files, it lists every .retest.ts file under this folder. No browser is launched.`,
    'Each row of a test.for shows its #row. Add it after the line, as in a.retest.ts:12#2, to run that row alone.',
  ].join('\n'),
  options,
  notes: 'Exit codes: 0 tests were found, 2 a file could not be collected, failed outside its tests, or had no tests.',
  async run(args, dependencies) {
    const parsed = parseArguments(options, args)
    const { cwd } = dependencies
    const config = await findConfig({ cwd, given: parsed.value('config') }, dependencies)
    const flags = selectionArguments(parsed)
    const scope = readTestScope({ cwd, positionals: parsed.positionals, config, flags })
    const collected = await dependencies.collectFiles({
      files: scope.files,
      rootDir: cwd,
      timeouts: { collection: mergeTimeouts(defaultTimeouts, config?.timeouts ?? {}).collection },
      ...(config === undefined ? {} : { config }),
      ...(scope.selection === undefined ? {} : { selection: scope.selection }),
    })
    if (dependencies.signal.aborted) return interruptedExitCode(dependencies.signal)
    if (parsed.flag('json')) {
      dependencies.stdout.write(`${JSON.stringify({ schemaVersion: 1, files: collected.files }, null, 2)}\n`)
    } else {
      dependencies.stdout.write(renderList(collected, createStyle(shouldUseColor(dependencies.stdout, dependencies.env))))
    }
    const selected = describeSelection(flags, scope.selection?.locations)
    const problems = collectionProblems(collected, selected)
    for (const problem of problems) dependencies.stderr.write(`error: ${problem}\n`)
    return problems.length === 0 ? 0 : 2
  },
}

function renderList(collected: CollectResult, style: Style): string {
  const lines: string[] = []
  let tests = 0
  let runs = 0
  for (const file of collected.files) {
    if (file.collection === 'failed') continue
    lines.push(style.bold(file.file))
    const names = file.tests.map((test) => shownName(test, style))
    const width = Math.max(0, ...names.map((name) => visibleLength(name)))
    for (const [index, test] of file.tests.entries()) {
      const name = names[index] ?? test.name
      const row = test.row === undefined ? '' : `#${test.row}`
      lines.push(`  ${name}${' '.repeat(width - visibleLength(name))}  ${style.dim(`${formatLocation(test.location)}${row}`)}`)
      lines.push(...testFacts(test, style))
    }
    if (file.tests.length === 0) lines.push(style.dim('  no tests'))
    lines.push('')
    tests += file.tests.length
    runs += file.tests.reduce((sum, test) => sum + Math.max(1, test.variants?.length ?? 0), 0)
  }
  const withTargets = runs > tests ? `, ${runs} runs with their targets` : ''
  lines.push(`${plural(tests, 'test')} in ${plural(collected.files.length, 'file')}${withTargets}`)
  return `${lines.join('\n')}\n`
}

function shownName(test: CollectedTest, style: Style): string {
  const title = titleWithin(test.name, test.describePath)
  if (test.setup !== true) return title
  const setupFor = test.setupFor === undefined ? '' : ` for ${listWords(test.setupFor, 'and')}`
  return `${title} ${style.dim(`(setup${setupFor})`)}`
}

function testFacts(test: CollectedTest, style: Style): string[] {
  const facts: [string, string[] | undefined][] = [
    ['tags', test.tags],
    ['apps', test.apps],
    ['targets', test.variants?.map((variant) => variantKey(variant))],
  ]
  return facts.flatMap(([label, values]) =>
    values === undefined || values.length === 0 ? [] : [`    ${style.dim(label.padEnd(8))}${values.join(label === 'targets' ? ' · ' : ', ')}`],
  )
}

function collectionProblems(collected: CollectResult, selected: readonly string[]): string[] {
  const problems = collected.files.flatMap(({ file, collection, failure }) => {
    if (collection === 'ok' && failure === undefined) return []
    const what = collection === 'ok' ? 'failed outside its tests' : 'could not be collected'
    const where = failure?.location === undefined ? '' : ` (${formatLocation(failure.location)})`
    return [`${file} ${what}${where}: ${failure?.message ?? 'no reason was recorded.'}`]
  })
  const total = collected.files.reduce((sum, file) => sum + file.tests.length, 0)
  if (problems.length > 0 || total > 0) return problems
  if (selected.length > 0) return [`No tests match ${listWords(selected, 'and')}.`]
  return ['No tests found. Declare one with test(name, fn).']
}
