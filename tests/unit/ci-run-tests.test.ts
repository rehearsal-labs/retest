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
