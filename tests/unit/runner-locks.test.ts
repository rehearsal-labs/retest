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
