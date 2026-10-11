import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { discoverTests } from './test-plan.ts'

type FileResult = { file: string; durationMs: number; exitCode: number | null; signal: NodeJS.Signals | null }
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
await mkdir(output, { recursive: true })
const resultFile = join(output, 'results.json')
const environment = { ...process.env }
// This wrapper may itself be exercised by node:test. Each selected file must start a real, independent test runner.
delete environment['NODE_TEST_CONTEXT']

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
  await writeFile(resultFile, `${JSON.stringify({ schemaVersion: 1, completed: !executionFailed && stoppedBy === undefined && results.length === files.length, exitCode, plannedFiles: files, files: results }, null, 2)}\n`)
  process.exitCode = exitCode
}

try {
  for (const file of files) {
    if (stoppedBy !== undefined) break
    process.stdout.write(`::group::${file}\n`)
    const started = performance.now()
    const outcome = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      current = spawn(process.execPath, ['--conditions=retest-source', '--test', '--test-concurrency=1', '--test-reporter=tap', file], { stdio: 'inherit', env: environment })
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
