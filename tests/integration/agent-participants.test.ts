import type { AgentSession } from '../../src/agent/session.ts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { accountColour } from '../../fixtures/task-app/shared-records.ts'
import { SessionBudget } from '../../src/runner/sessions.ts'
import { openApp } from './browser-harness.ts'
import { pixelAt } from './participants-harness.ts'
import { agentHost, assertActed, onlyElement, openOn, signIn, waitForText } from './agent-harness.ts'

// Two and four agent sessions as independently signed-in accounts on one app origin, on a real browser: one account
// makes a uniquely referenced record and another reads that exact record through a session of its own; four sessions
// under one owner keep their cookies, storage, looks and frames apart, with a fifth held back by the owner's limit; and
// four sessions typing at the same moment each keep what they typed. Sessions sign in one after another, so that last
// case alone says whether sessions acting at once keep their input apart.

async function seed(appUrl: string, record: { reference: string; title: string; createdBy: string }): Promise<void> {
  const response = await fetch(new URL('/shared/api/seed', appUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(record) })
  assert.equal(response.status, 201, `seeded ${record.reference}`)
}

// Makes a record on the shared page the way an agent does: each field by the reference its look handed out, and the
// button its look of buttons listed as Create record.
async function makeRecord(session: AgentSession, reference: string, title: string): Promise<void> {
  assertActed(await session.act({ kind: 'goto', url: '/shared' }), 'opened the shared page')
  assertActed(await session.act({ kind: 'fill', ref: await onlyElement(session, { by: 'testId', value: 'record-reference' }), value: reference }), 'typed the reference')
  assertActed(await session.act({ kind: 'fill', ref: await onlyElement(session, { by: 'testId', value: 'record-title' }), value: title }), 'typed the title')
  const buttons = await session.observe({ by: 'role', role: 'button' })
  assert.ok(buttons.ok)
  const create = buttons.look.elements.find((element) => element.text === 'Create record')
  assert.ok(create !== undefined)
  assertActed(await session.act({ kind: 'click', ref: create.ref }), 'clicked Create record')
  await waitForText(session, { by: 'testId', value: 'record-status' }, `Created ${reference}`)
}

test('two accounts hand one exact record over through two sessions of their own', async (t) => {
  const app = await openApp(t)
  const { host } = await agentHost(t)
  const reference = `handoff-${randomUUID()}`
  const title = 'Release checklist'
  // Records with the same title, made by someone else, so only the exact reference finds the right one.
  for (const decoy of ['a', 'b']) await seed(app.url, { reference: `decoy-${decoy}-${randomUUID()}`, title, createdBy: 'someone-else' })

  const owner = await openOn(host, { app: 'owner', purpose: 'discovery', baseUrl: app.url })
  const member = await openOn(host, { app: 'member', purpose: 'discovery', baseUrl: app.url })
  await signIn(owner, 'owner-a')
  await signIn(member, 'member-b')
  await makeRecord(owner, reference, title)

  assertActed(await member.act({ kind: 'goto', url: `/shared/record?reference=${encodeURIComponent(reference)}` }), 'opened the record by its reference')
  await waitForText(member, { by: 'testId', value: 'shared-account' }, 'Signed in as member-b')
  await waitForText(member, { by: 'testId', value: 'record-reference-shown' }, reference)
  await waitForText(member, { by: 'testId', value: 'record-owner' }, 'owner-a')
  const requirement = { version: 'handoff-v1' }
  const madeBy = { kind: 'text', id: 'made-by-owner', app: 'member', text: 'Made by owner-a' } as const
  const checked = await member.check(madeBy, requirement)
  assert.ok(checked.ok, checked.ok ? '' : checked.failure.message)
  assert.equal(checked.check.status, 'passed')
  assert.equal(checked.check.sessionId, member.sessionId)

  // The owner's session still shows only the owner, and the app holds exactly one record under the reference.
  await waitForText(owner, { by: 'testId', value: 'shared-account' }, 'Signed in as owner-a')
  assert.deepEqual(app.sharedRecords().filter((record) => record.reference === reference), [{ reference, title, createdBy: 'owner-a' }])

  // A second member session, restored from the first one's saved sign-in, reads the same record and holds the check to
  // the same identity.
  const saved = await member.saveState()
  assert.ok(saved.ok)
  const verification = await openOn(host, { app: 'member', purpose: 'reproduction', baseUrl: app.url, state: saved.state })
  assertActed(await verification.act({ kind: 'goto', url: `/shared/record?reference=${encodeURIComponent(reference)}` }), 'opened the record again')
  const again = await verification.check(madeBy, requirement)
  assert.ok(again.ok, again.ok ? '' : again.failure.message)
  assert.equal(again.check.status, 'passed')
  assert.deepEqual(again.check.identity, checked.check.identity)
  assert.notEqual(again.check.sessionId, checked.check.sessionId)
})

