import type { NewPageOptions, OwnedPage, WebRuntimeIdentity } from '../../src/browser/contract.ts'
import type { ElectronLaunchOptions, ElectronRuntime } from '../../src/browser/electron.ts'
import type { LoadedApp, LoadedTarget } from '../../src/config/loaded.ts'
import type { RetestEvent } from '../../src/protocol/events.ts'
import type { RunResult, TestResult } from '../../src/protocol/result.ts'
import type { Reporter } from '../../src/reporters/reporter.ts'
import type { LaunchElectron } from '../../src/runner/browser-pool.ts'
import type { RunOptions } from '../../src/runner/contract.ts'
import type { AcquiredStage, HeldApp, ResourceGrant, ResourceLease, ResourceNeed, ResourceRequest } from '../../src/runner/resources.ts'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, test } from 'node:test'
import { configFileName, loadConfig } from '../../src/config/load.ts'
import { maxTimeout } from '../../src/protocol/timeouts.ts'
import { testCard } from '../../src/reporters/failure-card.ts'
import { renderCard } from '../../src/reporters/human-card.ts'
import { createHumanReporter } from '../../src/reporters/human.ts'
import { RunRecord } from '../../src/reporters/run-record.ts'
import { createStyle } from '../../src/reporters/style.ts'
import { runTargets } from '../../src/reporters/targets.ts'
import { SharedLocks } from '../../src/runner/locks.ts'
import { bounded } from '../../src/runner/bounded.ts'
import { acquireResources, acquisitionOrder, compareNeeds, describeLeaseParts, folderKey, hostResources, leasePart, partFree, releaseOrder, resourceNeeds, sessionResource } from '../../src/runner/resources.ts'
import { RunSession } from '../../src/runner/run-session.ts'
import { resolveSecrets } from '../../src/runner/secrets.ts'
import { SessionBudget } from '../../src/runner/sessions.ts'
import { RunStore } from '../../src/store/run-store.ts'
import { FakeBrowser, fakeLauncher } from '../support/fake-browser.ts'
import { fakeExecutable, tempProject } from '../support/project.ts'
import { newRunFolder, quickTimeouts, readEvents } from '../support/run-harness.ts'
import { tempFolder } from '../support/temp-folder.ts'
import { capture, plain } from './reporters-fixtures.ts'

// The runner's resources with fakes: the acquisition order, freedom from deadlock under contention, the bound behind
// an expired lease, release, a stopped run, the interactive desktop on a stand-in for the native runtime, and the table
// one process's runs share; then whole runs on the fake browser and a fake Electron launcher. Real Chrome is in
// tests/integration/resources.test.ts.

const never = new Promise<void>(() => undefined)

// Lets every promise already settled run its callbacks.
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

test('a maximum budget plus grace never becomes a one-millisecond timeout', async () => {
  const work = Promise.withResolvers<string>()
  const waiting = bounded(work.promise, maxTimeout + 1000)
  await sleep(5)
  work.resolve('finished within budget')
  assert.deepEqual(await waiting, { status: 'done', value: 'finished within budget' })
})

test('final log redaction reaches nested native logs without following links to other files', () => {
  const store = RunStore.create(newRunFolder())
  const nested = join(store.directory, 'logs', 'native', 'attempt', 'app', 'target')
  mkdirSync(nested, { recursive: true })
  const log = join(nested, 'executor.log')
  writeFileSync(log, 'secret learned later')
  const outside = join(tempFolder('untouched-log-'), 'user.txt')
  writeFileSync(outside, 'secret learned later')
  symlinkSync(outside, join(nested, 'user-link.log'))
  try {
    store.redactLogs((text) => text.replaceAll('secret learned later', '[redacted]'))
    assert.equal(readFileSync(log, 'utf8'), '[redacted]')
    assert.equal(readFileSync(outside, 'utf8'), 'secret learned later')
  } finally { store.close() }
})

function app(name: string, ...targets: LoadedTarget[]): [string, LoadedApp] {
  return [name, { name, targets: new Map(targets.map((target) => [target.name, target])) }]
}

const macos: LoadedTarget = { name: 'macos', platform: 'macos', appPath: '/Applications/TaskDesk.app' }
const iphone: LoadedTarget = { name: 'ios', platform: 'ios-simulator', appPath: '/build/TaskPhone.app', device: 'iPhone 17', runtime: 'iOS 26.5' }
const chrome: LoadedTarget = { name: 'chrome', browser: 'chrome', channel: 'stable', headless: true }
const folder = (path: string): LoadedTarget => ({ name: 'electron', browser: 'electron', executablePath: '/opt/Electron', appPath: '/work/desk', args: [], userDataDir: path })
const ownFolder: LoadedTarget = { name: 'electron', browser: 'electron', executablePath: '/opt/Electron', appPath: '/work/desk', args: [] }

// The named data folders live on a volume the case probe can write to; their paths never exist.
const dataRoot = tempFolder('data-')
const folderA = join(dataRoot, 'a')
const folderB = join(dataRoot, 'b')
const escapedB = folderB.replaceAll(/[.*+?^${}()|[\]\\/]/g, '\\$&')

const config = new Map<string, LoadedApp>([
  app('mac', macos),
  app('admin', macos),
  app('phone', iphone),
  app('tablet', iphone),
  app('web', chrome),
  app('desk', folder(folderB)),
  app('notes', folder(folderA)),
  app('scratch', ownFolder),
])

type Request = Omit<ResourceRequest, 'locks' | 'resources' | 'scope' | 'pastLeaseMs' | 'releaseWithinMs'> & Partial<Pick<ResourceRequest, 'scope' | 'pastLeaseMs' | 'releaseWithinMs'>>
type Tables = { locks: SharedLocks; resources: SharedLocks }

function tables(): Tables {
  return { locks: new SharedLocks(), resources: new SharedLocks() }
}

function ask(using: Tables, request: Request, stopped: Promise<unknown> = never): Promise<ResourceGrant> {
  return acquireResources({ scope: 'run-1', pastLeaseMs: 60_000, releaseWithinMs: 1000, ...request, ...using }, stopped)
}

function needsOf(apps: readonly string[], locks: readonly string[] = [], owner?: string): ResourceNeed[] {
  const targets = Object.fromEntries(apps.map((name) => [name, [...(config.get(name)?.targets.keys() ?? [])][0] ?? '']))
  return resourceNeeds({ apps, targets, config, locks, owner })
}

function leaseOf(grant: ResourceGrant): ResourceLease {
  assert.ok(grant.ok, grant.ok ? '' : grant.failure.message)
  return grant.lease
}

function free(): { whenFree: () => undefined; giveBackSessions: (sessions: { release(): void }) => boolean; ending: boolean } {
  return {
    whenFree: () => undefined,
    giveBackSessions: (sessions) => {
      sessions.release()
      return true
    },
    ending: false,
  }
}

// Read through a call, so an earlier check that it was undefined does not fix its type for the rest of a test.
function expiryOf(lease: ResourceLease): ResourceLease['expiry'] {
  return lease.expiry
}

function held(using: Tables): number {
  return using.locks.holders().size + using.resources.holders().size
}

