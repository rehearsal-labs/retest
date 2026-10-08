import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { loadavg } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMissingFile } from '../src/shared/error-code.ts'
import { startFixtureApp } from './fixture-apps.ts'
import { writeTests } from './generate.ts'
import { describeMachine, describeSource } from './machine.ts'
import { fixtureNames } from './options.ts'
import { isRecord, readString } from './json.ts'
import { recordingConfig, matchedPlaywrightConfig } from './recording-config.ts'
import { recordingOptions, recordingUsage } from './recording-options.ts'
import { measureProgram } from './recording-program.ts'
import { recordingSummaries, renderRecordingResults, validMeasurement, type RecordingCell, type RecordingResults } from './recording-report.ts'
import { assertSucceeded, runProgram } from './programs.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

async function main(): Promise<number> {
  const options = recordingOptions(process.argv.slice(2))
  if (options === null) { process.stdout.write(recordingUsage); return 0 }
  if (process.platform !== 'darwin') throw new Error('The resource observer in this scenario requires macOS.')
  try { if ((await readdir(options.output)).length > 0) throw new Error(`${options.output} already holds files.`) }
  catch (error) { if (!isMissingFile(error)) throw error }
  await mkdir(options.output, { recursive: true })
  // Compile the read-only host observer before any measurement; --observer names this output.
  const observerBuild = await runProgram('clang', ['-O2', '-Wall', '-Wextra', '-Werror', join(root, 'benchmarks/recording-resource.c'), '-o', options.observer], { cwd: root, timeoutMs: 30000 })
  await writeFile(join(options.output, 'observer-build.stdout.txt'), observerBuild.stdout)
  await writeFile(join(options.output, 'observer-build.stderr.txt'), observerBuild.stderr)
  assertSucceeded(observerBuild, 'clang recording-resource.c')
  const cells: RecordingCell[] = []
  const versions: Record<string, string> = {}
  for (const [name, folder] of [['retest', 'retest-project/node_modules/@rehearsal-labs/retest'], ['playwright', 'playwright-project/node_modules/@playwright/test']] as const) {
    const manifest: unknown = JSON.parse(await readFile(join(options.workspace, folder, 'package.json'), 'utf8'))
    if (!isRecord(manifest) || readString(manifest, 'version') === undefined) throw new Error(`No prepared ${name} package.`)
    versions[name] = readString(manifest, 'version') ?? ''
  }
  const results: RecordingResults = { schemaVersion: 1, at: new Date().toISOString(), machine: describeMachine(), source: await describeSource(root, true), options, versions, cells }
  const save = async (): Promise<void> => {
    await writeFile(join(options.output, 'results.json'), `${JSON.stringify({ ...results, summaries: recordingSummaries(cells) }, null, 2)}\n`)
    await writeFile(join(options.output, 'results.md'), renderRecordingResults(results))
  }
  for (const engine of options.engines) {
    for (const fixture of fixtureNames) {
      const app = await startFixtureApp(fixture, root)
      try {
        const project = join(options.output, 'projects', engine, fixture)
        await mkdir(project, { recursive: true })
        await cp(join(options.workspace, 'retest-project/node_modules'), join(project, 'node_modules'), { recursive: true })
        await writeFile(join(project, 'package.json'), '{"private":true,"type":"module"}\n')
        await writeTests(project, 'retest', fixture, { tests: 1, files: 1 })
        const retestEntry = join(project, 'node_modules/@rehearsal-labs/retest/dist/cli/main.js')
        const configurations: { tool: 'retest' | 'playwright'; diagnostics: boolean; recording: boolean; cwd: string; entry: string }[] = options.comparisonOnly ? [] : [
          { tool: 'retest' as const, diagnostics: true, recording: false, cwd: project, entry: retestEntry },
          { tool: 'retest' as const, diagnostics: true, recording: true, cwd: project, entry: retestEntry },
        ]
        if (engine === 'chromium' && options.comparison) {
          const pw = join(options.output, 'projects', 'playwright', fixture)
          await mkdir(pw, { recursive: true })
          await cp(join(options.workspace, 'playwright-project/node_modules'), join(pw, 'node_modules'), { recursive: true })
          await writeFile(join(pw, 'package.json'), '{"private":true,"type":"module"}\n')
          await writeTests(pw, 'playwright', fixture, { tests: 1, files: 1 })
          await writeFile(join(pw, 'playwright.config.ts'), matchedPlaywrightConfig(options.paths.chromium, app.url))
          configurations.push({ tool: 'retest', diagnostics: false, recording: false, cwd: project, entry: retestEntry })
          configurations.push({ tool: 'playwright', diagnostics: false, recording: false, cwd: pw, entry: join(pw, 'node_modules/@playwright/test/cli.js') })
        }
        const group: RecordingCell[] = []
        for (const config of configurations) for (const cache of ['cold', 'warm'] as const) {
          const cell: RecordingCell = { fixture, engine, tool: config.tool, diagnostics: config.diagnostics, recording: config.recording, cache, runs: [], priming: [] }
          cells.push(cell); group.push(cell)
        }
        // Alternate off/on ordering between repetitions. Runs never overlap.
        for (let index = 1; index <= options.runs; index++) {
          const order = index % 2 === 1 ? group : [...group].reverse()
          for (const cell of order) {
            const config = configurations.find(value => value.tool === cell.tool && value.diagnostics === cell.diagnostics && value.recording === cell.recording)
            if (config === undefined) throw new Error('Missing benchmark configuration.')
            if (cell.tool === 'retest') await writeFile(join(config.cwd, 'retest.config.ts'), recordingConfig(engine, options.paths[engine], app.url, cell.recording, cell.diagnostics))
            const label = `${cell.tool}-diagnostics-${cell.diagnostics ? 'on' : 'off'}-recording-${cell.recording ? 'on' : 'off'}`
            const folder = join(options.output, 'runs', engine, fixture, label, cell.cache, String(index))
            const cache = join(folder, 'compile-cache')
            await mkdir(cache, { recursive: true })
            const run = async (name: string) => measureProgram(options, { entry: config.entry, cwd: config.cwd, folder: join(folder, name), cache, tool: cell.tool, record: cell.recording, load: loadavg })
            let primeProblem: string | undefined
            if (cell.cache === 'warm') {
              const prime = await run('prime')
              cell.priming.push(prime)
              if (!validMeasurement(prime)) primeProblem = `Invalid warm priming run: ${prime.outcome.reason ?? ''}; ${prime.evidenceProblems.join('; ')}`
            }
            const rawMeasured = await run('measured')
            const measured = primeProblem === undefined ? rawMeasured : { ...rawMeasured, evidenceProblems: [...rawMeasured.evidenceProblems, primeProblem] }
            cell.runs.push(measured)
            for (const line of (await readFile(join(folder, 'measured', 'run', 'events.jsonl'), 'utf8').catch((error: unknown) => { if (cell.tool === 'playwright' && isMissingFile(error)) return ''; throw error })).split('\n')) {
              if (line === '') continue
              const event: unknown = JSON.parse(line)
              if (isRecord(event) && readString(event, 'type') === 'browser.started') {
                versions[engine] = [readString(event, 'product'), readString(event, 'version'), readString(event, 'build')].filter(value => value !== undefined).join(' ')
              }
            }
            process.stderr.write(`${engine} ${fixture} ${label} ${cell.cache} ${index}/${options.runs}: ${measured.wallMs.toFixed(2)} ms, ${validMeasurement(measured) ? 'valid' : `invalid ${measured.outcome.reason ?? ''} ${measured.evidenceProblems.join('; ')}`}\n`)
            await save()
          }
        }
      } finally { await app.stop() }
    }
  }
  await save()
  process.stdout.write(`Written to ${options.output}\n`)
  return cells.every(cell => cell.runs.length === options.runs && cell.runs.every(validMeasurement)) ? 0 : 1
}

try { process.exitCode = await main() }
catch (error) { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 2 }
