import type { LockLease } from '../../src/runner/locks.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { SharedLocks } from '../../src/runner/locks.ts'

const never = new Promise<void>(() => undefined)

// Lets every promise already settled run its callbacks, so a test sees which leases were granted.
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** A clock the test moves by hand. */
function manualClock(): { now: () => number; advance: (ms: number) => void } {
  let time = 1000
  return { now: () => time, advance: (ms) => void (time += ms) }
}

type Granted = { holder: string; lease: LockLease }

/** Asks for locks and records each grant in `granted`, in the order they come. */
function asker(locks: SharedLocks, granted: Granted[]) {
  return (holder: string, names: readonly string[], position: number, stopped: Promise<void> = never): Promise<LockLease | undefined> => {
    const asked = locks.acquire({ names, position, holder }, stopped)
    void asked.then((lease) => {
      if (lease !== undefined) granted.push({ holder, lease })
    })
    return asked
  }
}

function release(granted: readonly Granted[], holder: string): void {
  const found = granted.find((entry) => entry.holder === holder)
  assert.ok(found !== undefined, `${holder} holds its locks`)
  found.lease.release()
}

describe('SharedLocks', () => {
  test('a free lock is taken at once, and a second holder waits until the first lets it go', async () => {
    const clock = manualClock()
    const locks = new SharedLocks(clock.now)
    const granted: Granted[] = []
    const ask = asker(locks, granted)
    void ask('first', ['inbox'], 5)
    void ask('second', ['inbox'], 1)
    await settle()
    assert.deepEqual(granted.map((entry) => entry.holder), ['first'], 'the lock was free, so the later attempt took it')
    assert.equal(granted[0]?.lease.waitedMs, 0)
    clock.advance(250)
    release(granted, 'first')
    await settle()
    assert.deepEqual(granted.map((entry) => entry.holder), ['first', 'second'])
    assert.equal(granted[1]?.lease.waitedMs, 250, 'the wait is measured from the request to the grant')
    assert.deepEqual(granted[1]?.lease.heldBy, ['first'], 'it names the test that held the lock when it asked')
    assert.deepEqual([...locks.holders()], [['inbox', 'second']])
  })

  test('locks with different names never wait for each other', async () => {
    const locks = new SharedLocks()
    const granted: Granted[] = []
    const ask = asker(locks, granted)
    void ask('inbox user', ['inbox'], 0)
    void ask('account user', ['account'], 1)
    await settle()
    assert.deepEqual(granted.map((entry) => entry.holder), ['inbox user', 'account user'])
  })

  test('waiters are served in the run order, whatever order they asked in', async () => {
    const locks = new SharedLocks()
    const granted: Granted[] = []
    const ask = asker(locks, granted)
    void ask('holder', ['inbox'], 0)
    void ask('fourth', ['inbox'], 4)
    void ask('second', ['inbox'], 2)
    void ask('third', ['inbox'], 3)
    await settle()
    for (const holder of ['holder', 'second', 'third']) {
      release(granted, holder)
      await settle()
    }
    assert.deepEqual(granted.map((entry) => entry.holder), ['holder', 'second', 'third', 'fourth'])
  })

  test('an attempt takes all of its locks at once or none, so two attempts cannot each hold what the other waits for', async () => {
    const locks = new SharedLocks()
    const granted: Granted[] = []
    const ask = asker(locks, granted)
    void ask('inbox user', ['inbox'], 0)
    void ask('both', ['account', 'inbox'], 1)
    await settle()
    assert.deepEqual(granted.map((entry) => entry.holder), ['inbox user'])
    assert.deepEqual([...locks.holders()], [['inbox', 'inbox user']], 'the waiter holds no part of what it asked for')
    release(granted, 'inbox user')
    await settle()
    assert.deepEqual(granted.map((entry) => entry.holder), ['inbox user', 'both'])
    assert.deepEqual([...locks.holders()].sort(), [['account', 'both'], ['inbox', 'both']])
  })

  test('a waiter for two locks is not overtaken by later waiters that take one each', async () => {
    const locks = new SharedLocks()
    const granted: Granted[] = []
    const ask = asker(locks, granted)
    void ask('inbox user', ['inbox'], 0)
    void ask('both', ['inbox', 'account'], 1)
    // The account is free, but a later attempt taking it could keep "both" waiting for ever.
    void ask('account user', ['account'], 2)
    await settle()
    assert.deepEqual(granted.map((entry) => entry.holder), ['inbox user'], 'the earlier waiter keeps the account from later ones')
    release(granted, 'inbox user')
    await settle()
    assert.deepEqual(granted.map((entry) => entry.holder), ['inbox user', 'both'])
    release(granted, 'both')
    await settle()
    assert.deepEqual(granted.map((entry) => entry.holder), ['inbox user', 'both', 'account user'])
  })

  test('a later waiter goes ahead when no earlier waiter wants its lock', async () => {
    const locks = new SharedLocks()
    const granted: Granted[] = []
    const ask = asker(locks, granted)
    void ask('inbox user', ['inbox'], 0)
    void ask('inbox waiter', ['inbox'], 1)
    void ask('account user', ['account'], 2)
    await settle()
    assert.deepEqual(granted.map((entry) => entry.holder), ['inbox user', 'account user'])
  })

  test('a run that stops leaves a waiter holding nothing, and frees its place for the waiters behind it', async () => {
    const locks = new SharedLocks()
    const granted: Granted[] = []
    const ask = asker(locks, granted)
    const stop = Promise.withResolvers<void>()
    void ask('inbox user', ['inbox'], 0)
    const stopped = ask('both', ['inbox', 'account'], 1, stop.promise)
    void ask('account user', ['account'], 2)
    await settle()
    assert.deepEqual(granted.map((entry) => entry.holder), ['inbox user'])
    stop.resolve()
    assert.equal(await stopped, undefined)
    await settle()
    assert.deepEqual(granted.map((entry) => entry.holder), ['inbox user', 'account user'], 'its claim on the account went with it')
    release(granted, 'inbox user')
    await settle()
    assert.equal(locks.holders().get('inbox'), undefined, 'nobody took the stopped waiter\'s place in the inbox')
  })

  test('a lease lets go once, however often it is released', async () => {
    const locks = new SharedLocks()
    const granted: Granted[] = []
    const ask = asker(locks, granted)
    void ask('first', ['inbox'], 0)
    await settle()
    release(granted, 'first')
    void ask('second', ['inbox'], 1)
    await settle()
    release(granted, 'first')
    assert.deepEqual([...locks.holders()], [['inbox', 'second']], 'releasing the first lease again leaves the second holder alone')
  })

  test('a stop that comes after the grant leaves the lease with its holder, who releases it', async () => {
    const locks = new SharedLocks()
    const stop = Promise.withResolvers<void>()
    const lease = await locks.acquire({ names: ['inbox'], position: 0, holder: 'first' }, stop.promise)
    stop.resolve()
    await settle()
    assert.ok(lease !== undefined)
    assert.deepEqual([...locks.holders()], [['inbox', 'first']])
    lease.release()
    assert.equal(locks.holders().size, 0)
  })
})

