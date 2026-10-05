import type { TestContext } from 'node:test'
import type { AgentOpenRequest } from '../../src/agent/host.ts'
import type { AgentSession } from '../../src/agent/session.ts'
import type { HostCheck } from '../../src/protocol/host-check.ts'
import type { AgentFakeOptions, AgentFakePage } from './agent-fakes.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { checkIdentity } from '../../src/agent/checks.ts'
import { AgentHost } from '../../src/agent/host.ts'
import { contentSha256, pageCheckContent, Requirements } from '../../src/runner/fingerprint.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { SessionBudget } from '../../src/runner/sessions.ts'
import { agentFakeLauncher } from './agent-fakes.ts'

// A host's required check run by an agent session: its identity is the one the runner gives the same check in a test,
// the same in every session and attempt, and a changed check cannot pass for the frozen one. The check reads the
// session's own page through the runner's own host check, decides as a test's would, and records which session ran it
// beside its identity, never inside it.

const madeBy: HostCheck = { kind: 'text', id: 'made-by-owner', text: 'Made by owner-a' }
const requirement = { version: 'handoff-v1' }

async function openSessions(t: TestContext, ...requests: Partial<AgentOpenRequest>[]): Promise<{ session: AgentSession; page: AgentFakePage }[]> {
  return openSessionsWith(t, {}, ...requests)
}

async function openSessionsWith(t: TestContext, fake: AgentFakeOptions, ...requests: Partial<AgentOpenRequest>[]): Promise<{ session: AgentSession; page: AgentFakePage }[]> {
  const { launch, browsers } = agentFakeLauncher(fake)
  const host = new AgentHost({ targets: { chrome: { engine: 'chromium', executablePath: '/fake/chrome' } }, budget: new SessionBudget({ perOwner: 4, host: 4 }), logFolder: '/tmp/retest-agent-unit-logs', launchers: { chromium: launch }, timeouts: { assertion: 200, cleanup: 200 }, secrets: { values: { password: { value: 'correct horse battery staple' } } } })
  t.after(() => host.close())
  const opened: { session: AgentSession; page: AgentFakePage }[] = []
  for (const request of requests) {
    const answer = await host.open({ owner: 'agent-1', app: 'member', purpose: 'discovery', target: 'chrome', engine: 'chromium', ...request })
    assert.ok(answer.ok, answer.ok ? '' : answer.failure.message)
    const page = browsers[0]?.pages.at(-1)
    assert.ok(page !== undefined)
    opened.push({ session: answer.session, page })
  }
  return opened
}

