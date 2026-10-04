import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SEEDED_ACCOUNTS } from '../../fixtures/cross-platform/service/accounts.ts'
import { startTaskService } from '../../fixtures/cross-platform/service/task-service.ts'
import { rebuildRecordedResult } from '../../src/store/rebuild-result.ts'
import { budgets, filesHolding, repositoryRoot, runProject, testNamed, writeProject } from './cli-harness.ts'
import { nativeSkipReason, taskPhoneApp } from './native-harness.ts'

const unverified = await nativeSkipReason('ios-simulator')

test('TaskPhone public API: sign in, create a task and preserve a wrong-state failure', { skip: unverified }, async (t) => {
  const service = await startTaskService({ port: 0, syncDelayMs: 100, printLine: () => undefined })
  t.after(() => service.close())
  const account = SEEDED_ACCOUNTS.find((entry) => entry.id === 'ada')
  assert.ok(account !== undefined)
  const source = await readFile(join(repositoryRoot, 'fixtures/cross-platform/tests/native-phone.retest.ts'), 'utf8')
  const root = await writeProject(t, {
    'phone.retest.ts': source,
    'retest.config.ts': `import { defineConfig, env } from '@rehearsal-labs/retest'
export default defineConfig({ apps: { phone: { platform: 'ios-simulator', appPath: ${JSON.stringify(taskPhoneApp)}, device: 'iPhone 17', runtime: '26.5', arguments: ['-reset', '-serviceURL', ${JSON.stringify(service.url)}] } }, secrets: { password: env('RETEST_NATIVE_API_PASSWORD') }, secretOrigins: { password: ['dev.retest.fixtures.taskphone'] } })
`,
  })
  const run = await runProject(t, root, { env: { RETEST_NATIVE_API_PASSWORD: account.password }, timeouts: budgets({ setup: 180_000, action: 30_000, assertion: 10_000, test: 120_000, cleanup: 60_000 }), args: ['--workers', '1'] })
  const artifacts = join(homedir(), 'Library/Caches/retest-proofs/artifacts/wiring-phone')
  await mkdir(artifacts, { recursive: true })
  const kept = await mkdtemp(join(artifacts, 'run-'))
  assert.deepEqual(filesHolding(run.output, account.password), [], 'the credential reached no retained run file')
  await cp(run.output, kept, { recursive: true })
  t.diagnostic(`artifacts: ${kept}`)
  assert.ok(run.result !== undefined)
  assert.deepEqual(rebuildRecordedResult(run.events), run.result)
  const passed = testNamed(run, 'TaskPhone creates a task through the native API')
  assert.equal(passed.status, 'passed', passed.failure?.message)
  const failed = testNamed(run, 'TaskPhone preserves a wrong task state failure')
  assert.equal(failed.failure?.class, 'check_failed')
  assert.match(failed.failure?.message ?? '', /created-task-state.*Open|Open.*created-task-state/s)
  assert.equal(run.exit.code, 1)
  assert.equal(run.result.natives?.length, 2)
  for (const started of run.events.filter((event) => event.type === 'native.started')) {
    assert.equal(started.identity.app.bundleId, 'dev.retest.fixtures.taskphone')
    assert.equal(started.identity.os.version, '26.5')
    assert.match(started.identity.app.sha256, /^[0-9a-f]{64}$/)
    assert.equal(started.identity.xcode.build, '17F42')
  }
  assert.equal(run.events.filter((event) => event.type === 'native.ended').length, 2)
  assert.equal(run.events.filter((event) => event.type === 'lease.expired').length, 0)
})
