import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatSessionId } from '../../src/protocol/evidence.ts'
import { testId } from '../../src/protocol/run-folder.ts'
import { openApp } from './browser-harness.ts'
import { eventsOf, filesHolding, hostScript, runHost, testNamed, writeProject } from './cli-harness.ts'
import { assertLooksStayWithTheirSession, assertShowsAccount, attemptEvents, signInSetup, TASK_APP_PASSWORD } from './participants-harness.ts'

// Release 1, web participants: two predeclared participants of one flow, owner and member, on one app origin, each
// signed in as a different test account by a setup of its own. The parent proves from its own records that their
// cookies, local storage, looks and screenshots never cross: its host checks read each page, each look names its
// session, and each failure screenshot belongs to one session and shows that session's account.

const file = 'tests/participants.retest.ts'
const accounts = { owner: 'owner-a', member: 'member-b' }
const starting = `{ apps: ['owner', 'member'], state: { owner: 'owner-account', member: 'member-account' } }`

const tests = `import { expect, secret, test } from '@rehearsal-labs/retest'

${signInSetup('owner-account', 'owner', accounts.owner)}

${signInSetup('member-account', 'member', accounts.member)}

test('two accounts stay apart in one flow', ${starting}, async ({ owner, member }) => {
  await owner.goto('/shared')
  await member.goto('/shared')
  await expect(owner.getByTestId('shared-account')).toHaveText('Signed in as ${accounts.owner}')
  await expect(member.getByTestId('shared-account')).toHaveText('Signed in as ${accounts.member}')
  await expect(owner.getByTestId('stored-user')).toHaveText('${accounts.owner}')
  await expect(member.getByTestId('stored-user')).toHaveText('${accounts.member}')
})

test('each account is captured in its own session', ${starting}, async ({ owner, member }) => {
  await owner.goto('/shared')
  await member.goto('/shared')
  await expect(owner.getByTestId('shared-account')).toHaveText('Signed in as ${accounts.owner}')
  await expect(member.getByTestId('shared-account')).toHaveText('Signed in as ${accounts.member}')
  await expect(member.getByTestId('record-status')).toHaveText('A status no page shows')
})
`

