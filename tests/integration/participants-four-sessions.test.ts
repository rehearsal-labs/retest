import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatSessionId } from '../../src/protocol/evidence.ts'
import { testId } from '../../src/protocol/run-folder.ts'
import { openApp } from './browser-harness.ts'
import { eventsOf, filesHolding, hostScript, runHost, testNamed, writeProject } from './cli-harness.ts'
import { assertLooksStayWithTheirSession, assertShowsAccount, signInSetup, TASK_APP_PASSWORD } from './participants-harness.ts'

// Release 1, the four-session isolation gate: four participants of one test, each signed in as its own account
// from its own saved state, on one app origin. The parent's checks read every page, every look names its session,
// and the four failure screenshots each belong to one session and show that session's account.

const file = 'tests/four.retest.ts'
const accounts = { alpha: 'alpha-account', beta: 'beta-account', gamma: 'gamma-account', delta: 'delta-account' }
const apps = Object.keys(accounts)
const starting = `{ apps: ${JSON.stringify(apps)}, state: ${JSON.stringify(Object.fromEntries(apps.map((app) => [app, `${app}-signed-in`])))} }`
const handles = apps.join(', ')

function eachSignedIn(): string {
  return Object.entries(accounts)
    .map(([app, account]) => `  await expect(${app}.getByTestId('shared-account')).toHaveText('Signed in as ${account}')\n  await expect(${app}.getByTestId('stored-user')).toHaveText('${account}')`)
    .join('\n')
}

const tests = `import { expect, secret, test } from '@rehearsal-labs/retest'

${Object.entries(accounts)
  .map(([app, account]) => signInSetup(`${app}-signed-in`, app, account))
  .join('\n\n')}

test('four accounts stay apart in one test', ${starting}, async ({ ${handles} }) => {
  await Promise.all([${apps.map((app) => `${app}.goto('/shared')`).join(', ')}])
${eachSignedIn()}
})

test('four accounts are captured in four sessions', ${starting}, async ({ ${handles} }) => {
  await Promise.all([${apps.map((app) => `${app}.goto('/shared')`).join(', ')}])
${eachSignedIn()}
  await expect(delta.getByTestId('record-status')).toHaveText('A status no page shows')
})
`

test('four participants with their own signed-in states keep storage, looks and evidence apart in one test', async (t) => {
  const app = await openApp(t)
  const flow = testId(file, 'four accounts stay apart in one test')
  const checks = Object.entries(accounts).flatMap(([name, account]) => [
    `{ kind: 'text', id: '${name}-signed-in', app: '${name}', text: 'Signed in as ${account}' }`,
    ...Object.entries(accounts)
      .filter(([other]) => other !== name)
      .map(([other, otherAccount]) => `{ kind: 'text', id: '${name}-not-${other}', app: '${name}', text: '${otherAccount}', absent: true }`),
  ])
  const config = `{
  apps: { ${apps.map((name) => `${name}: chrome({ baseUrl: ${JSON.stringify(app.url)} })`).join(', ')} },
  states: ${JSON.stringify(apps.map((name) => `${name}-signed-in`))},
  secrets: { password: () => process.env['HOST_PASSWORD'] ?? '' },
}`
  const options = `hostChecks: { ${JSON.stringify(flow)}: [${checks.join(', ')}] },`
  const root = await writeProject(t, { 'package.json': '{ "type": "module" }\n', 'host.ts': hostScript({ config, files: [file], options }), [file]: tests })
  const run = await runHost(t, { cwd: root, command: [process.execPath, '--conditions=retest-source', 'host.ts'], env: { HOST_PASSWORD: TASK_APP_PASSWORD } })

  assert.equal(run.exit.code, 1, run.stderr)
  for (const name of apps) assert.equal(testNamed(run, `${name}-signed-in`).status, 'passed', name)

  const passed = testNamed(run, 'four accounts stay apart in one test')
  assert.equal(passed.status, 'passed', passed.failure?.message)
  assert.equal(passed.hostChecks?.length, 16)
  assert.ok(passed.hostChecks?.every((check) => check.status === 'passed'), 'the parent read each page signed in as its own account and no other')
  assert.deepEqual(
    eventsOf(run.events, 'state.restored').filter((event) => event.attemptId === passed.attemptId).map((event) => [event.app, event.state]),
    apps.map((name) => [name, `${name}-signed-in`]),
  )
  assert.deepEqual(passed.execution?.sessions.map((session) => session.sessionId), apps.map((name) => formatSessionId(passed.attemptId, name)))
  assert.equal(new Set(passed.execution?.sessions.map((session) => session.sessionId)).size, 4, 'four sessions, four ids')
  assertLooksStayWithTheirSession(run, passed.attemptId, accounts)

  const captured = testNamed(run, 'four accounts are captured in four sessions')
  assert.deepEqual([captured.status, captured.failure?.class, captured.ending?.kind], ['failed', 'check_failed', 'assertion_failed'])
  assert.match(captured.failure?.message ?? '', /A status no page shows/, 'the test failed at its intended check, not earlier')
  assert.deepEqual(captured.evidence.map((shot) => [shot.app, shot.sessionId]), apps.map((name) => [name, formatSessionId(captured.attemptId, name)]))
  const accountOf: Readonly<Record<string, string>> = accounts
  for (const shot of captured.evidence) assertShowsAccount(run.output, shot.path, accountOf[shot.app ?? ''] ?? 'no account')
  assertLooksStayWithTheirSession(run, captured.attemptId, accounts)
  assert.deepEqual(filesHolding(run.output, TASK_APP_PASSWORD), [])
})
