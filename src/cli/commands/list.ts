import type { CollectResult } from '../../runner/contract.ts'
import type { Command } from '../command.ts'
import { defaultTimeouts } from '../../protocol/timeouts.ts'
import { formatLocation, plural } from '../../reporters/format.ts'
import { createStyle, type Style } from '../../reporters/style.ts'
import { interruptedExitCode } from '../../runner/outcome.ts'
import { flag, parseArguments } from '../arguments.ts'
import { shouldUseColor } from '../terminal.ts'
import { resolveTestFiles } from '../test-files.ts'

const options = {
  json: flag('Print one JSON document'),
}

export const listCommand: Command = {
  name: 'list',
  usage: '<files...> [options]',
  summary: 'List the tests in each file without opening a browser',
  description: [
    'Loads each file the way a run does and lists the tests it declares, with their source lines.',
    'No browser is launched.',
  ].join('\n'),
  options,
  notes: 'Exit codes: 0 tests were found, 2 a file could not be collected, failed outside its tests, or had no tests.',
  async run(args, dependencies) {
    const parsed = parseArguments(options, args)
    const files = resolveTestFiles(dependencies.cwd, parsed.positionals)
    const collected = await dependencies.collectFiles({
      files,
      rootDir: dependencies.cwd,
      timeouts: { collection: defaultTimeouts.collection },
    })
    if (dependencies.signal.aborted) return interruptedExitCode(dependencies.signal)
    if (parsed.flag('json')) {
      dependencies.stdout.write(`${JSON.stringify({ schemaVersion: 1, files: collected.files }, null, 2)}\n`)
    } else {
      dependencies.stdout.write(
        renderList(collected, createStyle(shouldUseColor(dependencies.stdout, dependencies.env))),
      )
    }
    const problems = collectionProblems(collected)
    for (const problem of problems) dependencies.stderr.write(`error: ${problem}\n`)
    return problems.length === 0 ? 0 : 2
  },
}

function renderList(collected: CollectResult, style: Style): string {
  const lines: string[] = []
  let tests = 0
  for (const file of collected.files) {
    if (file.collection === 'failed') continue
    lines.push(style.bold(file.file))
    const width = Math.max(0, ...file.tests.map((test) => test.name.length))
    for (const test of file.tests) {
      lines.push(`  ${test.name.padEnd(width)}  ${style.dim(formatLocation(test.location))}`)
    }
    if (file.tests.length === 0) lines.push(style.dim('  no tests'))
    lines.push('')
    tests += file.tests.length
  }
  lines.push(`${plural(tests, 'test')} in ${plural(collected.files.length, 'file')}`)
  return `${lines.join('\n')}\n`
}

function collectionProblems(collected: CollectResult): string[] {
  const problems = collected.files.flatMap(({ file, collection, failure }) => {
    if (collection === 'ok' && failure === undefined) return []
    const what = collection === 'ok' ? 'failed outside its tests' : 'could not be collected'
    const where = failure?.location === undefined ? '' : ` (${formatLocation(failure.location)})`
    return [`${file} ${what}${where}: ${failure?.message ?? 'no reason was recorded.'}`]
  })
  const total = collected.files.reduce((sum, file) => sum + file.tests.length, 0)
  if (problems.length === 0 && total === 0) problems.push('No tests found. Declare one with test(name, fn).')
  return problems
}
