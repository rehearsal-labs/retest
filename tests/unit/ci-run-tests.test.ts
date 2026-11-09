import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const runner = fileURLToPath(new URL('../../scripts/ci/run-tests.ts', import.meta.url))

async function project(context: TestContext): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'retest-ci-runner-'))
  context.after(() => rm(folder, { recursive: true, force: true }))
  await mkdir(join(folder, 'tests/unit'), { recursive: true })
  await mkdir(join(folder, 'tests/integration'), { recursive: true })
  await writeFile(join(folder, 'tests/unit/pass.test.ts'), "import { test } from 'node:test'; test('passes', () => {})\n")
  await writeFile(join(folder, 'tests/unit/fail.test.ts'), "import { test } from 'node:test'; test('deliberately fails', () => { throw new Error('broken control') })\n")
  await writeFile(join(folder, 'tests/integration/later.test.ts'), "import { test } from 'node:test'; import { writeFileSync } from 'node:fs'; test('later file runs', () => { writeFileSync('later-ran', 'yes') })\n")
  return folder
}

test('the CI wrapper records the files it actually ran and returns success only when each passes', async (context) => {
  const folder = await project(context)
  const files = ['tests/unit/pass.test.ts', 'tests/integration/later.test.ts']
  const result = await execute(process.execPath, [runner, JSON.stringify(files), join(folder, 'results')], { cwd: folder, timeout: 10000 })
  assert.match(result.stdout, /TAP version 13/)
  const receipt: unknown = JSON.parse(await readFile(join(folder, 'results/results.json'), 'utf8'))
  assert.ok(typeof receipt === 'object' && receipt !== null && 'completed' in receipt && 'exitCode' in receipt && 'files' in receipt && 'plannedFiles' in receipt)
  assert.equal(receipt.completed, true)
  assert.equal(receipt.exitCode, 0)
  assert.deepEqual(receipt.plannedFiles, files)
  assert.ok(Array.isArray(receipt.files))
  assert.equal(receipt.files.length, files.length)
  assert.equal(await readFile(join(folder, 'later-ran'), 'utf8'), 'yes')
})

test('a real failed test keeps CI unsuccessful even when the following file passes', async (context) => {
  const folder = await project(context)
  const files = ['tests/unit/fail.test.ts', 'tests/integration/later.test.ts']
  await assert.rejects(execute(process.execPath, [runner, JSON.stringify(files), join(folder, 'results')], { cwd: folder, timeout: 10000 }), (error: unknown) => {
    assert.ok(error instanceof Error && 'code' in error && 'stdout' in error)
    assert.equal(error.code, 1)
    assert.match(String(error.stdout), /not ok 1 - deliberately fails/)
    return true
  })
  const receipt: unknown = JSON.parse(await readFile(join(folder, 'results/results.json'), 'utf8'))
  assert.ok(typeof receipt === 'object' && receipt !== null && 'completed' in receipt && 'exitCode' in receipt)
  assert.equal(receipt.completed, true)
  assert.equal(receipt.exitCode, 1)
  assert.equal(await readFile(join(folder, 'later-ran'), 'utf8'), 'yes')
})

test('empty, duplicated and untracked selections fail without running a test', async (context) => {
  const folder = await project(context)
  for (const files of [[], ['tests/integration/later.test.ts', 'tests/integration/later.test.ts'], ['tests/unit/missing.test.ts'], ['../tests/unit/pass.test.ts']]) {
    await assert.rejects(execute(process.execPath, [runner, JSON.stringify(files), join(folder, 'results')], { cwd: folder, timeout: 10000 }), (error: unknown) => {
      assert.ok(error instanceof Error && 'stdout' in error)
      assert.doesNotMatch(String(error.stdout), /TAP version 13/)
      return true
    })
  }
  await assert.rejects(readFile(join(folder, 'later-ran')))
})

// An earlier attempt's results.json, as the job kept it in an artifact folder named for its attempt.
async function earlierAttempt(folder: string, attempt: number, plannedFiles: readonly string[], passed: readonly string[], failed: readonly string[]): Promise<string> {
  const kept = join(folder, 'earlier', `unit-linux-x64-1-${attempt}`)
  await mkdir(kept, { recursive: true })
  const files = [...passed.map((file) => ({ file, durationMs: 10, exitCode: 0, signal: null })), ...failed.map((file) => ({ file, durationMs: 10, exitCode: 1, signal: null }))]
  await writeFile(join(kept, 'results.json'), JSON.stringify({ schemaVersion: 1, attempt, completed: true, exitCode: failed.length > 0 ? 1 : 0, plannedFiles, files }))
  return join(folder, 'earlier')
}

