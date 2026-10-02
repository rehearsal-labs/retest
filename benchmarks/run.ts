import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFixtureApp } from './fixture-apps.ts'
import { writeConfigs, writeTests } from './generate.ts'
import { browserVersion, describeMachine, describeSource } from './machine.ts'
import { parseOptions, USAGE, type BenchmarkOptions, type RunnerName } from './options.ts'
import { medianPhases, type RunOutcome } from './phases.ts'
import { renderMarkdown, type Cell, type Results } from './report.ts'
import { runPlaywright } from './runners/playwright.ts'
import { runRetest, runRetestOnPlaywrightFiles } from './runners/retest.ts'
import { prepareWorkspace, type Workspace } from './workspace.ts'
import { isMissingFile } from '../src/shared/error-code.ts'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

function log(line: string): void {
  process.stderr.write(`${line}\n`)
}

async function main(): Promise<number> {
  let options: BenchmarkOptions
  try {
    const parsed = parseOptions(process.argv.slice(2), process.cwd())
    if (parsed.kind === 'help') {
      process.stdout.write(USAGE)
      return 0
    }
    options = parsed.options
    await refuseFilledFolder(options.output)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
    return 2
  }
  await mkdir(options.output, { recursive: true })
  const source = await describeSource(repositoryRoot, options.build)
  const workspace = await prepareWorkspace(options, repositoryRoot, log)
  const machine = describeMachine()
  const browser = await browserVersion(options.browser, repositoryRoot)
  log(`${machine.cpu}, ${machine.cores} cores. ${browser}. Retest ${workspace.retest.version} from ${source.commit.slice(0, 12)}${source.dirty ? ' with uncommitted changes' : ''}, Playwright ${workspace.playwright.version}.`)

  const cells: Cell[] = []
  for (const fixture of options.fixtures) {
    const app = await startFixtureApp(fixture, repositoryRoot)
    log(`${fixture} at ${app.url}`)
    try {
      await writeConfigs(workspace.retest.folder, workspace.playwright.folder, options.browser, app.url)
      for (const size of options.sizes) {
        await writeTests(workspace.retest.folder, 'retest', fixture, size)
        await writeTests(workspace.playwright.folder, 'playwright', fixture, size)
        const runs = new Map<RunnerName, RunOutcome[]>(options.runners.map((runner) => [runner, []]))
        for (let index = 1; index <= options.runs; index += 1) {
          for (const runner of options.runners) {
            const runFolder = join(options.output, 'runs', fixture, `${size.tests}-tests`, runner, String(index))
            const outcome = await runOnce(runner, workspace, runFolder, options.runTimeoutMs, size.tests, { browser: options.browser, baseUrl: app.url })
            runs.get(runner)?.push(outcome)
            log(`  ${fixture}, ${size.tests} tests, ${runner}, run ${index} of ${options.runs}: ${describe(outcome)}`)
          }
        }
        for (const [runner, outcomes] of runs) {
          cells.push({ fixture, tests: size.tests, files: size.files, runner, runs: outcomes, median: medianPhases(outcomes) })
        }
      }
    } finally {
      await app.stop()
    }
  }

  const results: Results = {
    schemaVersion: 1,
    at: new Date().toISOString(),
    machine,
    source,
    versions: { browser, retest: workspace.retest.version, playwright: workspace.playwright.version },
    options: { runs: options.runs, browser: options.browser },
    install: workspace.install,
    cells,
  }
  const markdown = renderMarkdown(results)
  await writeFile(join(options.output, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
  await writeFile(join(options.output, 'results.md'), markdown)
  process.stdout.write(`${markdown}\nWritten to ${options.output}\n`)
  return cells.every((cell) => cell.median !== null) ? 0 : 1
}

// Retest never writes over a run folder, so an output folder with files in it would make every Retest cell
// invalid. Refusing it here says so before any install or run starts.
async function refuseFilledFolder(folder: string): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(folder)
  } catch (error) {
    if (isMissingFile(error)) return
    throw error
  }
  if (entries.length > 0) throw new Error(`${folder} already holds files. Choose a new folder with --output.`)
}

function runOnce(
  runner: RunnerName,
  workspace: Workspace,
  runFolder: string,
  timeoutMs: number,
  expectedTests: number,
  target: { browser: string; baseUrl: string },
): Promise<RunOutcome> {
  switch (runner) {
    case 'retest':
      return runRetest(workspace.retest, runFolder, timeoutMs, expectedTests)
    case 'retest-playwright':
      return runRetestOnPlaywrightFiles(workspace.retest, workspace.playwright.folder, target, runFolder, timeoutMs, expectedTests)
    case 'playwright':
      return runPlaywright(workspace.playwright, runFolder, undefined, timeoutMs, expectedTests)
    case 'playwright-1-worker':
      return runPlaywright(workspace.playwright, runFolder, 1, timeoutMs, expectedTests)
  }
}

function describe(outcome: RunOutcome): string {
  if (!outcome.valid) return `invalid, ${outcome.reason ?? 'unknown reason'}`
  const { phases } = outcome
  return phases === null ? 'valid' : `${Math.round(phases.wall)} ms wall, ${Math.round(phases.startup)} startup, ${Math.round(phases.tests)} tests, ${Math.round(phases.teardown)} teardown`
}

process.exitCode = await main()
