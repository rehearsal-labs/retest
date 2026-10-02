import type { Machine, Source } from './machine.ts'
import type { BenchmarkOptions, FixtureName, RunnerName } from './options.ts'
import type { Phases, RunOutcome } from './phases.ts'
import { FIXTURE_NOTES } from './fixture-apps.ts'

export type Cell = {
  readonly fixture: FixtureName
  readonly tests: number
  readonly files: number
  readonly runner: RunnerName
  readonly runs: readonly RunOutcome[]
  readonly median: Phases | null
}

export type Results = {
  readonly schemaVersion: 1
  readonly at: string
  readonly machine: Machine
  readonly source: Source
  readonly versions: { readonly browser: string; readonly retest: string; readonly playwright: string }
  readonly options: Pick<BenchmarkOptions, 'runs' | 'browser'>
  readonly install: { readonly retestMs: number; readonly playwrightMs: number | null }
  readonly cells: readonly Cell[]
}

const RUNNER_LABELS: Readonly<Record<RunnerName, string>> = {
  retest: 'Retest',
  'retest-playwright': "Retest, on Playwright's own spec files",
  playwright: 'Playwright, default workers',
  'playwright-1-worker': 'Playwright, 1 worker',
}

/** The results as a Markdown page: the machine, the code, the install times, and one table per fixture. */
export function renderMarkdown(results: Results): string {
  const { machine, source } = results
  const lines = [
    '# Retest benchmark',
    '',
    `${results.at}. ${machine.cpu}, ${machine.cores} cores, ${machine.memoryGb} GB, ${machine.platform} ${machine.release} ${machine.arch}. Node ${machine.node}. ${results.versions.browser}. Retest ${results.versions.retest}, Playwright ${results.versions.playwright}.`,
    '',
    `Retest packed from commit ${source.commit.slice(0, 12)}, ${source.dirty ? 'with uncommitted changes in the working tree' : 'working tree clean'}, ${source.built ? 'dist rebuilt first' : 'dist taken as found'}.`,
    '',
    `Runs per cell: ${results.options.runs}. Each number is the median over the runs that passed every test. Milliseconds.`,
    '',
    '| Install | Time |',
    '| --- | --- |',
    `| Retest, packed tarball, offline, 0 dependencies | ${results.install.retestMs} ms |`,
    `| Playwright, from the registry, without its browsers | ${results.install.playwrightMs === null ? 'kept from an earlier run' : `${results.install.playwrightMs} ms`} |`,
    '',
  ]
  for (const fixture of uniqueFixtures(results.cells)) {
    lines.push(`## ${fixture}`, '', FIXTURE_NOTES[fixture], '', '| Tests | Files | Runner | Wall | Startup | Tests | Teardown | Per test | Valid runs |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const cell of results.cells.filter((candidate) => candidate.fixture === fixture)) lines.push(renderRow(cell))
    lines.push('')
  }
  lines.push(
    'Startup is the spawn to the first test starting. Tests is the first test starting to the last ending. Teardown is the last test ending to the process exiting. Per test is the median of what each tool reports for one test.',
    '',
  )
  return lines.join('\n')
}

function renderRow(cell: Cell): string {
  const valid = cell.runs.filter((run) => run.valid).length
  const head = `| ${cell.tests} | ${cell.files} | ${RUNNER_LABELS[cell.runner]} |`
  if (cell.median === null) {
    const reasons = [...new Set(cell.runs.flatMap((run) => (run.reason === undefined ? [] : [run.reason])))].join('; ')
    return `${head} invalid: ${reasons || 'no runs'} | | | | | 0 of ${cell.runs.length} |`
  }
  const { median } = cell
  return `${head} ${ms(median.wall)} | ${ms(median.startup)} | ${ms(median.tests)} | ${ms(median.teardown)} | ${ms(median.perTest)} | ${valid} of ${cell.runs.length} |`
}

function ms(value: number): string {
  return String(Math.round(value))
}

function uniqueFixtures(cells: readonly Cell[]): FixtureName[] {
  return [...new Set(cells.map((cell) => cell.fixture))]
}