describe('the acquisition order', () => {
  test('is fixed: locks, the desktop, devices, data folders, then sessions', () => {
    assert.deepEqual(acquisitionOrder, ['lock', 'desktop', 'device', 'data-folder', 'sessions'])
  })

  test("a test's needs come from its apps and locks, in kind order then key order, whatever order it declared them in", () => {
    const needs = needsOf(['scratch', 'desk', 'web', 'phone', 'admin', 'notes', 'mac', 'tablet'], ['zebra', 'Alpha', 'inbox'], 'agent-1')
    assert.deepEqual(
      needs.map((need) => [need.kind, need.name, need.apps]),
      [
        ['lock', 'Alpha', []],
        ['lock', 'inbox', []],
        ['lock', 'zebra', []],
        ['desktop', 'macos', ['admin', 'mac']],
        ['device', 'iPhone 17 (iOS 26.5)', ['phone', 'tablet']],
        ['data-folder', folderA, ['notes']],
        ['data-folder', folderB, ['desk']],
        ['sessions', 'agent-1', ['scratch', 'desk', 'web', 'phone', 'admin', 'notes', 'mac', 'tablet']],
      ],
    )
    assert.equal(needs.at(-1)?.count, 8, 'one session for each app')
    assert.deepEqual(needsOf(['web', 'scratch']), [], 'a browser target and an Electron app on a folder of its own need nothing exclusive, and no session without limits')
  })

  test('keys compare by code unit, so every machine orders them the same; giving back runs in reverse', () => {
    const keys = ['b', 'B', 'a', 'é', 'Z'].map((key) => ({ kind: 'lock' as const, key }))
    assert.deepEqual([...keys].sort(compareNeeds).map((need) => need.key), ['B', 'Z', 'a', 'b', 'é'])
    assert.deepEqual(releaseOrder(needsOf(['mac', 'desk'], ['inbox'], 'agent-1')).map((need) => need.kind), ['sessions', 'data-folder', 'desktop', 'lock'])
  })

  test('the execution record names the resource each target takes', () => {
    assert.deepEqual([macos, iphone, chrome, folder(folderA), ownFolder, undefined].map(sessionResource), ['desktop', 'device', 'browser-context', 'data-folder', 'app-launch', 'browser-context'])
  })

  test('parts are described with the target of each app', () => {
    assert.equal(describeLeaseParts(needsOf(['mac', 'admin', 'desk'], ['inbox']).map(leasePart), { mac: 'macos', admin: 'macos', desk: 'electron' }), `lock inbox, the desktop of mac=macos and admin=macos and the data folder ${folderB} of desk=electron`)
  })

  test('a disk whose case rule cannot be read refuses the folder rather than guess', () => {
    const root = tempFolder('unreadable-')
    const locked = join(root, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o555)
    try {
      const app = new Map([['desk', { name: 'desk', targets: new Map<string, LoadedTarget>([['electron', folder(join(locked, 'data'))]]) }]])
      assert.throws(() => resourceNeeds({ apps: ['desk'], targets: { desk: 'electron' }, config: app, locks: [] }), /EACCES|permission denied/i)
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  test('a data folder is held under its real path: through a link, and without case on a disk that ignores it', () => {
    const root = tempFolder('folders-')
    mkdirSync(join(root, 'Data'))
    symlinkSync(join(root, 'Data'), join(root, 'link'), 'dir')
    assert.equal(folderKey(join(root, 'link', 'desk')), folderKey(join(root, 'Data', 'desk')), 'a link and the folder it points to are one folder, though desk does not exist yet')
    const ignoring = folderKey(join(root, 'Data', 'Desk')) === folderKey(join(root, 'Data', 'desk'))
    const caseBlind = folderKey(join(root, 'DATA')) === folderKey(join(root, 'Data'))
    assert.equal(ignoring, caseBlind, 'a missing folder takes the case rule of the disk it will be on')
    const twoApps = new Map([app('upper', folder(join(root, 'Data', 'Desk'))), app('lower', folder(join(root, 'Data', 'desk')))])
    const needs = resourceNeeds({ apps: ['upper', 'lower'], targets: { upper: 'electron', lower: 'electron' }, config: twoApps, locks: [] })
    assert.equal(needs.length, ignoring ? 1 : 2, ignoring ? 'one folder, two names: one lease part for both apps' : 'a disk that keeps case has two folders')
  })
})

/** A generator of numbers from 0 to 1, the same for the same seed, so a failing round can be run again. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** Which tests wait for sessions and which hold them, as a test tracks it from each step its requests are granted. */
type SessionState = { readonly waiting: Set<string>; readonly holding: Set<string> }

/**
 * A cycle among holders, as test names, or undefined: each waiter waits for the holders of a lock or a resource it asked
 * for, and a test waiting for sessions waits for every test that holds some.
 */
function findCycle(using: Tables, sessions?: SessionState): string[] | undefined {
  const waitsFor = new Map<string, Set<string>>()
  const edge = (from: string, to: string): void => {
    if (from === to) return
    const known = waitsFor.get(from) ?? new Set<string>()
    known.add(to)
    waitsFor.set(from, known)
  }
  for (const table of [using.locks, using.resources]) {
    const holders = table.holders()
    for (const waiter of table.waiters()) for (const name of waiter.names) edge(waiter.holder, holders.get(name) ?? waiter.holder)
  }
  for (const waiter of sessions?.waiting ?? []) for (const holder of sessions?.holding ?? []) edge(waiter, holder)
  const visiting: string[] = []
  const done = new Set<string>()
  const visit = (node: string): string[] | undefined => {
    if (visiting.includes(node)) return [...visiting.slice(visiting.indexOf(node)), node]
    if (done.has(node)) return undefined
    visiting.push(node)
    for (const next of waitsFor.get(node) ?? []) {
      const cycle = visit(next)
      if (cycle !== undefined) return cycle
    }
    visiting.pop()
    done.add(node)
    return undefined
  }
  for (const node of waitsFor.keys()) {
    const cycle = visit(node)
    if (cycle !== undefined) return cycle
  }
  return undefined
}

describe('acquiring under contention', () => {
  test('the cycle finder sees the deadlock that taking needs one at a time in declared order makes', async () => {
    const using = tables()
    const take = (table: SharedLocks, holder: string, name: string): Promise<unknown> => table.reserve({ names: [name], position: 0, holder }, never)
    // Each test takes its first need, then asks for the other's, as a runner without one order would.
    await take(using.locks, 'first', 'inbox')
    await take(using.resources, 'second', 'desktop')
    void take(using.resources, 'first', 'desktop')
    void take(using.locks, 'second', 'inbox')
    await settle()
    const cycle = findCycle(using)
    assert.deepEqual([cycle?.length, new Set(cycle)], [3, new Set(['first', 'second'])], 'each waits for the other')
  })

  test('four tests in a ring, each given its needs in the order that would deadlock taken one at a time: over many seeded rounds no cycle forms, every round finishes, no part is shared, and tests that share nothing run together', async (t) => {
    const seed = Number(process.env['RETEST_RESOURCES_SEED'] ?? Date.now() % 1_000_000)
    t.diagnostic(`seed ${seed}; run again with RETEST_RESOURCES_SEED=${seed}`)
    const random = seeded(seed)
    const only = (needs: readonly ResourceNeed[]): ResourceNeed => {
      const [need] = needs
      assert.ok(need !== undefined)
      return need
    }
    const inbox = only(needsOf([], ['inbox']))
    const outbox = only(needsOf([], ['outbox']))
    const desktop = only(needsOf(['mac']))
    const notes = only(needsOf(['notes']))
    const session = only(needsOf(['web'], [], 'agent'))
    // Around the ring each test takes the part it shares with the test before it, then the one it shares with the test
    // after it. Taken one at a time in that order, each can hold its first and wait for its second, which the next
    // test holds: a cycle. The first and third share nothing, nor do the second and fourth, so they may run at once.
    // Each round a gate holds all four parts while the tests ask, then lets go of them at once, so every test's first
    // part is free in the same instant: the moment one at a time would close the ring.
    const tests: Record<string, ResourceNeed[]> = {
      first: [inbox, desktop, session],
      second: [desktop, notes, session],
      third: [notes, outbox, session],
      fourth: [outbox, inbox, session],
    }
    let mostAtOnce = 0
    for (let round = 0; round < 300; round += 1) {
      const using = tables()
      const budget = new SessionBudget({ perOwner: 3, host: 3 })
      const sessions: SessionState = { waiting: new Set(), holding: new Set() }
      const holding = new Map<string, string>()
      const running = new Set<string>()
      const gateLocks = await using.locks.reserve({ names: [JSON.stringify(['lock', 'inbox']), JSON.stringify(['lock', 'outbox'])], position: -1, holder: 'gate' }, never)
      const gateParts = await using.resources.reserve({ names: [JSON.stringify(['desktop', desktop.key]), JSON.stringify(['data-folder', notes.key])], position: -1, holder: 'gate' }, never)
      assert.ok(gateLocks.ok && gateParts.ok)
      let lastProgress = performance.now()
      const run = async (holder: string, position: number): Promise<void> => {
        await sleep(Math.floor(random() * 3))
        const needs = tests[holder] ?? []
        const exclusiveSteps = new Set(needs.filter((need) => need.kind !== 'sessions').map((need) => (need.kind === 'lock' ? 'locks' : 'resources')))
        const onAcquired = (stage: AcquiredStage): void => {
          lastProgress = performance.now()
          if (stage.kind === 'sessions') {
            sessions.waiting.delete(holder)
            sessions.holding.add(holder)
            return
          }
          exclusiveSteps.delete(stage.kind)
          if (exclusiveSteps.size === 0) sessions.waiting.add(holder)
        }
        const lease = leaseOf(await ask(using, { attemptId: `${holder}-${round}`, holder, position, needs, sessions: { budget, owner: 'agent', waitMs: 10_000 }, onAcquired }))
        lastProgress = performance.now()
        for (const need of needs.filter((each) => each.kind !== 'sessions')) {
          const other = holding.get(need.key)
          assert.equal(other, undefined, `seed ${seed}, round ${round}: ${holder} and ${other} held ${need.key} at once`)
          holding.set(need.key, holder)
        }
        running.add(holder)
        mostAtOnce = Math.max(mostAtOnce, running.size)
        await sleep(Math.floor(random() * 4))
        running.delete(holder)
        for (const need of needs) if (holding.get(need.key) === holder) holding.delete(need.key)
        sessions.holding.delete(holder)
        await lease.release(free())
        lastProgress = performance.now()
      }
      const finished = Promise.all(Object.keys(tests).map((holder, position) => run(holder, position)))
      await sleep(4)
      gateLocks.lease.release()
      gateParts.lease.release()
      lastProgress = performance.now()
      let ended = false
      void finished.finally(() => (ended = true))
      while (!ended) {
        const cycle = findCycle(using, sessions)
        assert.equal(cycle, undefined, `seed ${seed}, round ${round}: ${cycle?.join(' waits for ')}`)
        assert.ok(performance.now() - lastProgress < 1000, `seed ${seed}, round ${round}: nothing was granted or given back for a second`)
        await sleep(1)
      }
      await finished
      assert.deepEqual([held(using), using.locks.waiting(), using.resources.waiting(), budget.snapshot().host, budget.snapshot().waiting], [0, 0, 0, 0, 0], `seed ${seed}, round ${round}`)
    }
    assert.equal(mostAtOnce, 2, `seed ${seed}: two tests that share nothing ran at once, and never more than two`)
  })
})

describe('the bound', () => {
  test('a test waits as long as the holder is inside its lease, and past it at most the bound more, then fails setup naming what it waited for and who held it', async () => {
    const using = tables()
    const holder = leaseOf(await ask(using, { attemptId: 'a1', holder: 'tests/a.retest.ts > holds the folder', position: 0, needs: needsOf(['desk'], ['inbox']), releaseWithinMs: 20, variant: { desk: 'electron' } }))
    const waiting = ask(using, { attemptId: 'b1', holder: 'tests/b.retest.ts > waits', position: 1, needs: needsOf(['desk']), pastLeaseMs: 60, variant: { desk: 'electron' } })
    await sleep(150)
    assert.equal(using.resources.waiting(), 1, 'more than twice the bound later, it still waits behind a live lease')
    // The app on the folder never quits, so the folder is not free within the release time and the lease expires.
    const expiries: string[] = []
    holder.onExpired((expiry) => expiries.push(`${expiry.held.map((need) => need.name).join()} held, ${expiry.released.map((need) => need.name).join()} given back`))
    await holder.release({ ...free(), whenFree: (need) => (need.kind === 'data-folder' ? never : undefined) })
    assert.deepEqual(expiries, [`${folderB} held, inbox given back`])
    assert.equal(using.locks.holders().size, 0, 'the lock came back')
    const refused = await waiting
    assert.ok(!refused.ok)
    assert.equal(refused.stopped, false)
    assert.equal(refused.failure.class, 'setup_failed')
    assert.match(refused.failure.message, new RegExp(`^Not run: the data folder ${escapedB} of desk=electron did not come free\\. tests/a\\.retest\\.ts > holds the folder held it past the end of its lease, and the test waited 60 ms more, \\d+ ms in all\\.$`))
    assert.equal(refused.failure.details?.['waitedFor'], `the data folder ${folderB} of desk=electron`)
    assert.equal(refused.failure.details?.['heldBy'], 'tests/a.retest.ts > holds the folder')
    assert.ok(Number(refused.failure.details?.['waitedMs']) >= 200)
    assert.deepEqual([...using.resources.holders().values()], ['tests/a.retest.ts > holds the folder'], 'the waiter holds nothing; the folder stays with the app that has it')
    await holder.finish(10)
    assert.deepEqual([...using.resources.holders().values()], ['tests/a.retest.ts > holds the folder'], 'as the run ends, a folder whose app is still there stays held')
  })

  test('a test whose sessions do not come free gives back the locks and resources it held, and its failure names them', async () => {
    const using = tables()
    const budget = new SessionBudget({ perOwner: 1, host: 1 })
    const first = leaseOf(await ask(using, { attemptId: 'a1', holder: 'first', position: 0, needs: needsOf(['web'], [], 'agent-1'), sessions: { budget, owner: 'agent-1', waitMs: 1000 } }))
    const refused = await ask(using, { attemptId: 'b1', holder: 'second', position: 1, needs: needsOf(['desk'], ['inbox'], 'agent-1'), sessions: { budget, owner: 'agent-1', waitMs: 40 }, variant: { desk: 'electron' } })
    assert.ok(!refused.ok)
    assert.match(refused.failure.message, /^Not run: 1 session for "agent-1" did not come free within 40 ms\. When it gave up, "agent-1" held 1 of 1 and the host 1 of 1\.$/)
    assert.deepEqual([refused.failure.details?.['waitedFor'], refused.failure.details?.['heldBy'], refused.failure.details?.['held']], ['1 session of agent-1', 'first', `lock inbox and the data folder ${folderB} of desk=electron`])
    assert.equal(held(using), 0, 'what it held while it waited for sessions came back')
    await first.release(free())
    assert.deepEqual(budget.snapshot(), { host: 0, owners: new Map(), waiting: 0 })
  })

  test('a test that needs more sessions than any limit gives back what it held at once', async () => {
    const using = tables()
    const budget = new SessionBudget({ perOwner: 1, host: 4 })
    const refused = await ask(using, { attemptId: 'a1', holder: 'two apps', position: 0, needs: needsOf(['web', 'desk'], ['inbox'], 'agent-1'), sessions: { budget, owner: 'agent-1', waitMs: 1000 } })
    assert.ok(!refused.ok)
    assert.match(refused.failure.message, /more than the limit of 1 for each owner, so it could never start\.$/)
    assert.equal(held(using), 0)
  })
})

describe('the table one process shares', () => {
  test("two runs in one process never hold one desktop at once, and a record of one never names the other's test", async () => {
    const shared = new SharedLocks()
    const first = leaseOf(await acquireResources({ attemptId: 'a1', holder: 'run one > drives the Mac', scope: 'run-1', position: 0, needs: needsOf(['mac']), locks: new SharedLocks(), resources: shared, pastLeaseMs: 20, releaseWithinMs: 10 }, never))
    const stages: string[] = []
    const second = acquireResources(
      { attemptId: 'b1', holder: 'run two > drives the Mac', scope: 'run-2', position: 0, needs: needsOf(['mac']), locks: new SharedLocks(), resources: shared, pastLeaseMs: 20, releaseWithinMs: 10, onAcquired: (stage) => stages.push(JSON.stringify(stage)) },
      never,
    )
    await settle()
    assert.equal(shared.waiting(), 1, "the second run's test waits for the desktop, though its own lock table is empty")
    await first.release({ ...free(), whenFree: () => sleep(5) })
    assert.ok((await second).ok)
    assert.equal(stages.length, 1)
    assert.match(stages[0] ?? '', /"kind":"resources".*"heldBy":\[\],"heldElsewhere":1/)
    assert.ok(!stages.join().includes('run one'), "the other run's test is counted, not named")
  })

  test("a refusal behind another run's expired lease says another run held it, and names no test of that run", async () => {
    const shared = new SharedLocks()
    const first = leaseOf(await acquireResources({ attemptId: 'a1', holder: 'run one > keeps the folder', scope: 'run-1', position: 0, needs: needsOf(['desk']), locks: new SharedLocks(), resources: shared, pastLeaseMs: 20, releaseWithinMs: 10 }, never))
    const waiting = acquireResources({ attemptId: 'b1', holder: 'run two > waits', scope: 'run-2', position: 0, needs: needsOf(['desk']), locks: new SharedLocks(), resources: shared, pastLeaseMs: 30, releaseWithinMs: 10, variant: { desk: 'electron' } }, never)
    await first.release({ ...free(), whenFree: () => never })
    const refused = await waiting
    assert.ok(!refused.ok)
    assert.match(refused.failure.message, new RegExp(`^Not run: the data folder ${escapedB} of desk=electron did not come free\\. another run in this process held it past the end of its lease`))
    assert.equal(refused.failure.details?.['heldElsewhere'], 1)
    assert.equal(refused.failure.details?.['heldBy'], undefined)
    assert.ok(!JSON.stringify(refused.failure).includes('run one'))
  })
})

describe('a lease', () => {
  test('records what it covers in the acquisition order, when it was taken and how long its parts may take to come free, with names redacted', async () => {
    const lease = leaseOf(await ask(tables(), { attemptId: 'a1', holder: 'first', position: 0, needs: needsOf(['mac', 'desk'], ['inbox-secret-1']), releaseWithinMs: 7100 }))
    const record = lease.record((text) => text.replace('secret-1', '{{password}}'))
    assert.deepEqual(record.covers, [
      { kind: 'lock', name: 'inbox-{{password}}' },
      { kind: 'desktop', name: 'macos', apps: ['mac'] },
      { kind: 'data-folder', name: folderB, apps: ['desk'] },
    ])
    assert.equal(record.releaseWithinMs, 7100)
    assert.ok(Math.abs(Date.parse(record.takenAt) - Date.now()) < 5000)
  })

  test('gives back in reverse order: sessions first, each resource once it is really free, the locks last', async () => {
    const using = tables()
    const budget = new SessionBudget({ perOwner: 2, host: 2 })
    const lease = leaseOf(await ask(using, { attemptId: 'a1', holder: 'first', position: 0, needs: needsOf(['desk'], ['inbox'], 'agent-1'), sessions: { budget, owner: 'agent-1', waitMs: 1000 } }))
    const order: string[] = []
    const folderFree = Promise.withResolvers<void>()
    void ask(using, { attemptId: 'f', holder: 'folder waiter', position: 1, needs: needsOf(['desk']) }).then(() => order.push('folder taken'))
    void ask(using, { attemptId: 'l', holder: 'lock waiter', position: 2, needs: needsOf([], ['inbox']) }).then(() => order.push('lock taken'))
    const releasing = lease.release({
      whenFree: (need) => (need.kind === 'data-folder' ? folderFree.promise : undefined),
      giveBackSessions: (sessions) => {
        order.push('sessions given back')
        sessions.release()
        return true
      },
      ending: false,
    })
    await settle()
    assert.deepEqual(order, ['sessions given back'], 'the folder is still in use, so it and the lock after it wait')
    assert.equal(held(using), 2)
    order.push('app gone')
    folderFree.resolve()
    await releasing
    await settle()
    assert.deepEqual(order, ['sessions given back', 'app gone', 'folder taken', 'lock taken'])
    assert.equal(lease.expiry, undefined)
  })

  test('given back as the run stops waits for nothing; each part comes back when it is free, and at the run\'s end one still in use stays held and expires the lease', async () => {
    const using = tables()
    const lease = leaseOf(await ask(using, { attemptId: 'a1', holder: 'first', position: 0, needs: needsOf(['desk', 'mac'], ['inbox']), releaseWithinMs: 1 }))
    const gone = Promise.withResolvers<void>()
    await lease.release({ ...free(), whenFree: (need) => (need.kind === 'data-folder' ? gone.promise : need.kind === 'desktop' ? never : undefined), ending: true })
    await sleep(20)
    assert.equal(lease.expiry, undefined)
    assert.deepEqual([using.locks.holders().size, using.resources.holders().size], [0, 2], 'the lock came back; the folder and the desktop wait')
    gone.resolve()
    await settle()
    assert.equal(using.resources.holders().size, 1)
    await lease.finish(20)
    const expiry = expiryOf(lease)
    assert.deepEqual(expiry?.held.map((need) => need.kind), ['desktop'], 'the desktop, whose session never ended, is recorded as still held')
    assert.deepEqual(expiry?.released.map((need) => need.kind), ['lock', 'data-folder'], 'in the order the lease covers them')
    assert.deepEqual([...using.resources.holders().values()], ['first'], 'and stays held after the run')
  })
})

describe('a lease whose parts do not come back', () => {
  test('lists as released only what really came back: sessions its contexts still hold are not', async () => {
    const using = tables()
    const budget = new SessionBudget({ perOwner: 2, host: 2 })
    const lease = leaseOf(await ask(using, { attemptId: 'a1', holder: 'first', position: 0, needs: needsOf(['desk'], ['inbox'], 'agent-1'), sessions: { budget, owner: 'agent-1', waitMs: 1000 }, releaseWithinMs: 20 }))
    // The caller keeps the sessions for contexts that could not close, and says so.
    await lease.release({ whenFree: (need) => (need.kind === 'data-folder' ? never : undefined), giveBackSessions: () => false, ending: false })
    assert.deepEqual(lease.expiry?.held.map((need) => need.kind), ['data-folder'])
    assert.deepEqual(lease.expiry?.released.map((need) => need.kind), ['lock'], 'the sessions are not listed as given back')
    assert.equal(budget.snapshot().host, 1, 'they are still counted')
  })

  test('a free hook that throws or rejects keeps its part held as one that never came free, and nothing goes unheard', async () => {
    const unheard: unknown[] = []
    const listen = (reason: unknown): void => void unheard.push(reason)
    process.on('unhandledRejection', listen)
    try {
      for (const hook of ['throws', 'rejects'] as const) {
        const using = tables()
        const lease = leaseOf(await ask(using, { attemptId: 'a1', holder: hook, position: 0, needs: needsOf(['desk'], ['inbox']), releaseWithinMs: 20 }))
        const whenFree = (need: ResourceNeed): Promise<void> | undefined => {
          if (need.kind !== 'data-folder') return undefined
          if (hook === 'throws') throw new Error('the session provider broke')
          return Promise.reject(new Error('the session provider broke'))
        }
        await lease.release({ ...free(), whenFree })
        assert.deepEqual(lease.expiry?.held.map((need) => need.kind), ['data-folder'], hook)
        assert.deepEqual([...using.resources.holders().values()], [hook], `${hook}: the folder stays held`)
        assert.equal(using.locks.holders().size, 0, `${hook}: the lock came back`)
      }
      await sleep(20)
      assert.deepEqual(unheard, [])
    } finally {
      process.off('unhandledRejection', listen)
    }
  })
})

describe('a stopped run', () => {
  test('withdraws every waiter, those waiting for locks and resources and those holding them while they wait for sessions, and leaves nothing held', async () => {
    const using = tables()
    const budget = new SessionBudget({ perOwner: 1, host: 1 })
    const stop = Promise.withResolvers<void>()
    const running = leaseOf(await ask(using, { attemptId: 'a1', holder: 'running', position: 0, needs: needsOf(['desk'], ['inbox'], 'agent-1'), sessions: { budget, owner: 'agent-1', waitMs: 60_000 } }, stop.promise))
    const lockWaiter = ask(using, { attemptId: 'b1', holder: 'waits for the lock', position: 1, needs: needsOf([], ['inbox'], 'agent-1'), sessions: { budget, owner: 'agent-1', waitMs: 60_000 } }, stop.promise)
    const sessionWaiter = ask(using, { attemptId: 'c1', holder: 'waits for a session', position: 2, needs: needsOf(['mac'], ['account'], 'agent-1'), sessions: { budget, owner: 'agent-1', waitMs: 60_000 } }, stop.promise)
    await settle()
    assert.equal(using.locks.holders().get(JSON.stringify(['lock', 'account'])), 'waits for a session', 'it holds its lock and the desktop while it waits for a session')
    stop.resolve()
    const withdrawn = await Promise.all([lockWaiter, sessionWaiter])
    assert.deepEqual(
      withdrawn.map((grant) => (grant.ok ? 'granted' : grant.stopped)),
      [true, true],
    )
    await running.release(free())
    assert.deepEqual([held(using), using.locks.waiting(), using.resources.waiting(), budget.snapshot().host, budget.snapshot().waiting], [0, 0, 0, 0, 0])
  })
})

/**
 * A stand-in for the native lane's macOS runner, kept to its contract: the desktop serves one session at a time and a
 * session ended is free a moment later, when its runtime says so. Each session it opens is a held app whose `whenFree`
 * is that moment, the hook the runner's release reads through `partFree`.
 */
class FakeDesktop {
  open = 0
  most = 0
  readonly log: string[] = []

  openSession(holder: string): { held: HeldApp; end: (afterMs: number) => void } {
    this.open += 1
    this.most = Math.max(this.most, this.open)
    this.log.push(`${holder} opened`)
    const ended = Promise.withResolvers<void>()
    const end = (afterMs: number): void => {
      setTimeout(() => {
        this.open -= 1
        this.log.push(`${holder} ended`)
        ended.resolve()
      }, afterMs)
    }
    return { held: { whenFree: () => ended.promise }, end }
  }
}

describe('the interactive desktop, through the runner\'s release', () => {
  test('two tests on one macOS target never overlap: the second gets the desktop only once the first native session has ended', async () => {
    const using = tables()
    const desktop = new FakeDesktop()
    const attempt = async (holder: string, position: number): Promise<ResourceLease> => {
      const lease = leaseOf(await ask(using, { attemptId: `${holder}-1`, holder, position, needs: needsOf(['mac']), variant: { mac: 'macos' } }))
      desktop.log.push(`${holder} granted`)
      const session = desktop.openSession(holder)
      await sleep(5)
      desktop.log.push(`${holder} let go`)
      session.end(30)
      const apps = new Map([['mac', session.held]])
      await lease.release({ ...free(), whenFree: (need) => partFree(need, apps) })
      return lease
    }
    const [, second] = await Promise.all([attempt('first', 0), attempt('second', 1)])
    assert.equal(desktop.most, 1, 'two native sessions were never open on the desktop at once')
    assert.deepEqual(desktop.log, ['first granted', 'first opened', 'first let go', 'first ended', 'second granted', 'second opened', 'second let go', 'second ended'])
    assert.equal(second.expiry, undefined)
  })

  test('a desktop is free only once its session ends, not when the test lets go, and with no session made ready it is free at once', async () => {
    const need = needsOf(['mac'])[0]
    assert.ok(need !== undefined)
    const desktop = new FakeDesktop()
    const session = desktop.openSession('first')
    let freed = false
    void partFree(need, new Map([['mac', session.held]]))?.then(() => (freed = true))
    await sleep(20)
    assert.equal(freed, false, 'the test let go, but its native session has not ended')
    session.end(0)
    await sleep(10)
    assert.equal(freed, true)
    assert.equal(partFree(need, new Map()), undefined, 'nothing was made ready on the desktop, so it is free')
    let stillHeld = true
    void partFree(need, new Map([['mac', {}]]))?.then(() => (stillHeld = false))
    await sleep(10)
    assert.equal(stillHeld, true, 'an app made ready without a free signal keeps the desktop until the run gives back all')
    assert.equal(partFree(needsOf([], ['inbox'])[0] ?? need, new Map([['mac', session.held]])), undefined, 'a lock waits for nothing')
  })

  test('a test with two apps on one desktop holds one lease part for both, and another test waits for all of it', async () => {
    const using = tables()
    const needs = needsOf(['mac', 'admin'])
    assert.deepEqual(
      needs.map((need) => [need.kind, need.apps]),
      [['desktop', ['mac', 'admin']]],
    )
    const both = leaseOf(await ask(using, { attemptId: 'a1', holder: 'two apps', position: 0, needs }))
    assert.deepEqual(both.record((text) => text).covers, [{ kind: 'desktop', name: 'macos', apps: ['mac', 'admin'] }])
    let served = false
    const other = ask(using, { attemptId: 'b1', holder: 'admin only', position: 1, needs: needsOf(['admin']) }).then((grant) => {
      served = grant.ok
      return grant
    })
    await settle()
    assert.equal(served, false, 'the other app on the same desktop waits')
    const desktop = new FakeDesktop()
    const first = desktop.openSession('mac')
    const second = desktop.openSession('admin')
    first.end(5)
    second.end(25)
    await both.release({ ...free(), whenFree: (need) => partFree(need, new Map([['mac', first.held], ['admin', second.held]])) })
    assert.deepEqual(desktop.log.slice(-2), ['mac ended', 'admin ended'], 'given back once both sessions ended')
    assert.ok((await other).ok)
    assert.deepEqual(
      needsOf(['phone', 'tablet']).map((need) => [need.kind, need.name, need.apps]),
      [['device', 'iPhone 17 (iOS 26.5)', ['phone', 'tablet']]],
      'two apps on one simulator need the device once',
    )
  })
})

// Whole runs on the fake browser. The config has a browser app, an Electron app on a named data folder and an Electron
// app that gets a folder of its own each launch; every Electron launch is a fake.

const passwordVariable = 'RETEST_RESOURCES_PASSWORD'
const password = 'correct-horse-battery-42'

function configSource(extra = ''): string {
  return `import { chromium, defineConfig, electron, env } from '@rehearsal-labs/retest'
export default defineConfig({
  apps: {
    web: chromium({ baseUrl: 'http://127.0.0.1:4173', executablePath: '/fake/chromium' }),
    desk: electron({ executablePath: '/opt/Electron', appPath: 'desk', userDataDir: '.data/desk' }),
    scratch: electron({ executablePath: '/opt/Electron', appPath: 'desk' }),
    ${extra}
  },
  defaultApp: 'web',
  locks: ['inbox'],
  secrets: { password: env('${passwordVariable}') },
})
`
}

// A test that holds its apps for a while, then checks the fake task app shows nothing saved.
function holding(name: string, options: string, apps: readonly string[], ms = 0): string {
  const fixtures = apps.join(', ')
  const pause = ms === 0 ? '' : `\n  await new Promise((resolve) => setTimeout(resolve, ${ms}))`
  const checks = apps.map((each) => `\n  await expect(${each}.getByTestId('saved-task')).toHaveText('')`).join('')
  return `test('${name}', ${options}, async ({ ${fixtures} }) => {${pause}${checks}\n})`
}

function testFile(...tests: string[]): string {
  return `import { expect, test } from '@rehearsal-labs/retest'\n\n${tests.join('\n\n')}\n`
}

// An Electron window as the fake browser serves a page; closing it quits the app, as Electron's own does.
function quittingPage(page: OwnedPage, quit: () => Promise<void>): OwnedPage {
  return {
    get url() {
      return page.url
    },
    readPage: (queries, timeoutMs) => page.readPage(queries, timeoutMs),
    onNavigation: (listener) => page.onNavigation(listener),
    captureState: (timeoutMs) => page.captureState(timeoutMs),
    execute: (command, timeoutMs, signal, commandToken) => page.execute(command, timeoutMs, signal, commandToken),
    screenshot: (timeoutMs) => page.screenshot(timeoutMs),
    dispose: async (timeoutMs) => {
      await page.dispose(timeoutMs)
      await quit()
    },
  }
}

/**
 * How a fake Electron app behaves: whether it quits when asked, how long quitting takes, which launches open no window,
 * and how long each launch by this launcher, counted from 0, takes to bring its app up.
 */
type AppBehaviour = { quits?: boolean; closeMs?: number; pageFails?: (launch: number) => boolean; launchMs?: (index: number) => number; outputSettled?: Promise<void> }

/** A fake Electron app: its first window is the page, closing the page quits it, and it is gone once it quits. */
class FakeElectron implements ElectronRuntime {
  readonly product = 'Electron'
  readonly version = '44.5.1'
  readonly userAgent = 'Mozilla/5.0 FakeElectron/44.5.1'
  readonly electron = { version: '44.5.1', chromium: '152.0.7977.130' }
  readonly executablePath: string
  readonly pid: number
  readonly options: ElectronLaunchOptions
  readonly #window: FakeBrowser
  readonly #behaviour: AppBehaviour
  readonly #listeners = new Set<(reason: string) => void>()
  readonly #gone = Promise.withResolvers<void>()
  readonly gone: Promise<void> = this.#gone.promise
  readonly outputSettled?: Promise<void>
  connected = true
  closeRequested = false

  constructor(options: ElectronLaunchOptions, pid: number, behaviour: AppBehaviour) {
    this.options = options
    this.pid = pid
    this.executablePath = options.executablePath
    this.#behaviour = behaviour
    if (behaviour.outputSettled !== undefined) this.outputSettled = behaviour.outputSettled
    this.#window = new FakeBrowser({}, { executablePath: options.executablePath, logFile: options.logFile, headless: false }, pid)
  }

  get identity(): WebRuntimeIdentity {
    return { kind: 'web', engine: 'chromium', product: this.product, version: this.version, executablePath: this.executablePath, processIds: [this.pid] }
  }

  async newPage(options: NewPageOptions, timeoutMs: number): Promise<OwnedPage> {
    if (this.#behaviour.pageFails?.(this.options.launch) === true) throw new Error('The app opened no window.')
    return quittingPage(await this.#window.newPage(options, timeoutMs), () => this.close())
  }

  onDisconnect(listener: (reason: string) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async close(): Promise<void> {
    this.closeRequested = true
    if (this.#behaviour.closeMs !== undefined) await sleep(this.#behaviour.closeMs)
    if (this.#behaviour.quits === false) return
    this.connected = false
    for (const listener of this.#listeners) listener('Retest quit the Electron app')
    this.#gone.resolve()
  }
}

function electronLauncher(behaviour: AppBehaviour = {}): { launch: LaunchElectron; apps: FakeElectron[]; most: () => number } {
  const apps: FakeElectron[] = []
  let live = 0
  let most = 0
  let launches = 0
  const launch: LaunchElectron = async (options) => {
    const delay = behaviour.launchMs?.(launches++) ?? 0
    if (delay > 0) await sleep(delay)
    const started = new FakeElectron(options, 7000 + apps.length, behaviour)
    apps.push(started)
    live += 1
    most = Math.max(most, live)
    void started.gone.then(() => (live -= 1))
    return started
  }
  return { launch, apps, most: () => most }
}

type Ran = { result: RunResult; events: RetestEvent[]; browsers: FakeBrowser[] }
type RunWith = Partial<RunOptions> & { launcher?: ReturnType<typeof fakeLauncher>; electron?: ReturnType<typeof electronLauncher>; reporters?: Reporter[] }

async function runWith(root: string, files: readonly string[], options: RunWith = {}): Promise<Ran> {
  const loaded = await loadConfig(join(root, configFileName))
  assert.ok(loaded.ok, loaded.ok ? '' : loaded.failure.message)
  const secrets = resolveSecrets(loaded.config, { [passwordVariable]: password })
  assert.ok(secrets.ok)
  const folder = newRunFolder()
  const store = RunStore.create(folder)
  const { launcher, electron, reporters, ...rest } = options
  const { launch, browsers } = launcher ?? fakeLauncher()
  const runOptions: RunOptions = {
    files: [...files],
    rootDir: root,
    apps: { kind: 'config', config: loaded.config, secrets: secrets.secrets },
    timeouts: quickTimeouts,
    outputDir: folder,
    headless: true,
    workers: 1,
    signal: new AbortController().signal,
    lastRunFile: false,
    ...rest,
  }
  const launchElectron = electron === undefined ? {} : { launchElectron: electron.launch }
  try {
    const result = await new RunSession({ options: runOptions, reporters: reporters ?? [], launch, findExecutable: fakeExecutable, store, ...launchElectron }).run()
    return { result, events: readEvents(folder).events, browsers }
  } finally {
    store.close()
  }
}

function results(ran: Ran): TestResult[] {
  return ran.result.files.flatMap((file) => file.tests)
}

function named(ran: Ran, name: string): TestResult {
  const found = results(ran).find((each) => each.name === name)
  assert.ok(found !== undefined, `a test named ${name}`)
  return found
}

function eventsOf<Type extends RetestEvent['type']>(events: readonly RetestEvent[], type: Type, attemptId?: string): Extract<RetestEvent, { type: Type }>[] {
  return events.filter((event): event is Extract<RetestEvent, { type: Type }> => event.type === type && (attemptId === undefined || ('attemptId' in event && event.attemptId === attemptId)))
}

function humanReport(ran: Ran): string {
  const stdout = capture()
  const reporter = createHumanReporter({ stdout, stderr: capture(), color: false, runFolder: 'run' })
  for (const event of ran.events) reporter.onEvent(event)
  reporter.onRunEnd(ran.result)
  return plain(stdout.text)
}

function card(ran: Ran, test: TestResult): string {
  const record = new RunRecord()
  for (const event of ran.events) record.add(event)
  return renderCard(testCard(test, { record, runFolder: 'run', targets: runTargets(record, ran.result) }), { style: createStyle(false), runFolder: 'run', rootDir: undefined })
}

// Every session an attempt reserved came back, and the budget holds nothing and waits for nothing.
function assertNothingHeld(ran: Ran, budget: SessionBudget): void {
  for (const reserved of eventsOf(ran.events, 'session.reserved')) assert.equal(eventsOf(ran.events, 'session.released', reserved.attemptId).length, 1, `${reserved.testId} gave its sessions back`)
  assert.deepEqual(budget.snapshot(), { host: 0, owners: new Map(), waiting: 0 })
}

// Collects Node's warnings while `work` runs, such as a timer set longer than Node can count.
async function warningsDuring<T>(work: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = []
  const listen = (warning: Error): void => void warnings.push(`${warning.name}: ${warning.message}`)
  process.on('warning', listen)
  try {
    return { value: await work(), warnings }
  } finally {
    process.off('warning', listen)
  }
}

describe('partial setup in a run gives back what the attempt held', () => {
  test('a failed launch: the lock and the sessions come back, and the next test takes them', async () => {
    const root = tempProject({
      [configFileName]: configSource(),
      'tests/a.retest.ts': testFile(holding('first', "{ locks: ['inbox'] }", ['page'])),
      'tests/b.retest.ts': testFile(holding('second', "{ locks: ['inbox'] }", ['page'])),
    })
    const budget = new SessionBudget({ perOwner: 1, host: 1 })
    const ran = await runWith(root, ['tests/a.retest.ts', 'tests/b.retest.ts'], { workers: 2, launcher: fakeLauncher({ launchFails: 'No browser at /fake/chromium.' }), sessions: { owner: 'agent-1', budget } })
    for (const name of ['first', 'second']) {
      const result = named(ran, name)
      assert.deepEqual([result.status, result.failure?.message], ['not_run', 'No browser at /fake/chromium.'], name)
    }
    const acquired = eventsOf(ran.events, 'lock.acquired').sort((one, other) => one.sequence - other.sequence)
    assert.equal(acquired.length, 2, 'each test held the lock before anything launched for it')
    const [before, after] = acquired
    assert.ok(before !== undefined && after !== undefined)
    const gaveBack = eventsOf(ran.events, 'session.released', before.attemptId)[0]
    assert.ok(gaveBack !== undefined && gaveBack.sequence < after.sequence, 'the first gave its sessions back, then its lock, before the second held it')
    assertNothingHeld(ran, budget)
  })

  test('a failed preparation: the attempt ends with a setup result and what it held comes back', async () => {
    const root = tempProject({ [configFileName]: configSource(), 'tests/a.retest.ts': testFile(holding('prepared badly', "{ locks: ['inbox'] }", ['page']), holding('runs after', "{ locks: ['inbox'] }", ['page'])) })
    const budget = new SessionBudget({ perOwner: 1, host: 1 })
    const ran = await runWith(root, ['tests/a.retest.ts'], {
      sessions: { owner: 'agent-1', budget, waitMs: 500 },
      prepare: { 'tests/a.retest.ts > prepared badly': { prepare: async () => ({ status: 'failed', reason: 'the fixture service is down' }) } },
    })
    assert.deepEqual([named(ran, 'prepared badly').status, named(ran, 'prepared badly').failure?.class], ['error', 'setup_failed'])
    assert.equal(named(ran, 'runs after').status, 'passed', 'the lock and the only session were free for the next test')
    assertNothingHeld(ran, budget)
  })

  test('a browser lost during setup: what the attempt held comes back, so the next test still takes the lock', async () => {
    const root = tempProject({ [configFileName]: configSource(), 'tests/a.retest.ts': testFile(holding('loses its browser', "{ locks: ['inbox'] }", ['page']), holding('comes next', "{ locks: ['inbox'] }", ['page'])) })
    const budget = new SessionBudget({ perOwner: 1, host: 1 })
    const launcher = fakeLauncher({
      holdOpening: async () => {
        launcher.browsers[0]?.disconnect('The browser crashed while the page opened.')
      },
    })
    const ran = await runWith(root, ['tests/a.retest.ts'], { launcher, sessions: { owner: 'agent-1', budget } })
    assert.equal(named(ran, 'loses its browser').failure?.class, 'session_lost')
    const next = named(ran, 'comes next')
    assert.equal(next.failure?.class, 'session_lost', 'the browser stays lost for the rest of the run')
    assert.equal(eventsOf(ran.events, 'lock.acquired', next.attemptId).length, 1, 'but the lock had come back, and the next test held it')
    assertNothingHeld(ran, budget)
  })

  test('a stop during acquisition withdraws every waiter, and nothing stays held or waiting', async () => {
    const files: Record<string, string> = { [configFileName]: configSource() }
    for (const letter of ['a', 'b', 'c']) files[`tests/${letter}.retest.ts`] = testFile(holding(`${letter} holds the inbox`, "{ locks: ['inbox'] }", ['page'], 4000))
    const root = tempProject(files)
    const budget = new SessionBudget({ perOwner: 3, host: 3 })
    const stop = new AbortController()
    const stopper: Reporter = {
      name: 'stopper',
      onEvent: (event) => {
        if (event.type === 'lease.taken') setTimeout(() => stop.abort('SIGINT'), 200)
      },
      onRunEnd: () => undefined,
    }
    const startedAt = performance.now()
    const ran = await runWith(root, Object.keys(files).filter((path) => path.startsWith('tests/')), {
      workers: 3,
      signal: stop.signal,
      reporters: [stopper],
      timeouts: { ...quickTimeouts, test: 20_000 },
      sessions: { owner: 'agent-1', budget },
    })
    assert.ok(performance.now() - startedAt < 4000, 'the run ended before the holder could finish')
    assert.equal(ran.result.status, 'interrupted')
    const acquired = eventsOf(ran.events, 'lock.acquired')
    assert.equal(acquired.length, 1, 'one test held the inbox; the others were still waiting')
    const waiters = results(ran).filter((each) => each.attemptId !== acquired[0]?.attemptId)
    assert.deepEqual(
      waiters.map((each) => [each.status, each.ending?.kind]),
      [
        ['not_run', 'cancelled'],
        ['not_run', 'cancelled'],
      ],
    )
    for (const waiter of waiters) assert.equal(eventsOf(ran.events, 'session.reserved', waiter.attemptId).length, 0, 'a withdrawn waiter reserved nothing')
    assertNothingHeld(ran, budget)
  })
})

describe('an Electron app in a run', () => {
  test('an app launched for a test whose next app does not start is quit, so its data folder is free for the next test at once', async () => {
    const root = tempProject({
      [configFileName]: configSource(),
      'tests/a.retest.ts': testFile(holding('needs the web too', "{ apps: ['desk', 'web'] }", ['desk', 'web']), holding('uses the folder next', "{ apps: ['desk'] }", ['desk'])),
    })
    const electron = electronLauncher()
    const ran = await runWith(root, ['tests/a.retest.ts'], { electron, launcher: fakeLauncher({ launchFails: 'No browser at /fake/chromium.' }), timeouts: { ...quickTimeouts, setup: 400 } })
    assert.deepEqual([named(ran, 'needs the web too').status, named(ran, 'needs the web too').failure?.message, named(ran, 'needs the web too').cleanupFailures], ['not_run', 'No browser at /fake/chromium.', undefined])
    assert.equal(electron.apps[0]?.closeRequested, true, 'the app launched for the first test was quit')
    const next = named(ran, 'uses the folder next')
    assert.equal(next.status, 'passed', JSON.stringify(next.failure))
    const wait = eventsOf(ran.events, 'resource.acquired', next.attemptId)[0]
    assert.ok(wait !== undefined && wait.waitedMs < 400, `the next test waited ${wait?.waitedMs} ms for the folder, not the setup budget`)
  })

  test('an app whose window never became the page is quit, and the next test on its folder runs', async () => {
    const root = tempProject({ [configFileName]: configSource(), 'tests/a.retest.ts': testFile(holding('opens no window', "{ apps: ['desk'] }", ['desk']), holding('opens one', "{ apps: ['desk'] }", ['desk'])) })
    const electron = electronLauncher({ pageFails: (launch) => launch === 1 })
    const ran = await runWith(root, ['tests/a.retest.ts'], { electron, timeouts: { ...quickTimeouts, setup: 400 } })
    assert.equal(named(ran, 'opens no window').failure?.class, 'setup_failed')
    assert.equal(electron.apps[0]?.closeRequested, true)
    assert.equal(named(ran, 'opens one').status, 'passed')
  })

  test('an app that does not quit within the cleanup budget is a cleanup failure beside the outcome: a passing body is no pass, and a setup failure stays the failure', async () => {
    const root = tempProject({ [configFileName]: configSource(), 'tests/a.retest.ts': testFile(holding('passes but keeps its app', "{ apps: ['scratch'] }", ['scratch'])) })
    const ran = await runWith(root, ['tests/a.retest.ts'], { electron: electronLauncher({ quits: false }), timeouts: { ...quickTimeouts, cleanup: 150 } })
    const kept = named(ran, 'passes but keeps its app')
    assert.deepEqual([kept.status, kept.failure, kept.ending?.kind], ['error', undefined, 'cleanup_failed'])
    assert.deepEqual(kept.cleanupFailures?.map((each) => [each.class, each.message]), [['cleanup_failed', 'Quitting the Electron app scratch did not finish within the 150 ms cleanup budget.']])

    const opens = tempProject({ [configFileName]: configSource(), 'tests/a.retest.ts': testFile(holding('opens no window and stays', "{ apps: ['scratch'] }", ['scratch'])) })
    const failed = await runWith(opens, ['tests/a.retest.ts'], { electron: electronLauncher({ quits: false, pageFails: () => true }), timeouts: { ...quickTimeouts, cleanup: 150 } })
    const stays = named(failed, 'opens no window and stays')
    assert.equal(stays.failure?.class, 'setup_failed', 'the original failure stays the failure')
    assert.deepEqual(stays.cleanupFailures?.map((each) => each.message), ['Quitting the Electron app scratch did not finish within the 150 ms cleanup budget.'])
  })

  test('nothing launches for a test before it holds everything it needs: with one session and four workers, one app runs at a time', async () => {
    const files: Record<string, string> = { [configFileName]: configSource() }
    for (const letter of ['a', 'b', 'c', 'd']) files[`tests/${letter}.retest.ts`] = testFile(holding(`${letter} uses its own app`, "{ apps: ['scratch'] }", ['scratch'], 150))
    const root = tempProject(files)
    const paths = Object.keys(files).filter((path) => path.startsWith('tests/'))
    const budget = new SessionBudget({ perOwner: 1, host: 1 })
    const limited = electronLauncher()
    const ran = await runWith(root, paths, { electron: limited, workers: 4, sessions: { owner: 'agent-1', budget, waitMs: 20_000 } })
    assert.equal(ran.result.counts.passed, 4)
    assert.equal(limited.apps.length, 4)
    assert.equal(limited.most(), 1, `${limited.most()} apps ran at once on one session`)
    // The control: without a session limit the same run has several apps at once, so the count above can see overlap.
    const free = electronLauncher()
    const unlimited = await runWith(root, paths, { electron: free, workers: 4 })
    assert.equal(unlimited.result.counts.passed, 4)
    assert.ok(free.most() > 1, `without limits ${free.most()} apps ran at once`)
  })

  test('the run warms no Electron app: two runs on a host budget of one never have two apps at once', async () => {
    const root = tempProject({
      [configFileName]: configSource(),
      'tests/a.retest.ts': testFile(holding('a uses its own app', "{ apps: ['scratch'] }", ['scratch'], 300)),
      'tests/b.retest.ts': testFile(holding('b uses its own app', "{ apps: ['scratch'] }", ['scratch'], 300)),
    })
    const budget = new SessionBudget({ perOwner: 1, host: 1 })
    const electron = electronLauncher()
    const [first, second] = await Promise.all([
      runWith(root, ['tests/a.retest.ts'], { electron, sessions: { owner: 'agent-1', budget, waitMs: 20_000 } }),
      runWith(root, ['tests/b.retest.ts'], { electron, sessions: { owner: 'agent-2', budget, waitMs: 20_000 } }),
    ])
    assert.deepEqual([first.result.exitCode, second.result.exitCode], [0, 0])
    assert.equal(electron.apps.length, 2, 'one launch for each test, none at the start of a run')
    assert.equal(electron.most(), 1, `${electron.most()} apps ran at once on a host budget of one`)
  })

  test("the pool hides the secrets' variables from every browser and Electron app, and an app's output is redacted", async () => {
    const root = tempProject({ [configFileName]: configSource(), 'tests/a.retest.ts': testFile(holding('uses the web', '{}', ['page']), holding('uses its own app', "{ apps: ['scratch'] }", ['scratch'])) })
    const electron = electronLauncher()
    const ran = await runWith(root, ['tests/a.retest.ts'], { electron })
    assert.equal(ran.result.exitCode, 0)
    const given = electron.apps[0]?.options
    assert.ok(given?.hiddenVariables?.includes(passwordVariable), 'the app never sees the variable the password is read from')
    assert.equal(given?.redact?.(`typed ${password} into the app`), 'typed {{password}} into the app')
    assert.ok(ran.browsers[0]?.launchOptions.hiddenVariables?.includes(passwordVariable), 'nor does the browser')
  })

  test('final log redaction waits for an outstanding app writer and fails cleanup while its outcome is unknown', async () => {
    const root = tempProject({ [configFileName]: configSource(), 'tests/a.retest.ts': testFile(holding('uses its own app', "{ apps: ['scratch'] }", ['scratch'])) })
    const output = Promise.withResolvers<void>()
    const electron = electronLauncher({ outputSettled: output.promise })
    const launch = electron.launch
    electron.launch = async (options, timeoutMs) => {
      const app = await launch(options, timeoutMs)
      mkdirSync(dirname(options.logFile), { recursive: true })
      writeFileSync(options.logFile, password)
      return app
    }
    try {
      const ran = await runWith(root, ['tests/a.retest.ts'], { electron, timeouts: { ...quickTimeouts, cleanup: 20 } })
      const log = electron.apps[0]?.options.logFile
      assert.ok(log !== undefined)
      assert.equal(ran.result.exitCode, 2)
      assert.match(JSON.stringify(ran.result.failure), /final log redaction could not be confirmed/)
      assert.equal(readFileSync(log, 'utf8'), password, 'the runner never rewrites a file with an outstanding writer')
      output.resolve()
      await settle()
      assert.equal(readFileSync(log, 'utf8'), '{{password}}', 'the rewrite runs once the writer is confirmed finished')
    } finally {
      output.resolve()
    }
  })

  test('two tests on one named data folder take turns by lease: the second waits past the setup budget and runs, naming who held the folder', async () => {
    const root = tempProject({
      [configFileName]: configSource(),
      'tests/a.retest.ts': testFile(holding('a holds the folder', "{ apps: ['desk'] }", ['desk'], 700)),
      'tests/b.retest.ts': testFile(holding('b holds the folder', "{ apps: ['desk'] }", ['desk'], 700)),
    })
    const electron = electronLauncher()
    const ran = await runWith(root, ['tests/a.retest.ts', 'tests/b.retest.ts'], { electron, workers: 2, timeouts: { ...quickTimeouts, setup: 300 } })
    assert.equal(ran.result.counts.passed, 2, JSON.stringify(results(ran).map((each) => each.failure?.message)))
    assert.equal(electron.most(), 1, 'the folder never had two apps on it')
    const waited = eventsOf(ran.events, 'resource.acquired').find((event) => event.waitedMs > 0)
    assert.ok(waited !== undefined && waited.waitedMs > 300, `one test waited ${waited?.waitedMs} ms, longer than the 300 ms setup budget a launch waits for a folder`)
    const holder = results(ran).find((each) => each.attemptId !== waited.attemptId)
    assert.deepEqual([waited.heldBy, waited.heldElsewhere], [[holder?.testId], undefined])
    const [part] = waited.resources
    assert.deepEqual([waited.resources.length, part?.kind, part?.apps], [1, 'data-folder', ['desk']])
    assert.ok(part?.name.endsWith('/.data/desk'), part?.name)
    assert.match(humanReport(ran), /holds the folder {2}desk=electron \(Electron\) {2}(\d+ ms|[\d.]+s)\n {6}holds the data folder \S+\/\.data\/desk of desk=electron, after waiting (\d+ ms|[\d.]+s)\n {6}held by tests\/[ab]\.retest\.ts > [ab] holds the folder\n/)
    assert.deepEqual(eventsOf(ran.events, 'test.started', waited.attemptId)[0]?.execution?.sessions.map((session) => session.resource), ['data-folder'])
  })

  test('two runs in one process take turns on one named data folder, and neither names the other\'s test', async () => {
    const root = tempProject({
      [configFileName]: configSource(),
      'tests/a.retest.ts': testFile(holding('run one holds the folder', "{ apps: ['desk'] }", ['desk'], 400)),
      'tests/b.retest.ts': testFile(holding('run two holds the folder', "{ apps: ['desk'] }", ['desk'], 400)),
    })
    const electron = electronLauncher()
    const runs = await Promise.all([runWith(root, ['tests/a.retest.ts'], { electron }), runWith(root, ['tests/b.retest.ts'], { electron })])
    assert.deepEqual(runs.map((ran) => ran.result.exitCode), [0, 0])
    assert.equal(electron.most(), 1, 'the two runs never had two apps on the folder')
    const waits = runs.flatMap((ran) => eventsOf(ran.events, 'resource.acquired')).filter((event) => event.waitedMs > 0)
    assert.equal(waits.length, 1)
    assert.deepEqual([waits[0]?.heldBy, waits[0]?.heldElsewhere], [undefined, 1])
    const waiting = runs.find((ran) => eventsOf(ran.events, 'resource.acquired').some((event) => event.waitedMs > 0))
    assert.ok(waiting !== undefined)
    assert.match(humanReport(waiting), /\n {6}held by another run in this process\n/)
    assert.ok(!JSON.stringify(waiting.events).includes(waiting === runs[0] ? 'run two holds' : 'run one holds'), "the other run's test is never named")
  })

  test('two names for one folder are one lease on a disk that ignores case', async () => {
    const root = tempProject({
      [configFileName]: configSource(),
      'tests/a.retest.ts': testFile(holding('desk holds the folder', "{ apps: ['desk'] }", ['desk'], 300)),
    })
    // Read from the disk itself, not from the key under test: the project's folder written in upper case is the same file.
    const ignoring = existsSync(root.toUpperCase()) && statSync(root.toUpperCase()).ino === statSync(root).ino
    // One config that names the folder twice is refused as it loads (below), so the second name comes from another
    // project's config, whose run takes its leases in this process too.
    const other = tempProject({
      [configFileName]: configSource(`notes: electron({ executablePath: '/opt/Electron', appPath: 'desk', userDataDir: ${JSON.stringify(join(root, '.data/Desk'))} }),`),
      'tests/b.retest.ts': testFile(holding('notes holds the folder', "{ apps: ['notes'] }", ['notes'], 300)),
    })
    const electron = electronLauncher()
    const runs = await Promise.all([runWith(root, ['tests/a.retest.ts'], { electron }), runWith(other, ['tests/b.retest.ts'], { electron })])
    assert.deepEqual(runs.map((ran) => ran.result.counts.passed), [1, 1])
    assert.equal(electron.most(), ignoring ? 1 : 2, ignoring ? 'one folder on this disk, so one app at a time' : 'two folders on a disk that keeps case')

    // Within one config, the two names are one folder on a disk that ignores case, which the config refuses naming both.
    const twice = tempProject({ [configFileName]: configSource("notes: electron({ executablePath: '/opt/Electron', appPath: 'desk', userDataDir: '.data/Desk' }),") })
    const loaded = await loadConfig(join(twice, configFileName))
    if (ignoring) {
      assert.equal(loaded.ok, false)
      assert.match(loaded.ok ? '' : loaded.failure.message, /: apps\.notes\.userDataDir: is also the data folder of apps\.desk: give each Electron target a folder of its own$/)
    } else {
      assert.ok(loaded.ok, loaded.ok ? '' : loaded.failure.message)
    }
  })

  test('a folder that is not free when its holder lets go expires the lease and is a cleanup failure, and the test waiting for it fails setup naming the holder', async () => {
    const root = tempProject({
      [configFileName]: configSource(),
      'tests/a.retest.ts': testFile(holding('a uses the folder', "{ apps: ['desk'] }", ['desk'])),
      'tests/b.retest.ts': testFile(holding('b uses the folder', "{ apps: ['desk'] }", ['desk'])),
    })
    const ran = await runWith(root, ['tests/a.retest.ts', 'tests/b.retest.ts'], { electron: electronLauncher({ quits: false }), workers: 2, timeouts: { ...quickTimeouts, setup: 250, cleanup: 150 } })
    const kept = results(ran).find((each) => each.status === 'error')
    const refused = results(ran).find((each) => each.status === 'not_run')
    assert.ok(kept !== undefined && refused !== undefined, JSON.stringify(results(ran).map((each) => [each.name, each.status])))
    assert.deepEqual(kept.cleanupFailures?.map((each) => each.message), ['Quitting the Electron app desk did not finish within the 150 ms cleanup budget.'])
    const expired = eventsOf(ran.events, 'lease.expired', kept.attemptId)
    assert.equal(expired.length, 1)
    assert.deepEqual([expired[0]?.held.map((part) => part.kind), expired[0]?.released], [['data-folder'], []])
    assert.equal(refused.failure?.class, 'setup_failed')
    const holder = kept.testId.replaceAll('.', '\\.')
    assert.match(refused.failure?.message ?? '', new RegExp(`^Not run: the data folder \\S+/\\.data/desk of desk=electron did not come free\\. ${holder} held it past the end of its lease, and the test waited 250 ms more, \\d+ ms in all\\.$`))
    const shown = card(ran, refused)
    assert.match(shown, /\n {4}Waited for {7}"the data folder \S+\/\.data\/desk of desk=electron"\n/)
    assert.match(shown, new RegExp(`\\n {4}Held by {10}"${holder}"\\n`))
    assert.match(humanReport(ran), new RegExp(`\\n {2}Not run\\n {4}\\S+ › [ab] uses the folder  desk=electron \\(Electron\\)  Not run: the data folder \\S+ of desk=electron did not come free\\. ${holder} held it past the end of its lease`))

    // The pool could not stop the app, so the folder stays held past the run's end, and a later run is not handed it.
    const key = JSON.stringify(['data-folder', folderKey(join(root, '.data/desk'))])
    assert.equal(hostResources.holders().get(key), kept.testId, 'the folder is still held after the run')
    const later = await runWith(root, ['tests/a.retest.ts'], { electron: electronLauncher(), timeouts: { ...quickTimeouts, setup: 250 } })
    const turnedAway = named(later, 'a uses the folder')
    assert.equal(turnedAway.status, 'not_run')
    assert.match(turnedAway.failure?.message ?? '', /did not come free\. another run in this process held it past the end of its lease/)
  })

  test('a launch given up on that brings its app up later keeps its folder until that app is gone, so a second run never shares it', async () => {
    const root = tempProject({
      [configFileName]: configSource(),
      'tests/a.retest.ts': testFile(holding('run one uses the folder', "{ apps: ['desk'] }", ['desk'], 1000)),
      'tests/b.retest.ts': testFile(holding('run two uses the folder', "{ apps: ['desk'] }", ['desk'], 1000)),
    })
    // The first launch outlasts the setup budget and its grace, so the pool gives up on it, and its app comes up after.
    const electron = electronLauncher({ launchMs: (index) => (index === 0 ? 1800 : 0) })
    const timeouts = { ...quickTimeouts, setup: 300, test: 5000 }
    const runs = await Promise.all([runWith(root, ['tests/a.retest.ts'], { electron, timeouts }), runWith(root, ['tests/b.retest.ts'], { electron, timeouts })])
    const tests = runs.flatMap(results)
    const abandoned = tests.find((each) => each.status === 'not_run')
    const ran = tests.find((each) => each.status === 'passed')
    assert.ok(abandoned !== undefined && ran !== undefined, JSON.stringify(tests.map((each) => [each.name, each.status, each.failure?.message])))
    assert.match(abandoned.failure?.message ?? '', /did not start within the 300 ms setup budget/)
    assert.equal(electron.apps.length, 2)
    assert.equal(electron.most(), 1, 'the app that came up late was gone before the other run had the folder')
    const waited = runs.flatMap((each) => eventsOf(each.events, 'resource.acquired')).find((event) => event.waitedMs > 0)
    assert.ok(waited !== undefined && waited.waitedMs >= 1700, `the other run waited ${waited?.waitedMs} ms, until the late app was gone`)
  })

  test('a data folder on a disk whose case rule cannot be read keeps the test from running, and says why', async () => {
    // With one named data folder the config has nothing to tell it apart from, so the run is the first to read its disk.
    const root = tempProject({
      [configFileName]: `import { chromium, defineConfig, electron, env } from '@rehearsal-labs/retest'
export default defineConfig({
  apps: {
    web: chromium({ baseUrl: 'http://127.0.0.1:4173', executablePath: '/fake/chromium' }),
    locked: electron({ executablePath: '/opt/Electron', appPath: 'desk', userDataDir: 'locked/data' }),
  },
  defaultApp: 'web',
  secrets: { password: env('${passwordVariable}') },
})
`,
      'tests/a.retest.ts': testFile(holding('uses a folder it cannot read', "{ apps: ['locked'] }", ['locked'])),
    })
    // Beside another named folder, the config reads both folders' disks as it loads, to tell them apart.
    const beside = tempProject({ [configFileName]: configSource("locked: electron({ executablePath: '/opt/Electron', appPath: 'desk', userDataDir: 'locked/data' }),") })
    for (const project of [root, beside]) {
      mkdirSync(join(project, 'locked'))
      chmodSync(join(project, 'locked'), 0o555)
    }
    try {
      const ran = await runWith(root, ['tests/a.retest.ts'], { electron: electronLauncher() })
      const refused = named(ran, 'uses a folder it cannot read')
      assert.deepEqual([refused.status, refused.failure?.class], ['not_run', 'setup_failed'])
      assert.match(refused.failure?.message ?? '', /^Not run: Retest could not read where a data folder of the test is, or whether its disk ignores case: .*(EACCES|permission denied)/i)
      const loaded = await loadConfig(join(beside, configFileName))
      assert.equal(loaded.ok, false)
      assert.match(loaded.ok ? '' : loaded.failure.message, /: apps\.locked\.userDataDir: could not read the folder or its disk's case rule: .*(EACCES|permission denied)/i)
    } finally {
      for (const project of [root, beside]) chmodSync(join(project, 'locked'), 0o755)
    }
  })

  // Its own limit, since a budget of 24 days would otherwise let a regression hang the suite.
  test('at the largest setup and cleanup budgets, a page still opens, a state is saved, a screenshot is taken and a host check reads the page', { timeout: 30_000 }, async () => {
    const root = tempProject({
      [configFileName]: configSource(),
      'tests/a.retest.ts': testFile(
        `test.setup('signed-in', async ({ page }) => {
  await page.goto('/login')
  await page.getByTestId('sign-in').click()
  await expect(page.getByTestId('session')).toHaveText('Signed in')
})`,
        `test('starts signed in', { state: 'signed-in' }, async ({ page }) => {
  await expect(page.getByTestId('session')).toHaveText('Signed in')
})`,
        `test('fails its check', async ({ page }) => {
  await expect(page.getByTestId('saved-task')).toHaveText('Never saved')
})`,
      ),
    })
    const hostChecks = { 'tests/a.retest.ts > starts signed in': [{ kind: 'text' as const, id: 'save-shown', app: 'web', text: 'Save', timeoutMs: maxTimeout }] }
    const largest = await warningsDuring(() => runWith(root, ['tests/a.retest.ts'], { hostChecks, timeouts: { ...quickTimeouts, setup: maxTimeout, cleanup: maxTimeout } }))
    const ran = largest.value
    assert.deepEqual(
      results(ran).map((each) => [each.name, each.status]),
      [
        ['signed-in', 'passed'],
        ['starts signed in', 'passed'],
        ['fails its check', 'failed'],
      ],
      JSON.stringify(results(ran).map((each) => each.failure?.message)),
    )
    assert.deepEqual(named(ran, 'starts signed in').hostChecks?.map((check) => check.status), ['passed'])
    assert.equal(named(ran, 'fails its check').evidence.length, 1, 'the failure has its screenshot')
    assert.equal(eventsOf(ran.events, 'state.saved').length, 1)
    assert.deepEqual(largest.warnings, [], 'no timer was set longer than Node can count')
  })

  test('at the largest test budget a run takes, no lease ends early and no timer overflows; at the largest cleanup budget an app still has its time to quit', async () => {
    const root = tempProject({ [configFileName]: configSource(), 'tests/a.retest.ts': testFile(holding('holds everything', "{ locks: ['inbox'], apps: ['web', 'desk'] }", ['web', 'desk'], 50)) })
    const budget = new SessionBudget({ perOwner: 2, host: 2 })
    const longest = await warningsDuring(() => runWith(root, ['tests/a.retest.ts'], { electron: electronLauncher(), sessions: { owner: 'agent-1', budget }, timeouts: { ...quickTimeouts, test: maxTimeout } }))
    assert.equal(named(longest.value, 'holds everything').status, 'passed', JSON.stringify(named(longest.value, 'holds everything').failure))
    assert.deepEqual(eventsOf(longest.value.events, 'lease.expired'), [])
    assert.deepEqual(longest.warnings, [], 'no timer was set longer than Node can count')

    const quitting = tempProject({ [configFileName]: configSource(), 'tests/a.retest.ts': testFile(holding('opens no window', "{ apps: ['scratch'] }", ['scratch'])) })
    const slow = await warningsDuring(() => runWith(quitting, ['tests/a.retest.ts'], { electron: electronLauncher({ pageFails: () => true, closeMs: 60 }), timeouts: { ...quickTimeouts, cleanup: maxTimeout } }))
    const result = named(slow.value, 'opens no window')
    assert.equal(result.failure?.class, 'setup_failed')
    assert.equal(result.cleanupFailures, undefined, 'the quit was waited for, not given up on at once')
    assert.deepEqual(slow.warnings, [])
  })
})

describe('the records of a lease', () => {
  test('lock.acquired keeps its shape and comes when the lock is granted; resources, sessions and the whole lease follow in the acquisition order', async () => {
    const root = tempProject({ [configFileName]: configSource(), 'tests/a.retest.ts': testFile(holding('holds both', "{ locks: ['inbox'], apps: ['web', 'desk'] }", ['web', 'desk'])) })
    const budget = new SessionBudget({ perOwner: 2, host: 2 })
    const ran = await runWith(root, ['tests/a.retest.ts'], { electron: electronLauncher(), sessions: { owner: 'agent-1', budget } })
    const result = named(ran, 'holds both')
    assert.equal(result.status, 'passed', JSON.stringify(result.failure))
    const order = ran.events.filter((event) => 'attemptId' in event && event.attemptId === result.attemptId).map((event) => event.type)
    assert.deepEqual(order.slice(0, 5), ['lock.acquired', 'resource.acquired', 'session.reserved', 'lease.taken', 'test.started'])
    const acquired = eventsOf(ran.events, 'lock.acquired', result.attemptId)[0]
    assert.deepEqual(Object.keys(acquired ?? {}).sort(), ['attemptId', 'elapsedMs', 'locks', 'origin', 'runId', 'schemaVersion', 'sequence', 'testId', 'time', 'type', 'variant', 'variantKey', 'waitedMs'], 'no field a Phase 1 reader does not know')
    const taken = eventsOf(ran.events, 'lease.taken', result.attemptId)[0]
    assert.deepEqual(
      taken?.lease.covers.map((part) => [part.kind, part.apps, part.count]),
      [
        ['lock', undefined, undefined],
        ['data-folder', ['desk'], undefined],
        ['sessions', ['web', 'desk'], 2],
      ],
    )
    assert.equal(taken?.lease.releaseWithinMs, quickTimeouts.cleanup)
    assert.deepEqual(
      result.execution?.sessions.map((session) => [session.app, session.resource]),
      [
        ['web', 'browser-context'],
        ['desk', 'data-folder'],
      ],
    )
    assertNothingHeld(ran, budget)
  })

  test('a test that holds nothing records no lease, and its session is a browser context', async () => {
    const root = tempProject({ [configFileName]: configSource(), 'tests/a.retest.ts': testFile(holding('holds nothing', '{}', ['page'])) })
    const ran = await runWith(root, ['tests/a.retest.ts'])
    assert.deepEqual(['lock.acquired', 'resource.acquired', 'session.reserved', 'lease.taken', 'lease.expired'].map((type) => ran.events.filter((event) => event.type === type).length), [0, 0, 0, 0, 0])
    assert.deepEqual(named(ran, 'holds nothing').execution?.sessions.map((session) => session.resource), ['browser-context'])
  })
})

describe('commands in one session', () => {
  test('go one at a time: a second command sent while one runs is refused by name, and the page never has two at once', async () => {
    let inFlight = 0
    let most = 0
    const launcher = fakeLauncher({
      holdAnswer: async () => {
        inFlight += 1
        most = Math.max(most, inFlight)
        await sleep(50)
        inFlight -= 1
      },
    })
    const tests = `import { expect, test } from '@rehearsal-labs/retest'

test('sends two at once', async ({ page }) => {
  await Promise.all([page.getByTestId('task-title').fill('Release checklist'), page.getByTestId('save-task').click()])
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
})
`
    const root = tempProject({ [configFileName]: configSource(), 'tests/a.retest.ts': tests })
    const ran = await runWith(root, ['tests/a.retest.ts'], { launcher })
    assert.equal(named(ran, 'sends two at once').failure?.class, 'concurrent_commands')
    assert.equal(most, 1, 'the page never had two commands at once')
  })
})
