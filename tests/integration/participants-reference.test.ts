import type { TestContext } from 'node:test'
import type { FinishedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openApp } from './browser-harness.ts'
import { budgets, configSource, eventsOf, filesHolding, runProject, testNamed, writeProject } from './cli-harness.ts'
import { assertLooksStayWithTheirSession, signInSetup, TASK_APP_PASSWORD } from './participants-harness.ts'

// Release 1, the two-account reference workflow: the owner makes a record under a reference the test generated, and
// the member, signed in as another account, reads that exact record by its reference. Records that share its title,
// made earlier by someone else, are on the server too, so a test that found the record by its title could read the
// wrong one. Each attempt generates a reference of its own, so it can never pass on a record an earlier attempt left.

const file = 'tests/reference.retest.ts'
const accounts = { owner: 'owner-a', member: 'member-b' }
const title = 'Quarterly report'
const variable = 'RETEST_E2E_PARTICIPANTS_PASSWORD'

const tests = `import { randomUUID } from 'node:crypto'
import { expect, secret, test } from '@rehearsal-labs/retest'

${signInSetup('owner-account', 'owner', accounts.owner)}

${signInSetup('member-account', 'member', accounts.member)}

test('the member reads the exact record the owner made', { apps: ['owner', 'member'], state: { owner: 'owner-account', member: 'member-account' } }, async ({ owner, member }) => {
  const reference = 'record-' + randomUUID()
  await owner.goto('/shared')
  await expect(owner.getByTestId('shared-account')).toHaveText('Signed in as ${accounts.owner}')
  await owner.getByLabel('Reference').fill(reference)
  await owner.getByLabel('Title').fill(${JSON.stringify(title)})
  await owner.getByRole('button', { name: 'Create record' }).click()
  await expect(owner.getByTestId('record-status')).toHaveText('Created ' + reference)
  await member.goto('/shared/record?reference=' + encodeURIComponent(reference))
  await expect(member.getByTestId('shared-account')).toHaveText('Signed in as ${accounts.member}')
  await expect(member.getByTestId('record-reference-shown')).toHaveText(reference)
  await expect(member.getByTestId('record-title-shown')).toHaveText(${JSON.stringify(title)})
  await expect(member.getByTestId('record-owner')).toHaveText('${accounts.owner}')
})
`

async function project(t: TestContext, url: string): Promise<string> {
  return writeProject(t, {
    'retest.config.ts': configSource(`{
  apps: { owner: chrome({ baseUrl: ${JSON.stringify(url)} }), member: chrome({ baseUrl: ${JSON.stringify(url)} }) },
  states: ['owner-account', 'member-account'],
  secrets: { password: env('${variable}') },
}`),
    [file]: tests,
  })
}

// The reference this run's member read, as the parent recorded the assertion that checked it.
function referenceRead(run: FinishedRun): string {
  const result = testNamed(run, 'the member reads the exact record the owner made')
  const checked = eventsOf(run.events, 'assertion.passed').find(
    (event) => event.attemptId === result.attemptId && event.session === 'member' && event.locator?.by === 'testId' && event.locator.value === 'record-reference-shown',
  )
  assert.ok(checked?.expected !== null && checked?.expected !== undefined, 'the parent recorded the reference the member checked')
  assert.equal(checked.judgedBy, 'parent')
  return checked.expected.text
}

test('the owner makes a record under a reference the test generated, and the member reads that exact record, not one with the same title', async (t) => {
  const app = await openApp(t)
  for (const [reference, createdBy] of [
    ['decoy-1', 'someone-else'],
    ['decoy-2', 'owner-a'],
  ]) {
    const seeded = await fetch(new URL('/shared/api/seed', app.url), { method: 'POST', body: JSON.stringify({ reference, title, createdBy }) })
    assert.equal(seeded.status, 201)
  }
  const root = await project(t, app.url)
  const first = await runProject(t, root, { env: { [variable]: TASK_APP_PASSWORD }, timeouts: budgets() })
  assert.equal(first.exit.code, 0, first.stderr)
  const second = await runProject(t, root, { env: { [variable]: TASK_APP_PASSWORD }, timeouts: budgets() })
  assert.equal(second.exit.code, 0, second.stderr)

  const read = [referenceRead(first), referenceRead(second)]
  assert.notEqual(read[0], read[1], 'each attempt generated a reference of its own')
  for (const reference of read) assert.match(reference, /^record-[0-9a-f-]{36}$/)
  const records = app.sharedRecords()
  assert.deepEqual(
    records.map((record) => [record.title, record.createdBy, record.reference.startsWith('record-') ? 'generated' : record.reference]),
    [
      [title, 'someone-else', 'decoy-1'],
      [title, 'owner-a', 'decoy-2'],
      [title, 'owner-a', 'generated'],
      [title, 'owner-a', 'generated'],
    ],
    'four records share the title, so the title alone could not say which one the member read',
  )
  assert.deepEqual(records.slice(2).map((record) => record.reference), read, 'the member of each run read the record the owner of that run made')

  for (const run of [first, second]) {
    const result = testNamed(run, 'the member reads the exact record the owner made')
    assertLooksStayWithTheirSession(run, result.attemptId, accounts)
    const made = eventsOf(run.events, 'action.completed').filter((event) => event.attemptId === result.attemptId).map((event) => `${event.session} ${event.command}`)
    assert.deepEqual(made, ['owner goto', 'owner fill', 'owner fill', 'owner click', 'member goto'], 'the owner made the record and the member only read it')
    assert.deepEqual(filesHolding(run.output, TASK_APP_PASSWORD), [])
  }
})
