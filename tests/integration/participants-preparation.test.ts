import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { testId } from '../../src/protocol/run-folder.ts'
import { openApp } from './browser-harness.ts'
import { eventsOf, filesHolding, hostScript, runHost, testNamed, writeProject } from './cli-harness.ts'
import { attemptEvents, holders, TASK_APP_PASSWORD } from './participants-harness.ts'

// Release 1, trusted-host preparation and cleanup on real Chrome. The host's own callbacks seed and remove records
// through the task app's fixture service, and touch the holders counter, so the app itself shows what ran and what
// never did. A preparation that fails or never answers stops its test before any app action; a cleanup that fails is
// reported beside the test's own failure; each attempt records the state it started from.

const file = 'tests/prepared.retest.ts'
const names = {
  seeded: 'reads the record the host seeded',
  failed: 'never acts when its preparation fails',
  uncertain: 'never acts when its preparation does not answer',
  cleanup: 'keeps its own failure when the cleanup fails',
  reused: 'finds what an earlier run left in the backend',
}

const signIn = `  await page.goto('/login')
  await page.getByLabel('User name').fill('member-b')
  await page.getByLabel('Password').fill(secret('password'))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByTestId('account')).toHaveText('Signed in as member-b')`

const tests = `import { expect, secret, test } from '@rehearsal-labs/retest'

test('${names.seeded}', async ({ page }) => {
${signIn}
  await page.goto('/shared/record?reference=' + (process.env.SEEDED_REFERENCE ?? ''))
  await expect(page.getByTestId('record-title-shown')).toHaveText('Seeded report')
  await expect(page.getByTestId('record-owner')).toHaveText('host-fixture')
})

test('${names.failed}', async ({ page }) => {
  await page.goto('/holders/hold?name=failed-preparation&ms=0')
  await expect(page.getByTestId('held-name')).toHaveText('failed-preparation')
})

test('${names.uncertain}', async ({ page }) => {
  await page.goto('/holders/hold?name=uncertain-preparation&ms=0')
  await expect(page.getByTestId('held-name')).toHaveText('uncertain-preparation')
})

test('${names.cleanup}', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('saved-task')).toHaveText('A task nobody saved')
})

test('${names.reused}', async ({ page }) => {
${signIn}
  await page.goto('/shared/record?reference=' + (process.env.PERSISTED_REFERENCE ?? ''))
  await expect(page.getByTestId('record-title-shown')).toHaveText('Left by an earlier run')
})
`

const key = (name: string): string => JSON.stringify(testId(file, name))

// The host's callbacks, as TypeScript source inside its runFiles options. Each reaches the app at APP_URL.
const preparations = `prepare: {
      ${key(names.seeded)}: {
        prepare: async (context) => {
          const reference = process.env['SEEDED_REFERENCE'] ?? ''
          const response = await fetch(new URL('/shared/api/seed', process.env['APP_URL']), { method: 'POST', body: JSON.stringify({ reference, title: 'Seeded report', createdBy: 'host-fixture' }), signal: context.signal })
          if (response.status !== 201) return { status: 'failed', reason: 'the fixture service answered ' + response.status }
          return { status: 'prepared', recipe: 'shared-records@1', seed: 1, receipt: 'seed:' + reference, metadata: { records: 1, attempt: context.attemptId } }
        },
        cleanup: async (context) => {
          const reference = process.env['SEEDED_REFERENCE'] ?? ''
          const response = await fetch(new URL('/shared/api/delete', process.env['APP_URL']), { method: 'POST', body: JSON.stringify({ reference }), signal: context.signal })
          if (!response.ok) throw new Error('the seeded record was not deleted')
        },
      },
      ${key(names.failed)}: {
        prepare: async () => ({ status: 'failed', reason: 'the fixture service refused the seed' }),
        cleanup: async () => void (await fetch(new URL('/holders/hold?name=cleanup-after-failure&ms=0', process.env['APP_URL']))),
      },
      ${key(names.uncertain)}: {
        timeoutMs: 500,
        prepare: () => new Promise(() => undefined),
        cleanup: async () => void (await fetch(new URL('/holders/hold?name=cleanup-after-uncertain&ms=0', process.env['APP_URL']))),
      },
      ${key(names.cleanup)}: {
        backendData: 'external',
        cleanup: async () => {
          throw new Error('the fixture service did not answer')
        },
      },
      ${key(names.reused)}: { backendData: 'reused' },
    },
    testEnvironment: { SEEDED_REFERENCE: process.env['SEEDED_REFERENCE'] ?? '', PERSISTED_REFERENCE: process.env['PERSISTED_REFERENCE'] ?? '' },`

