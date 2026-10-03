import type { SessionGrant, SessionLease, SessionRequest } from '../../src/runner/sessions.ts'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, test } from 'node:test'
import { SessionBudget, sessionOptionsProblem, sessionRefusal } from '../../src/runner/sessions.ts'

const never = new Promise<void>(() => undefined)

// Lets every promise already settled run its callbacks, so a test sees which reservations were granted.
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** A clock the test moves by hand. */
function manualClock(): { now: () => number; advance: (ms: number) => void } {
  let time = 1000
  return { now: () => time, advance: (ms) => void (time += ms) }
}

type Granted = { holder: string; lease: SessionLease }

/** Reserves sessions and records each grant in `granted`, in the order they come. */
function asker(budget: SessionBudget, granted: Granted[]) {
  return (holder: string, owner: string, count: number, options: { waitMs?: number; stopped?: Promise<void> } = {}): Promise<SessionGrant> => {
    const request: SessionRequest = { owner, count, holder, waitMs: options.waitMs ?? 60_000 }
    const asked = budget.reserve(request, options.stopped ?? never)
    void asked.then((grant) => {
      if (grant.ok) granted.push({ holder, lease: grant.lease })
    })
    return asked
  }
}

function release(granted: readonly Granted[], holder: string): void {
  const found = granted.find((entry) => entry.holder === holder)
  assert.ok(found !== undefined, `${holder} holds its sessions`)
  found.lease.release()
}

function holders(granted: readonly Granted[]): string[] {
  return granted.map((entry) => entry.holder)
}