test('two participants signed in as two accounts keep their cookies, storage, looks and screenshots apart', async (t) => {
  const app = await openApp(t)
  const flow = testId(file, 'two accounts stay apart in one flow')
  const checks = `[
      { kind: 'text', id: 'owner-signed-in', app: 'owner', text: 'Signed in as ${accounts.owner}' },
      { kind: 'text', id: 'owner-not-member', app: 'owner', text: '${accounts.member}', absent: true },
      { kind: 'text', id: 'member-signed-in', app: 'member', text: 'Signed in as ${accounts.member}' },
      { kind: 'text', id: 'member-not-owner', app: 'member', text: '${accounts.owner}', absent: true },
    ]`
  const config = `{
  apps: { owner: chrome({ baseUrl: ${JSON.stringify(app.url)} }), member: chrome({ baseUrl: ${JSON.stringify(app.url)} }) },
  states: ['owner-account', 'member-account'],
  secrets: { password: () => process.env['HOST_PASSWORD'] ?? '' },
}`
  const options = `hostChecks: { ${JSON.stringify(flow)}: ${checks} },
    requirement: { version: 'participants-v1' },`
  const root = await writeProject(t, { 'package.json': '{ "type": "module" }\n', 'host.ts': hostScript({ config, files: [file], options }), [file]: tests })
  const run = await runHost(t, { cwd: root, command: [process.execPath, '--conditions=retest-source', 'host.ts'], env: { HOST_PASSWORD: TASK_APP_PASSWORD } })

  // The second test fails at its last check on purpose, so the parent captures both pages: exit 1, nothing else.
  assert.equal(run.exit.code, 1, run.stderr)
  for (const setup of ['owner-account', 'member-account']) assert.equal(testNamed(run, setup).status, 'passed', setup)
  assert.deepEqual(
    eventsOf(run.events, 'state.saved').map((event) => [event.state, event.app]),
    [
      ['owner-account', 'owner'],
      ['member-account', 'member'],
    ],
  )

  // Cookies and local storage: the server read each session cookie, and each page's script read its own storage,
  // and the parent's own checks read both pages after the body.
  const passed = testNamed(run, 'two accounts stay apart in one flow')
  assert.equal(passed.status, 'passed', passed.failure?.message)
  assert.deepEqual(
    passed.hostChecks?.map((check) => [check.check.id, check.app, check.status]),
    [
      ['owner-signed-in', 'owner', 'passed'],
      ['owner-not-member', 'owner', 'passed'],
      ['member-signed-in', 'member', 'passed'],
      ['member-not-owner', 'member', 'passed'],
    ],
  )
  const restored = eventsOf(run.events, 'state.restored').filter((event) => event.attemptId === passed.attemptId)
  assert.deepEqual(restored.map((event) => [event.app, event.state]), [
    ['owner', 'owner-account'],
    ['member', 'member-account'],
  ])
  assert.deepEqual(passed.execution?.startingState, [
    { app: 'owner', browserStorage: 'saved', state: 'owner-account', backendData: 'unavailable' },
    { app: 'member', browserStorage: 'saved', state: 'member-account', backendData: 'unavailable' },
  ])
  assert.deepEqual(passed.execution?.requirement?.checks.map((check) => check.id), ['member-not-owner', 'member-signed-in', 'owner-not-member', 'owner-signed-in'])

  // Looks: every look names the session of its own app, and none at who is signed in shows the other account.
  assertLooksStayWithTheirSession(run, passed.attemptId, accounts)
  const judged = eventsOf(run.events, 'assertion.passed').filter((event) => event.testId === passed.testId)
  assert.ok(judged.length >= 4 && judged.every((event) => event.judgedBy === 'parent'), 'the parent judged every passed assertion on its own looks')
  assert.deepEqual(
    passed.execution?.sessions.map((session) => [session.app, session.sessionId]),
    [
      ['owner', formatSessionId(passed.attemptId, 'owner')],
      ['member', formatSessionId(passed.attemptId, 'member')],
    ],
  )

  // Evidence: one screenshot from each session of the failed attempt, each showing its own account's banner.
  const captured = testNamed(run, 'each account is captured in its own session')
  assert.deepEqual([captured.status, captured.failure?.class], ['failed', 'check_failed'])
  assert.match(captured.failure?.message ?? '', /A status no page shows/, 'the test failed at its intended check, not earlier')
  assert.deepEqual(captured.ending, { kind: 'assertion_failed' })
  assert.deepEqual(
    captured.evidence.map((shot) => [shot.app, shot.sessionId, shot.attemptId]),
    [
      ['owner', formatSessionId(captured.attemptId, 'owner'), captured.attemptId],
      ['member', formatSessionId(captured.attemptId, 'member'), captured.attemptId],
    ],
  )
  const [ownerShot, memberShot] = captured.evidence
  assert.ok(ownerShot !== undefined && memberShot !== undefined)
  assert.notEqual(ownerShot.sessionId, memberShot.sessionId)
  assertShowsAccount(run.output, ownerShot.path, accounts.owner)
  assertShowsAccount(run.output, memberShot.path, accounts.member)
  const shotEvents = eventsOf(attemptEvents(run.events, captured.attemptId), 'evidence.captured')
  assert.deepEqual(shotEvents.map((event) => [event.session, event.sessionId]), captured.evidence.map((shot) => [shot.app, shot.sessionId]))
  assertLooksStayWithTheirSession(run, captured.attemptId, accounts)

  assert.deepEqual(filesHolding(run.output, TASK_APP_PASSWORD), [], 'no file of the run holds the password')
})