test('a host preparation runs before the first action, its failure or silence stops the test there, and its cleanup never hides the test’s own failure', async (t) => {
  const app = await openApp(t)
  const seeded = `seeded-${randomUUID()}`
  const persisted = `persisted-${randomUUID()}`
  const left = await fetch(new URL('/shared/api/seed', app.url), { method: 'POST', body: JSON.stringify({ reference: persisted, title: 'Left by an earlier run', createdBy: 'owner-a' }) })
  assert.equal(left.status, 201)
  const config = `{
  apps: { web: chrome({ baseUrl: process.env['APP_URL'] ?? '' }) },
  secrets: { password: () => process.env['HOST_PASSWORD'] ?? '' },
}`
  const root = await writeProject(t, { 'package.json': '{ "type": "module" }\n', 'host.ts': hostScript({ config, files: [file], options: preparations }), [file]: tests })
  const run = await runHost(t, {
    cwd: root,
    command: [process.execPath, '--conditions=retest-source', 'host.ts'],
    env: { HOST_PASSWORD: TASK_APP_PASSWORD, APP_URL: app.url, SEEDED_REFERENCE: seeded, PERSISTED_REFERENCE: persisted },
  })
  assert.equal(run.exit.code, 1, run.stderr)

  // Prepared: the record the host seeded was there for the test, and its cleanup removed it.
  const prepared = testNamed(run, names.seeded)
  assert.equal(prepared.status, 'passed', prepared.failure?.message)
  const preparation = prepared.preparations?.[0]
  assert.deepEqual(
    [preparation?.outcome, preparation?.backendData, preparation?.recipe, preparation?.seed, preparation?.receipt, preparation?.metadata],
    ['prepared', 'prepared', 'shared-records@1', 1, `seed:${seeded}`, { records: 1, attempt: prepared.attemptId }],
  )
  assert.deepEqual(prepared.cleanups?.map((record) => record.outcome), ['done'])
  assert.deepEqual(prepared.execution?.startingState, [{ app: 'web', browserStorage: 'fresh', backendData: 'prepared' }])
  assert.equal(app.sharedRecords().some((record) => record.reference === seeded), false, 'the cleanup removed what the preparation seeded')
  const order = attemptEvents(run.events, prepared.attemptId).map((event) => event.type)
  assert.ok(order.indexOf('test.started') < order.indexOf('preparation.finished') && order.indexOf('preparation.finished') < order.indexOf('action.completed'), 'prepared after the attempt started and before its first action')
  assert.ok(order.lastIndexOf('action.completed') < order.indexOf('cleanup.finished') && order.indexOf('cleanup.finished') < order.indexOf('test.finished'))

  // Failed and uncertain: a setup result, no app action at all, and the cleanup still ran.
  for (const [name, outcome, holder, cleanup] of [
    [names.failed, 'failed', 'failed-preparation', 'cleanup-after-failure'],
    [names.uncertain, 'uncertain', 'uncertain-preparation', 'cleanup-after-uncertain'],
  ] as const) {
    const result = testNamed(run, name)
    assert.equal(result.status, 'error', name)
    assert.equal(result.failure?.class, 'setup_failed', name)
    assert.deepEqual(result.ending, { kind: 'setup_failed' }, name)
    assert.equal(result.preparations?.[0]?.outcome, outcome, name)
    const acted = attemptEvents(run.events, result.attemptId).filter((event) => event.type.startsWith('action.') || event.type === 'navigation' || event.type === 'observation')
    assert.deepEqual(acted, [], `${name}: nothing reached the app`)
    assert.equal((await holders(app.url, holder)).holds, 0, `${name}: the app never saw the test's page`)
    assert.equal((await holders(app.url, cleanup)).holds, 1, `${name}: the host's cleanup ran once`)
  }
  assert.match(testNamed(run, names.uncertain).failure?.message ?? '', /could not be confirmed, so the test did not act on any app: it did not answer within 500 ms, and what it started may still be running\.$/)

  // A cleanup that fails: the test's own check failure stays its failure, and the cleanup's is reported beside it.
  const kept = testNamed(run, names.cleanup)
  assert.equal(kept.status, 'failed')
  assert.equal(kept.failure?.class, 'check_failed')
  assert.deepEqual(kept.cleanupFailures?.map((each) => [each.class, each.message]), [['cleanup_failed', `The host's cleanup for ${key(names.cleanup)} failed: it threw: the fixture service did not answer.`]])
  assert.deepEqual(kept.ending, { kind: 'assertion_failed' })
  assert.deepEqual(kept.execution?.startingState, [{ app: 'web', browserStorage: 'fresh', backendData: 'external' }])
  assert.equal(kept.evidence.length, 1, 'the failure screenshot was still taken')

  // Fresh browser storage is not a fresh database: the attempt starts with no cookie, and finds what an earlier run
  // left on the server, and the record says the host meant it to.
  const reused = testNamed(run, names.reused)
  assert.equal(reused.status, 'passed', reused.failure?.message)
  assert.deepEqual(reused.execution?.startingState, [{ app: 'web', browserStorage: 'fresh', backendData: 'reused' }])
  assert.equal(reused.preparations, undefined, 'a declaration alone prepares nothing and has no record of its own')

  assert.deepEqual(eventsOf(run.events, 'run.started')[0]?.options.preparations?.length, 5)
  assert.deepEqual(filesHolding(run.output, TASK_APP_PASSWORD), [])
})