describe('required check identity', () => {
  test("a check's identity is the one the runner gives it in a test held to the same requirement", () => {
    const identified = checkIdentity(madeBy, requirement, 'member', new Redactor())
    assert.ok(identified.ok)
    const runner = new Requirements(requirement, (text) => text).forTest([{ check: madeBy, app: 'member' }], [], { byName: new Map(), defaultJudge: undefined })
    assert.deepEqual(identified.identity, { version: 'handoff-v1', ...runner?.checks[0] })
    assert.equal(identified.identity.sha256, contentSha256('page', pageCheckContent(madeBy)))
  })

  test('the same check in a discovery and a reproduction session has one identity; each records its own session', async (t) => {
    const [discovery, reproduction] = await openSessions(t, { purpose: 'discovery' }, { purpose: 'reproduction' })
    assert.ok(discovery !== undefined && reproduction !== undefined)
    for (const { page } of [discovery, reproduction]) page.show([{ testId: 'record-owner', text: 'Made by owner-a' }])
    const first = await discovery.session.check(madeBy, requirement)
    const second = await reproduction.session.check(madeBy, requirement)
    assert.ok(first.ok && second.ok)
    assert.deepEqual(first.check.identity, second.check.identity)
    assert.deepEqual([first.check.status, second.check.status], ['passed', 'passed'])
    assert.notEqual(first.check.sessionId, second.check.sessionId)
    assert.deepEqual([first.check.sessionId, second.check.sessionId], [discovery.session.sessionId, reproduction.session.sessionId])
  })

  test('a changed check under a frozen requirement is refused by name, and a missing one too', () => {
    const frozen = checkIdentity(madeBy, requirement, 'member', new Redactor())
    assert.ok(frozen.ok)
    const checks = { 'made-by-owner': frozen.identity.sha256 }
    assert.ok(checkIdentity(madeBy, { version: 'handoff-v1', checks }, 'member', new Redactor()).ok)
    const changed = checkIdentity({ ...madeBy, text: 'Made by someone' }, { version: 'handoff-v1', checks }, 'member', new Redactor())
    assert.ok(!changed.ok)
    assert.match(changed.failure.message, /^"made-by-owner" changed since the requirement "handoff-v1" froze it: its content hashes to [0-9a-f]{64}, the requirement holds [0-9a-f]{64}\. A changed check needs a new version\.$/)
    const added = checkIdentity({ ...madeBy, id: 'other' }, { version: 'handoff-v1', checks }, 'member', new Redactor())
    assert.ok(!added.ok)
    assert.match(added.failure.message, /is not in the requirement "handoff-v1"\. A new check needs a new version\./)
  })

  test('a check with no id, of another app, or holding a secret has no identity', () => {
    const redactor = new Redactor()
    redactor.learn('password', 'correct horse battery staple')
    const unnamed = checkIdentity({ kind: 'text', text: 'Made by owner-a' }, requirement, 'member', redactor)
    assert.ok(!unnamed.ok)
    assert.match(unnamed.failure.message, /needs an id/)
    const other = checkIdentity({ ...madeBy, app: 'owner' }, requirement, 'member', redactor)
    assert.ok(!other.ok)
    assert.match(other.failure.message, /reads the page of "owner", and this session is "member"/)
    const secret = checkIdentity({ ...madeBy, text: 'correct horse battery staple' }, requirement, 'member', redactor)
    assert.ok(!secret.ok)
    assert.match(secret.failure.message, /holds the value of a secret/)
  })

  test("a check that fails is a result naming its id, read from the session's own page", async (t) => {
    const [only] = await openSessions(t, {})
    assert.ok(only !== undefined)
    only.page.show([{ testId: 'record-missing', text: 'No record has that reference.' }])
    const checked = await only.session.check(madeBy, requirement, { timeoutMs: 120 })
    assert.ok(checked.ok)
    assert.equal(checked.check.status, 'failed')
    assert.equal(checked.check.failure?.class, 'host_check_failed')
    assert.equal(checked.check.failure?.details?.['checkId'], 'made-by-owner')
    // The runner's own words for the same check in a test.
    assert.match(checked.check.failure?.message ?? '', /^The host check "made-by-owner" on member failed: the page does not show "Made by owner-a"\. Looked \d+ times in 120 ms\.$/)
    assert.ok(checked.check.attempts > 1, 'it looked again until its time ran out')
  })

  test('a read the page did not answer in its time is looked at again, never a failure of the app or a lost page', async (t) => {
    const [late] = await openSessionsWith(t, { lateReads: 2 }, {})
    assert.ok(late !== undefined)
    late.page.show([{ testId: 'record-owner', text: 'Made by owner-a' }])
    const checked = await late.session.check(madeBy, requirement, { timeoutMs: 2000 })
    assert.ok(checked.ok)
    assert.equal(checked.check.status, 'passed', checked.check.failure?.message)
    assert.equal(checked.check.attempts, 3)
  })

  test('a page that answers no read in the whole time could not be read, which says nothing about the app', async (t) => {
    const [silent] = await openSessionsWith(t, { lateReads: 1000 }, {})
    assert.ok(silent !== undefined)
    const checked = await silent.session.check(madeBy, requirement, { timeoutMs: 150 })
    assert.ok(checked.ok)
    assert.equal(checked.check.status, 'failed')
    assert.equal(checked.check.failure?.class, 'session_lost')
    assert.match(checked.check.failure?.message ?? '', /^The page of member did not answer a host check within 150 ms, so Retest could not read it\.$/)
  })

  test("a check is decided by the runner's own host check: a name labels it, case is ignored when asked, and a lost browser stops it", async (t) => {
    const [only] = await openSessions(t, {})
    assert.ok(only !== undefined)
    only.page.show([{ testId: 'record-owner', text: 'made by OWNER-A' }])
    const named = await only.session.check({ ...madeBy, name: 'Record maker', ignoreCase: true, text: 'Made by someone-else' }, requirement, { timeoutMs: 100 })
    assert.ok(named.ok)
    assert.match(named.check.failure?.message ?? '', /^The host check "Record maker" on member failed: the page does not show "Made by someone-else", ignoring case\./)
    const ignoring = await only.session.check({ ...madeBy, ignoreCase: true }, requirement)
    assert.ok(ignoring.ok)
    assert.equal(ignoring.check.status, 'passed')
    only.page.browser.connected = false
    const lost = await only.session.check(madeBy, requirement, { timeoutMs: 2000 })
    assert.ok(lost.ok)
    assert.equal(lost.check.failure?.class, 'session_lost')
    assert.match(lost.check.failure?.message ?? '', /^The browser of member was gone, so Retest could not run the host check\.$/)
    assert.equal(lost.check.attempts, 1, 'the browser was asked about before the first read, and the check stopped there')
  })
})
