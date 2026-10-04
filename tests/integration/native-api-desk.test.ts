import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SEEDED_ACCOUNTS } from '../../fixtures/cross-platform/service/accounts.ts'
import { startTaskService } from '../../fixtures/cross-platform/service/task-service.ts'
import { rebuildRecordedResult } from '../../src/store/rebuild-result.ts'
import { budgets, filesHolding, repositoryRoot, runProject, testNamed, writeProject } from './cli-harness.ts'
import { nativeSkipReason, processesWith, taskDeskApp } from './native-harness.ts'

const unverified = await nativeSkipReason('macos')

async function runDesk(t: TestContext, paired: boolean) {
  const service = await startTaskService({ port: 0, syncDelayMs: 100, printLine: () => undefined })
  t.after(() => service.close())
  const account = SEEDED_ACCOUNTS.find((entry) => entry.id === 'ada')
  assert.ok(account !== undefined)
  const source = await readFile(join(repositoryRoot, `fixtures/cross-platform/tests/${paired ? 'native-desk-web' : 'native-desk'}.retest.ts`), 'utf8')
  const root = await writeProject(t, {
    'desk.retest.ts': source,
    'retest.config.ts': `import { chrome, defineConfig, env } from '@rehearsal-labs/retest'
export default defineConfig({ apps: { desk: { platform: 'macos', appPath: ${JSON.stringify(taskDeskApp)}, arguments: ['-reset', '-windowFrame', '20,60,700,480', '-serviceURL', ${JSON.stringify(service.url)}] }${paired ? `, web: chrome({ baseUrl: ${JSON.stringify(service.url)} })` : ''} }, secrets: { password: env('RETEST_NATIVE_API_PASSWORD') }, secretOrigins: { password: ['dev.retest.fixtures.taskdesk', ${JSON.stringify(service.url)}] } })
`,
  })
  const before = await processesWith('/TaskDesk.app/Contents/MacOS/TaskDesk')
  assert.deepEqual(before, [], 'an existing TaskDesk copy is never adopted or ended')
  const run = await runProject(t, root, { env: { RETEST_NATIVE_API_PASSWORD: account.password }, timeouts: budgets({ setup: 180_000, action: 30_000, assertion: 10_000, test: 120_000, cleanup: 60_000 }), args: ['--workers', '1'] })
  const artifacts = join(homedir(), 'Library/Caches/retest-proofs/artifacts', paired ? 'wiring-desk-web' : 'wiring-desk')
  await mkdir(artifacts, { recursive: true })
  const kept = await mkdtemp(join(artifacts, 'run-'))
  assert.deepEqual(filesHolding(run.output, account.password), [], 'the credential reached no retained run file')
  await cp(run.output, kept, { recursive: true })
  t.diagnostic(`artifacts: ${kept}`)
  assert.deepEqual(await processesWith('/TaskDesk.app/Contents/MacOS/TaskDesk'), [])
  assert.ok(run.result !== undefined)
  const acquired = run.events.find((event) => event.type === 'lease.taken')
  assert.ok(acquired !== undefined)
  for (const event of run.events.filter((event) => event.type === 'browser.started' || event.type === 'native.started')) assert.ok(event.sequence > acquired.sequence, 'the complete lease precedes every app or browser launch')
  assert.deepEqual(rebuildRecordedResult(run.events), run.result)
  assert.equal(run.events.filter((event) => event.type === 'lease.expired').length, 0)
  for (const started of run.events.filter((event) => event.type === 'native.started')) {
    assert.equal(started.identity.app.bundleId, 'dev.retest.fixtures.taskdesk')
    assert.equal(started.identity.platform, 'macos')
    assert.match(started.identity.app.sha256, /^[0-9a-f]{64}$/)
  }
  return run
}

test('TaskDesk public API: find a task by id, press a chord and preserve a wrong-state failure', { skip: unverified }, async (t) => {
  const run = await runDesk(t, false)
  const passed = testNamed(run, 'TaskDesk finds a task by id through the native API')
  assert.equal(passed.status, 'passed', passed.failure?.message)
  const failed = testNamed(run, 'TaskDesk preserves a wrong task state failure')
  assert.equal(failed.failure?.class, 'check_failed')
  assert.match(failed.failure?.message ?? '', /selected-task-state.*Open|Open.*selected-task-state/s)
  assert.equal(run.exit.code, 1)
  const capture = run.events.find((event) => event.type === 'evidence.captured' && event.source === 'window-crop')
  const refused = run.events.find((event) => event.type === 'evidence.failed' && event.source === 'window-crop')
  if (refused?.type === 'evidence.failed') t.diagnostic(`capture refused: ${refused.message}`)
  assert.ok(capture !== undefined, 'the native overlay fix is present; the owned window must pass the coverage check')
  assert.equal(run.events.filter((event) => event.type === 'native.ended').length, 2)
})

test('TaskDesk and the web public API share one lease table', { skip: unverified }, async (t) => {
  const run = await runDesk(t, true)
  const passed = testNamed(run, 'TaskDesk and the web share one lease and task state')
  assert.equal(passed.status, 'passed', passed.failure?.message)
  assert.equal(run.exit.code, 0)
  const lease = run.events.find((event) => event.type === 'lease.taken')
  assert.ok(lease?.type === 'lease.taken')
  assert.equal(lease.lease.covers.filter((part) => part.kind === 'desktop').length, 1)
  assert.deepEqual(lease.lease.covers.find((part) => part.kind === 'desktop')?.apps, ['desk'])
  assert.deepEqual(passed.execution?.sessions.map((session) => [session.app, session.resource]), [['desk', 'desktop'], ['web', 'browser-context']])
})