describe('SharedLocks with a bound', () => {
  test('a waiter waits as long as the holder is inside its lease, past its bound', async () => {
    const locks = new SharedLocks()
    const held = await locks.reserve({ names: ['inbox'], position: 0, holder: 'holder' }, never)
    assert.ok(held.ok)
    const waiting = locks.reserve({ names: ['inbox'], position: 1, holder: 'waiter' }, never, { pastLeaseMs: 30 })
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(locks.waiting(), 1, 'four times its bound later, it still waits behind a live lease')
    held.lease.release()
    const granted = await waiting
    assert.ok(granted.ok, 'it got the lock once the holder let go')
    assert.deepEqual(granted.lease.heldBy, ['holder'])
  })

  test('behind an expired lease a waiter gives up after its bound, holding nothing and naming what it waited for and who held it', async () => {
    const locks = new SharedLocks()
    const held = await locks.reserve({ names: ['inbox', 'account'], position: 0, holder: 'holder' }, never)
    assert.ok(held.ok)
    const startedAt = performance.now()
    const waiting = locks.reserve({ names: ['inbox', 'drafts'], position: 1, holder: 'waiter' }, never, { pastLeaseMs: 60 })
    await settle()
    held.lease.expire()
    const refused = await waiting
    assert.ok(!refused.ok)
    assert.equal(refused.reason, 'timed_out')
    assert.deepEqual([refused.waitingFor, refused.heldBy], [['inbox'], ['holder']])
    assert.ok(performance.now() - startedAt >= 55, 'it waited its bound after the lease expired')
    assert.deepEqual([...locks.holders()].sort(), [['account', 'holder'], ['inbox', 'holder']], 'the waiter took no part of what it asked for')
    assert.equal(locks.waiting(), 0)
  })

  test('only the time behind an expired lease counts: a live holder pauses the count, and a free lock ends it', async () => {
    const locks = new SharedLocks()
    const first = await locks.reserve({ names: ['inbox'], position: 0, holder: 'first' }, never)
    const second = await locks.reserve({ names: ['account'], position: 1, holder: 'second' }, never)
    assert.ok(first.ok && second.ok)
    const waiting = locks.reserve({ names: ['inbox', 'account'], position: 2, holder: 'waiter' }, never, { pastLeaseMs: 80 })
    first.lease.expire()
    // The account is held by a live lease, so the inbox's expired holder does not start the count.
    await new Promise((resolve) => setTimeout(resolve, 160))
    assert.equal(locks.waiting(), 1, 'still waiting, twice its bound later')
    second.lease.release()
    first.lease.releaseOne('inbox')
    const granted = await waiting
    assert.ok(granted.ok)
  })

  test('a waiter kept back only by an earlier waiter does not count, and is served when that one gives up', async () => {
    const locks = new SharedLocks()
    const holder = await locks.reserve({ names: ['inbox'], position: 0, holder: 'holder' }, never)
    assert.ok(holder.ok)
    const earlier = locks.reserve({ names: ['inbox', 'account'], position: 1, holder: 'earlier' }, never, { pastLeaseMs: 40 })
    const later = locks.reserve({ names: ['account'], position: 2, holder: 'later' }, never, { pastLeaseMs: 10 })
    await settle()
    holder.lease.expire()
    const gaveUp = await earlier
    assert.equal(gaveUp.ok ? 'granted' : gaveUp.reason, 'timed_out')
    const served = await later
    assert.ok(served.ok, 'the later waiter, with the shorter bound, was served once the earlier one left')
  })

  test('locks are given back one at a time, and each frees its waiters as it goes', async () => {
    const locks = new SharedLocks()
    const held = await locks.reserve({ names: ['inbox', 'account'], position: 0, holder: 'holder' }, never)
    assert.ok(held.ok)
    const granted: string[] = []
    void locks.reserve({ names: ['account'], position: 1, holder: 'account user' }, never).then((grant) => grant.ok && granted.push('account user'))
    void locks.reserve({ names: ['inbox'], position: 2, holder: 'inbox user' }, never).then((grant) => grant.ok && granted.push('inbox user'))
    held.lease.releaseOne('account')
    await settle()
    assert.deepEqual(granted, ['account user'])
    assert.equal(locks.holders().get('inbox'), 'holder')
    held.lease.releaseOne('account')
    held.lease.release()
    await settle()
    assert.deepEqual(granted, ['account user', 'inbox user'])
  })

  test('a stopped run withdraws a bounded waiter at once, and names what it waited for', async () => {
    const locks = new SharedLocks()
    const held = await locks.reserve({ names: ['inbox'], position: 0, holder: 'holder' }, never)
    assert.ok(held.ok)
    const stop = Promise.withResolvers<void>()
    const waiting = locks.reserve({ names: ['inbox'], position: 1, holder: 'waiter' }, stop.promise, { pastLeaseMs: 60_000 })
    stop.resolve()
    const withdrawn = await waiting
    assert.ok(!withdrawn.ok)
    assert.deepEqual([withdrawn.reason, withdrawn.waitingFor, withdrawn.heldBy], ['stopped', ['inbox'], ['holder']])
    assert.equal(locks.waiting(), 0)
  })
})

describe('SharedLocks shared by several runs', () => {
  test("a record names only the holders of its own run, and counts the locks another run's tests held", async () => {
    const locks = new SharedLocks()
    const own = await locks.reserve({ names: ['desktop'], position: 0, holder: 'run one > first', scope: 'run-1' }, never)
    const other = await locks.reserve({ names: ['folder'], position: 0, holder: 'run two > first', scope: 'run-2' }, never)
    assert.ok(own.ok && other.ok)
    const waiting = locks.reserve({ names: ['desktop', 'folder'], position: 0, holder: 'run one > second', scope: 'run-1' }, never)
    own.lease.release()
    other.lease.release()
    const granted = await waiting
    assert.ok(granted.ok)
    assert.deepEqual([granted.lease.heldBy, granted.lease.heldElsewhere], [['run one > first'], 1])
    assert.deepEqual(locks.waiters(), [])
  })
})
