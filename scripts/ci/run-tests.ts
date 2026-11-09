import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { performance } from 'node:perf_hooks'
import { discoverTests } from './test-plan.ts'

type FileResult = { file: string; durationMs: number; exitCode: number | null; signal: NodeJS.Signals | null }
type Carried = { file: string; passedInAttempt: number | null }
const input: unknown = JSON.parse(process.argv[2] ?? 'null')
if (!Array.isArray(input) || input.length === 0) throw new Error('Give a nonempty JSON array of checked test files.')
const files: string[] = []
const values: readonly unknown[] = input
for (const file of values) {
  if (typeof file !== 'string') throw new Error('Every test file must be a string.')
  files.push(file)
}
const inventory = discoverTests(process.cwd())
const known = new Set([...inventory.unit, ...inventory.integration])
if (new Set(files).size !== files.length || files.some((file) => !known.has(file))) throw new Error('Selected test files must exist in the checked commit and appear once.')
const output = process.argv[3]
if (process.argv.length !== 4 || output === undefined) throw new Error('Usage: node scripts/ci/run-tests.ts <JSON files> <result directory>')
const attempt = Number(process.env['GITHUB_RUN_ATTEMPT'] ?? '1')
if (!Number.isInteger(attempt) || attempt < 1) throw new Error('GITHUB_RUN_ATTEMPT must be a whole number from 1.')

/**
 * The files an earlier attempt of this same job passed, from the results.json each attempt kept, found anywhere under
 * `folder`. Only a results file planned for exactly these files counts, so a file passed for another job's list is
 * never carried. The attempt comes from the file, or, for a file from before it was written there, from its folder's
 * name, which ends in the attempt.
 */
function passedEarlier(folder: string, planned: readonly string[]): Carried[] {
  if (!existsSync(folder)) {
    process.stdout.write('No earlier attempt of this job kept its results, so every file runs.\n')
    return []
  }
  const carried = new Map<string, Carried>()
  const paths = readdirSync(folder, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && entry.name === 'results.json').map((entry) => join(entry.parentPath, entry.name))
  for (const path of paths) {
    const document: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof document !== 'object' || document === null || !('schemaVersion' in document) || document.schemaVersion !== 1 || !('plannedFiles' in document) || !('files' in document) || !Array.isArray(document.files)) throw new Error(`${relative(folder, path)} is not a CI results file with schema version 1.`)
    const plannedThen: unknown = document.plannedFiles
    if (!Array.isArray(plannedThen) || plannedThen.length !== planned.length || plannedThen.some((file, index) => file !== planned[index])) {
      process.stdout.write(`${relative(folder, path)} was planned for other files, so none of its results is carried.\n`)
      continue
    }
    const named = /-(\d+)$/.exec(basename(dirname(path)))
    const passedInAttempt = 'attempt' in document && typeof document.attempt === 'number' ? document.attempt : named?.[1] === undefined ? null : Number(named[1])
    const entries: readonly unknown[] = document.files
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null || !('file' in entry) || typeof entry.file !== 'string' || !('exitCode' in entry) || !('signal' in entry)) throw new Error(`${relative(folder, path)} holds a file result that is not the shape this script writes.`)
      if (entry.exitCode === 0 && entry.signal === null && planned.includes(entry.file) && !carried.has(entry.file)) carried.set(entry.file, { file: entry.file, passedInAttempt })
    }
  }
  return planned.flatMap((file) => carried.get(file) ?? [])
}

// A re-run of a CI job runs only the files no earlier attempt of it passed, so one slow moment costs one file again,
// not the whole job. Every file still has to pass on this commit in this run: the results of the attempt that passed it
// stay in its own artifact, and this attempt's results name each file it carried and the attempt that passed it.
const earlier = process.env['RETEST_CI_EARLIER_RESULTS']
const carried = earlier === undefined || earlier === '' ? [] : passedEarlier(earlier, files)
const toRun = files.filter((file) => !carried.some((entry) => entry.file === file))
for (const entry of carried) process.stdout.write(`::notice file=${entry.file}::Passed in ${entry.passedInAttempt === null ? 'an earlier attempt' : `attempt ${entry.passedInAttempt}`} of this job, so it is not run again.\n`)
if (carried.length > 0) process.stdout.write(`${carried.length} of ${files.length} files passed in an earlier attempt of this job; ${toRun.length} run now.\n`)
await mkdir(output, { recursive: true })
const resultFile = join(output, 'results.json')
const environment = { ...process.env }
// This wrapper may itself be exercised by node:test. Each selected file must start a real, independent test runner.
delete environment['NODE_TEST_CONTEXT']

const ctrlCOn = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class RetestKeys { [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add); }'; [RetestKeys]::SetConsoleCtrlHandler([IntPtr]::Zero, $false) | Out-Null`

let current: ChildProcess | undefined
let stoppedBy: NodeJS.Signals | undefined
let executionFailed = false
const results: FileResult[] = []
const interrupt = (): void => { stoppedBy ??= 'SIGINT'; current?.kill('SIGINT') }
const terminate = (): void => { stoppedBy ??= 'SIGTERM'; current?.kill('SIGTERM') }
process.on('SIGINT', interrupt)
process.on('SIGTERM', terminate)

async function save(): Promise<void> {
  const exitCode = stoppedBy === 'SIGINT' ? 130 : stoppedBy === 'SIGTERM' ? 143 : executionFailed || results.some((result) => result.exitCode !== 0) ? 1 : 0
  await writeFile(resultFile, `${JSON.stringify({ schemaVersion: 1, attempt, completed: !executionFailed && stoppedBy === undefined && results.length === toRun.length, exitCode, plannedFiles: files, carried, files: results }, null, 2)}\n`)
  process.exitCode = exitCode
}

try {
  for (const file of toRun) {
    if (stoppedBy !== undefined) break
    process.stdout.write(`::group::${file}\n`)
    const started = performance.now()
    const outcome = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const node = [process.execPath, '--conditions=retest-source', '--test', '--test-concurrency=1', '--test-reporter=tap', file]
      // A CI step's processes inherit Ctrl+C turned off, so on Windows each file runs under a PowerShell that turns it
      // on first; every process below it then gets Ctrl+C as it would from an interactive console.
      current = process.platform === 'win32'
        ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `${ctrlCOn}; & ${node.map((word) => `'${word.replaceAll("'", "''")}'`).join(' ')}; exit $LASTEXITCODE`], { stdio: 'inherit', env: environment })
        : spawn(process.execPath, node.slice(1), { stdio: 'inherit', env: environment })
      current.once('error', reject)
      current.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
    })
    current = undefined
    const result: FileResult = { file, durationMs: Math.round(performance.now() - started), ...outcome }
    results.push(result)
    await save()
    process.stdout.write('::endgroup::\n')
    if (result.exitCode !== 0) process.stdout.write(`::error file=${file}::Test file failed, exit ${result.exitCode ?? result.signal}.\n`)
  }
} catch (error) {
  executionFailed = true
  await save()
  throw error
} finally {
  process.off('SIGINT', interrupt)
  process.off('SIGTERM', terminate)
}
await save()
