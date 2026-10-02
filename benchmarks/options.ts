import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { browserPath } from '../tests/support/test-browser.ts'

export const fixtureNames = ['task-app', 'search-app'] as const
export type FixtureName = (typeof fixtureNames)[number]

export const runnerNames = ['retest', 'retest-playwright', 'playwright', 'playwright-1-worker'] as const
export type RunnerName = (typeof runnerNames)[number]

export type Size = { readonly tests: number; readonly files: number }

export type BenchmarkOptions = {
  readonly browser: string
  readonly fixtures: readonly FixtureName[]
  readonly sizes: readonly Size[]
  readonly runners: readonly RunnerName[]
  readonly runs: number
  readonly playwrightVersion: string
  readonly reinstall: boolean
  readonly build: boolean
  readonly output: string
  readonly workspace: string
  readonly runTimeoutMs: number
}

/** What the command line asked for: a run with its options, or the help text. */
export type ParsedOptions = { readonly kind: 'run'; readonly options: BenchmarkOptions } | { readonly kind: 'help' }

const DEFAULT_SIZES: readonly Size[] = [
  { tests: 1, files: 1 },
  { tests: 20, files: 1 },
  { tests: 200, files: 10 },
]

export const USAGE: string = `Usage: node benchmarks/run.ts [options]

Runs the same generated tests through Retest and Playwright, against the same fixture app and the same Chrome,
and writes per-phase medians as JSON and Markdown.

Options
  --browser <path>              Chrome or Chromium executable. Default: RETEST_TEST_BROWSER, or Google Chrome on macOS
  --fixtures <list>             ${fixtureNames.join(', ')}. Default: all
  --sizes <list>                Tests per cell, with files after a slash: 1,20,200/10. Default: 1,20,200/10
  --runners <list>              ${runnerNames.join(', ')}. Default: all
  --runs <n>                    Runs per cell; medians are over them. Default: 5
  --playwright-version <v>      The @playwright/test version to install. Default: latest, asked of the registry
  --reinstall                   Install Playwright again even when the workspace has that version
  --no-build                    Use dist as it is instead of running npm run build first
  --output <dir>                Where results go. Must not hold files yet. Default: .retest/benchmarks/<time>
  --workspace <dir>             Where the two projects and the npm cache live. Default: <tmp>/retest-benchmarks
  --run-timeout-ms <n>          End a run, and every process it started, after this long. Default: 900000
  -h, --help                    Show this help
`

/**
 * Reads the harness's options from the command line.
 *
 * @example parseOptions(['--runs', '3'], '/work')
 */
export function parseOptions(argv: readonly string[], cwd: string): ParsedOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      browser: { type: 'string' },
      fixtures: { type: 'string' },
      sizes: { type: 'string' },
      runners: { type: 'string' },
      runs: { type: 'string', default: '5' },
      'playwright-version': { type: 'string', default: 'latest' },
      reinstall: { type: 'boolean', default: false },
      'no-build': { type: 'boolean', default: false },
      output: { type: 'string' },
      workspace: { type: 'string' },
      'run-timeout-ms': { type: 'string', default: '900000' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help) return { kind: 'help' }
  return {
    kind: 'run',
    options: {
      browser: values.browser === undefined ? browserPath() : givenBrowser(values.browser),
      fixtures: values.fixtures === undefined ? [...fixtureNames] : chooseFrom(values.fixtures, fixtureNames, '--fixtures'),
      sizes: values.sizes === undefined ? DEFAULT_SIZES : parseSizes(values.sizes),
      runners: values.runners === undefined ? [...runnerNames] : chooseFrom(values.runners, runnerNames, '--runners'),
      runs: wholeNumber(values.runs, '--runs'),
      playwrightVersion: values['playwright-version'],
      reinstall: values.reinstall,
      build: !values['no-build'],
      output: resolve(cwd, values.output ?? join('.retest', 'benchmarks', timestamp())),
      workspace: resolve(cwd, values.workspace ?? join(tmpdir(), 'retest-benchmarks')),
      runTimeoutMs: wholeNumber(values['run-timeout-ms'], '--run-timeout-ms'),
    },
  }
}

function givenBrowser(path: string): string {
  if (!isFile(path)) throw new Error(`No browser at ${path}. Pass --browser <path> or set RETEST_TEST_BROWSER.`)
  return path
}

function chooseFrom<const Name extends string>(list: string, names: readonly Name[], flag: string): Name[] {
  const chosen: Name[] = []
  for (const entry of list.split(',')) {
    const name = entry.trim()
    const known = names.find((candidate) => candidate === name)
    if (known === undefined) throw new Error(`${flag} takes ${names.join(', ')}, not ${name}.`)
    if (chosen.includes(known)) throw new Error(`${flag} names ${name} twice.`)
    chosen.push(known)
  }
  return chosen
}

function parseSizes(list: string): Size[] {
  return list.split(',').map((entry) => {
    const [tests, files = '1', ...rest] = entry.trim().split('/')
    if (tests === undefined || rest.length > 0) throw new Error(`--sizes takes tests[/files] entries, not ${entry}.`)
    const size = { tests: wholeNumber(tests, '--sizes'), files: wholeNumber(files, '--sizes') }
    if (size.files > size.tests) throw new Error(`--sizes ${entry} has more files than tests.`)
    return size
  })
}

function wholeNumber(value: string, flag: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${flag} takes a whole number from 1, not ${value}.`)
  return Number(value)
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 19)
}