describe('SessionBudget', () => {
  test('free sessions are reserved at once, and a request past the limit waits until sessions come back', async () => {
    const clock = manualClock()
    const budget = new SessionBudget({ perOwner: 2, host: 2 }, clock.now)
    const granted: Granted[] = []
    const ask = asker(budget, granted)
    void ask('first', 'agent-1', 2)
    void ask('second', 'agent-1', 1)
    await settle()
    assert.deepEqual(holders(granted), ['first'])
    assert.deepEqual(granted[0]?.lease.active, { owner: 2, host: 2 })
    assert.equal(granted[0]?.lease.waitedMs, 0)
    clock.advance(400)
    release(granted, 'first')
    await settle()
    assert.deepEqual(holders(granted), ['first', 'second'])
    assert.equal(granted[1]?.lease.waitedMs, 400, 'the wait runs from the request to the grant')
    assert.deepEqual(granted[1]?.lease.active, { owner: 1, host: 1 })
  })

  test('a request for several sessions takes all of them at once or none, and is never overtaken forever by requests for one', async () => {
    const budget = new SessionBudget({ perOwner: 4, host: 3 })
    const granted: Granted[] = []
    const ask = asker(budget, granted)
    void ask('holds two', 'agent-1', 2)
    void ask('needs three', 'agent-2', 3)
    void ask('needs one', 'agent-3', 1)
    await settle()
    assert.deepEqual(holders(granted), ['holds two'], 'one session is free, but the three-session request takes none of it and keeps it from the one after')
    assert.deepEqual(budget.snapshot().host, 2, 'no partial capacity is held while it waits')
    release(granted, 'holds two')
    await settle()
    assert.deepEqual(holders(granted), ['holds two', 'needs three'], 'it took all three at once')
    release(granted, 'needs three')
    await settle()
    assert.deepEqual(holders(granted), ['holds two', 'needs three', 'needs one'])
  })

  test("an owner at its own limit waits without keeping another owner's request waiting, and keeps its place among its own", async () => {
    const budget = new SessionBudget({ perOwner: 2, host: 4 })
    const granted: Granted[] = []
    const ask = asker(budget, granted)
    void ask('a1', 'agent-a', 2)
    void ask('a2', 'agent-a', 1)
    void ask('b1', 'agent-b', 2)
    void ask('a3', 'agent-a', 1)
    await settle()
    assert.deepEqual(holders(granted), ['a1', 'b1'], 'agent-b is served while agent-a waits on its own limit')
    release(granted, 'a1')
    await settle()
    assert.deepEqual(holders(granted), ['a1', 'b1', 'a2', 'a3'], "agent-a's waiters are served in the order they asked")
    const { host, owners } = budget.snapshot()
    assert.equal(host, 4)
    assert.deepEqual([...owners].sort(), [
      ['agent-a', 2],
      ['agent-b', 2],
    ])
  })

  test('a request no limit could grant is refused at once and holds nothing', async () => {
    const budget = new SessionBudget({ perOwner: 2, host: 3 })
    const grant = await budget.reserve({ owner: 'agent-1', count: 3, holder: 'four apps', waitMs: 1000 }, never)
    assert.equal(grant.ok, false)
    assert.equal(grant.ok ? '' : grant.reason, 'too_many')
    assert.equal(budget.snapshot().waiting, 0)
    const refusal = sessionRefusal(grant.ok ? assert.fail('refused') : grant, { owner: 'agent-1', count: 3, holder: 'four apps', waitMs: 1000 }, budget.limits)
    assert.equal(refusal.class, 'setup_failed')
    assert.match(refusal.message, /^Not run: the test needs 3 sessions at once, more than the limit of 2 for each owner, so it could never start\.$/)
  })

  test('a wait is finite: a request that gives up holds nothing, and the requests behind it are served', async () => {
    const budget = new SessionBudget({ perOwner: 3, host: 3 })
    const granted: Granted[] = []
    const ask = asker(budget, granted)
    void ask('holds two', 'agent-1', 2)
    const waiting = ask('needs two', 'agent-2', 2, { waitMs: 50 })
    void ask('needs one', 'agent-3', 1)
    await settle()
    assert.deepEqual(holders(granted), ['holds two'], 'the waiting request keeps the free session for itself')
    const gaveUp = await waiting
    assert.equal(gaveUp.ok, false)
    assert.equal(gaveUp.ok ? '' : gaveUp.reason, 'timed_out')
    assert.ok(!gaveUp.ok && gaveUp.waitedMs >= 40, 'it waited about its whole time')
    await settle()
    assert.deepEqual(holders(granted), ['holds two', 'needs one'], 'once it left, the one behind it got the free session')
    assert.equal(budget.snapshot().host, 3)
    const refusal = sessionRefusal(gaveUp.ok ? assert.fail('refused') : gaveUp, { owner: 'agent-2', count: 2, holder: 'needs two', waitMs: 50 }, budget.limits)
    assert.match(refusal.message, /^Not run: 2 sessions for "agent-2" did not come free within 50 ms\. When it gave up, "agent-2" held 0 of 3 and the host 2 of 3\.$/)
    assert.equal(refusal.details?.['waitedMs'], gaveUp.ok ? 0 : gaveUp.waitedMs)
  })

  test('cancelling releases queued and acquired reservations alike', async () => {
    const budget = new SessionBudget({ perOwner: 2, host: 2 })
    const granted: Granted[] = []
    const ask = asker(budget, granted)
    const stop = Promise.withResolvers<void>()
    void ask('running', 'agent-1', 2, { stopped: stop.promise })
    const queued = ask('queued', 'agent-1', 1, { stopped: stop.promise })
    await settle()
    assert.deepEqual(budget.snapshot().waiting, 1)
    stop.resolve()
    const withdrawn = await queued
    assert.equal(withdrawn.ok ? '' : withdrawn.reason, 'stopped')
    assert.equal(budget.snapshot().waiting, 0, 'the queued request left')
    release(granted, 'running')
    release(granted, 'running')
    assert.deepEqual(budget.snapshot(), { host: 0, owners: new Map(), waiting: 0 }, 'released once, however often it is asked')
    const again = await budget.reserve({ owner: 'agent-2', count: 2, holder: 'next run', waitMs: 10 }, never)
    assert.equal(again.ok, true, 'the whole budget is free for the next run')
  })

  test('two owners drawing at once from one host budget never hold more than it allows, and both get through', async () => {
    const budget = new SessionBudget({ perOwner: 3, host: 4 })
    let active = 0
    let most = 0
    const ownerActive = new Map<string, number>()
    const ownerMost = new Map<string, number>()
    const work = async (owner: string, index: number): Promise<string> => {
      const count = 1 + (index % 2)
      const grant = await budget.reserve({ owner, count, holder: `${owner}-${index}`, waitMs: 10_000 }, never)
      assert.ok(grant.ok, `${owner}-${index} got its sessions`)
      active += count
      ownerActive.set(owner, (ownerActive.get(owner) ?? 0) + count)
      most = Math.max(most, active)
      ownerMost.set(owner, Math.max(ownerMost.get(owner) ?? 0, ownerActive.get(owner) ?? 0))
      await sleep(1 + ((index * 7) % 5))
      active -= count
      ownerActive.set(owner, (ownerActive.get(owner) ?? 0) - count)
      grant.lease.release()
      return owner
    }
    const done = await Promise.all(Array.from({ length: 40 }, (_, index) => work(index % 3 === 0 ? 'agent-b' : 'agent-a', index)))
    assert.equal(done.filter((owner) => owner === 'agent-b').length, 14, 'every request of the smaller owner was served')
    assert.ok(most <= 4, `the host held ${most} sessions at once, at most 4`)
    for (const [owner, peak] of ownerMost) assert.ok(peak <= 3, `${owner} held ${peak} sessions at once, at most 3`)
    assert.ok(budget.peak().host <= 4 && budget.peak().host >= 3, 'the budget saw the host near its limit')
    assert.deepEqual(budget.snapshot(), { host: 0, owners: new Map(), waiting: 0 })
  })

  test('a limit that is not a whole number from 1 is refused when the budget is made', () => {
    assert.throws(() => new SessionBudget({ perOwner: 0, host: 4 }), /The session limit perOwner must be a whole number from 1, received 0\./)
    assert.throws(() => new SessionBudget({ perOwner: 2, host: 1.5 }), /The session limit host must be a whole number from 1, received 1\.5\./)
  })
})

describe('the sessions option', () => {
  test('names an owner and a budget, and may give a wait', () => {
    const budget = new SessionBudget({ perOwner: 1, host: 1 })
    assert.equal(sessionOptionsProblem(undefined), undefined)
    assert.equal(sessionOptionsProblem({ owner: 'agent-1', budget, waitMs: 500 }), undefined)
    assert.equal(sessionOptionsProblem({ owner: 'agent-1', budget: { perOwner: 1, host: 1 } })?.message, 'sessions.budget: expected a SessionBudget, received object')
    const several = sessionOptionsProblem({ owner: '', budget, waitMs: 0, limit: 2 })
    assert.equal(several?.class, 'usage')
    assert.match(several?.message ?? '', /^The sessions option has 3 problems:\n {2}sessions\.limit: unknown key\n {2}sessions\.owner: expected the owner's name/)
    assert.match(several?.message ?? '', /sessions\.waitMs: expected a whole number of milliseconds from 1 to 2147483647, received 0/)
    assert.match(sessionOptionsProblem({ owner: 'two\nlines', budget })?.message ?? '', /^sessions\.owner: /)
  })
})