test('four sessions signed in as four accounts keep their cookies, storage, looks and frames apart; a fifth waits for the owner', async (t) => {
  const app = await openApp(t)
  const budget = new SessionBudget({ perOwner: 4, host: 8 })
  const { host } = await agentHost(t, { budget })
  const accounts = ['account-1', 'account-2', 'account-3', 'account-4']
  const sessions = await Promise.all(accounts.map((_, index) => openOn(host, { app: `participant-${index + 1}`, purpose: 'discovery', baseUrl: app.url })))
  assert.equal(new Set(sessions.map((session) => session.sessionId)).size, 4)
  assert.deepEqual([budget.snapshot().host, budget.snapshot().owners.get('agent-1')], [4, 4])

  const fifth = await host.open({ owner: 'agent-1', app: 'participant-5', purpose: 'discovery', target: 'browser', engine: sessions[0]?.engine ?? 'chromium', baseUrl: app.url, waitMs: 200 })
  assert.ok(!fifth.ok)
  assert.match(fifth.failure.message, /^Not run: 1 session for "agent-1" did not come free within 200 ms\. When it gave up, "agent-1" held 4 of 4/)

  for (const [index, session] of sessions.entries()) await signIn(session, accounts[index] ?? '')
  await Promise.all(sessions.map((session) => session.act({ kind: 'goto', url: '/shared' })))
  for (const [index, session] of sessions.entries()) {
    const own = accounts[index] ?? ''
    await waitForText(session, { by: 'testId', value: 'shared-account' }, `Signed in as ${own}`)
    await waitForText(session, { by: 'testId', value: 'stored-user' }, own)
    const look = await session.observe({ by: 'css', selector: 'main' })
    assert.ok(look.ok)
    for (const other of accounts) if (other !== own) assert.equal(JSON.stringify(look.look).includes(other), false, `${session.app}'s look never shows ${other}`)
    const saved = await session.saveState()
    assert.ok(saved.ok)
    const kept = saved.state.storage.origins.flatMap((origin) => origin.localStorage.map((item) => item.value))
    assert.deepEqual(kept.filter((value) => accounts.includes(value)), [own], `${session.app}'s storage holds its own account only`)
    const framed = await session.frame()
    assert.ok(framed.ok)
    const { rgb } = pixelAt(Buffer.from(framed.frame.bytes), 12, 12)
    const expected = accountColour(own)
    assert.ok(rgb.every((value, channel) => Math.abs(value - (expected[channel] ?? 0)) <= 3), `${session.app}'s frame shows the banner of ${own}`)
  }
  const [first, second] = sessions
  assert.ok(first !== undefined && second !== undefined)
  const foreign = await second.act({ kind: 'click', ref: await onlyElement(first, { by: 'testId', value: 'create-record' }) })
  assert.ok(!foreign.result.ok)
  assert.equal(foreign.result.failure.details?.['refused'], 'other-session')

  // The fifth opens once one of the four ends.
  const waiting = host.open({ owner: 'agent-1', app: 'participant-5', purpose: 'discovery', target: 'browser', engine: first.engine, baseUrl: app.url, waitMs: 30_000 })
  assert.ok((await first.end()).ok)
  const opened = await waiting
  assert.ok(opened.ok, opened.ok ? '' : opened.failure.message)
  assert.ok(budget.peak().host <= 4, `the budget saw ${budget.peak().host} sessions at once, at most 4`)
})

test('four sessions type into their own pages at the same moment, and each page holds what its session typed', async (t) => {
  const app = await openApp(t)
  const { host } = await agentHost(t)
  const sessions = await Promise.all(['one', 'two', 'three', 'four'].map((name) => openOn(host, { app: name, purpose: 'discovery', baseUrl: app.url })))
  const opened = await Promise.all(sessions.map((session) => session.act({ kind: 'goto', url: '/login' })))
  for (const action of opened) assertActed(action, 'opened the sign-in page')
  const typed = await Promise.all(sessions.map((session) => session.act({ kind: 'fill', locator: { by: 'testId', value: 'user' }, value: `typed-by-${session.app}` })))
  for (const action of typed) assertActed(action, 'typed the user name')
  const held = await Promise.all(sessions.map(async (session) => {
    const look = await session.observe({ by: 'testId', value: 'user' })
    return look.ok ? look.look.observation.value : look.failure.message
  }))
  assert.deepEqual(held, sessions.map((session) => `typed-by-${session.app}`), 'each field holds the text its own session typed, and nothing of another')
})