test('a re-run runs only the files no earlier attempt of the job passed, and names each file it carried', async (context) => {
  const folder = await project(context)
  await writeFile(join(folder, 'tests/unit/marks.test.ts'), "import { test } from 'node:test'; import { writeFileSync } from 'node:fs'; test('marks its run', () => { writeFileSync('marks-ran', 'yes') })\n")
  const files = ['tests/unit/marks.test.ts', 'tests/integration/later.test.ts']
  const earlier = await earlierAttempt(folder, 1, files, ['tests/unit/marks.test.ts'], ['tests/integration/later.test.ts'])
  const result = await execute(process.execPath, [runner, JSON.stringify(files), join(folder, 'results')], { cwd: folder, timeout: 10000, env: { ...process.env, RETEST_CI_EARLIER_RESULTS: earlier, GITHUB_RUN_ATTEMPT: '2' } })
  assert.match(result.stdout, /::notice file=tests\/unit\/marks\.test\.ts::Passed in attempt 1 of this job, so it is not run again\./)
  assert.match(result.stdout, /1 of 2 files passed in an earlier attempt of this job; 1 run now\./)
  await assert.rejects(readFile(join(folder, 'marks-ran')), 'the file attempt 1 passed does not run again')
  assert.equal(await readFile(join(folder, 'later-ran'), 'utf8'), 'yes')
  const receipt: unknown = JSON.parse(await readFile(join(folder, 'results/results.json'), 'utf8'))
  assert.ok(typeof receipt === 'object' && receipt !== null && 'attempt' in receipt && 'completed' in receipt && 'exitCode' in receipt && 'plannedFiles' in receipt && 'carried' in receipt && 'files' in receipt && Array.isArray(receipt.files))
  assert.equal(receipt.attempt, 2)
  assert.equal(receipt.completed, true)
  assert.equal(receipt.exitCode, 0)
  assert.deepEqual(receipt.plannedFiles, files, 'the plan stays the whole job, so the next attempt can carry from this one')
  assert.deepEqual(receipt.carried, [{ file: 'tests/unit/marks.test.ts', passedInAttempt: 1 }])
  assert.deepEqual(receipt.files.map((entry: unknown) => typeof entry === 'object' && entry !== null && 'file' in entry ? entry.file : undefined), ['tests/integration/later.test.ts'])
})

test('a file that failed earlier, or passed for another list of files, runs again', async (context) => {
  const folder = await project(context)
  const files = ['tests/unit/pass.test.ts', 'tests/integration/later.test.ts']
  const earlier = await earlierAttempt(folder, 1, ['tests/unit/pass.test.ts'], ['tests/unit/pass.test.ts'], [])
  await earlierAttempt(folder, 2, files, [], ['tests/integration/later.test.ts'])
  const result = await execute(process.execPath, [runner, JSON.stringify(files), join(folder, 'results')], { cwd: folder, timeout: 10000, env: { ...process.env, RETEST_CI_EARLIER_RESULTS: earlier, GITHUB_RUN_ATTEMPT: '3' } })
  assert.match(result.stdout, /unit-linux-x64-1-1[\\/]results\.json was planned for other files, so none of its results is carried\./)
  assert.doesNotMatch(result.stdout, /::notice file=/)
  const receipt: unknown = JSON.parse(await readFile(join(folder, 'results/results.json'), 'utf8'))
  assert.ok(typeof receipt === 'object' && receipt !== null && 'carried' in receipt && 'files' in receipt && Array.isArray(receipt.files))
  assert.deepEqual(receipt.carried, [])
  assert.equal(receipt.files.length, 2)
  assert.equal(await readFile(join(folder, 'later-ran'), 'utf8'), 'yes')
})

test('with no earlier results kept, every file runs and the run says so', async (context) => {
  const folder = await project(context)
  const files = ['tests/integration/later.test.ts']
  const result = await execute(process.execPath, [runner, JSON.stringify(files), join(folder, 'results')], { cwd: folder, timeout: 10000, env: { ...process.env, RETEST_CI_EARLIER_RESULTS: join(folder, 'no-such-folder'), GITHUB_RUN_ATTEMPT: '2' } })
  assert.match(result.stdout, /No earlier attempt of this job kept its results, so every file runs\./)
  assert.equal(await readFile(join(folder, 'later-ran'), 'utf8'), 'yes')
})

test('a re-run whose files all passed earlier runs none and succeeds', async (context) => {
  const folder = await project(context)
  const files = ['tests/integration/later.test.ts']
  const earlier = await earlierAttempt(folder, 1, files, files, [])
  const result = await execute(process.execPath, [runner, JSON.stringify(files), join(folder, 'results')], { cwd: folder, timeout: 10000, env: { ...process.env, RETEST_CI_EARLIER_RESULTS: earlier, GITHUB_RUN_ATTEMPT: '2' } })
  assert.doesNotMatch(result.stdout, /TAP version 13/)
  await assert.rejects(readFile(join(folder, 'later-ran')))
  const receipt: unknown = JSON.parse(await readFile(join(folder, 'results/results.json'), 'utf8'))
  assert.ok(typeof receipt === 'object' && receipt !== null && 'completed' in receipt && 'exitCode' in receipt && 'files' in receipt)
  assert.equal(receipt.completed, true)
  assert.equal(receipt.exitCode, 0)
  assert.deepEqual(receipt.files, [])
})
