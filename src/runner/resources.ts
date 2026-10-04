import type { LoadedApp, LoadedTarget } from '../config/loaded.ts'
import type { LeasePart, LeaseRecord, ResourceKind } from '../protocol/events.ts'
import type { SessionResource } from '../protocol/execution.ts'
import type { Failure } from '../protocol/failures.ts'
import type { Variant } from '../protocol/variant.ts'
import type { HeldLocks, LockGrant } from './locks.ts'
import type { SessionBudget, SessionLease, SessionRequest } from './sessions.ts'
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { Deadline } from '../protocol/deadline.ts'
import { failure } from '../protocol/failures.ts'
import { maxTimeout } from '../protocol/timeouts.ts'
import { variantKey } from '../protocol/variant.ts'
import { listWords } from '../shared/list-words.ts'
import { bounded } from './bounded.ts'
import { SharedLocks } from './locks.ts'
import { sessionRefusal } from './sessions.ts'

// What a test needs before it acts, and how it holds it. Every attempt acquires in one order: its locks, then the
// interactive desktop, then simulator devices, then named Electron data folders, then its owner's sessions; within a
// kind, by name. Locks belong to the run and live in its lock table. The desktop, devices and data folders belong to the
// machine and live in one table this process shares across its runs. Sessions come from the host's budget. Each stage
// is taken all at once or not at all, and an attempt holds each stage while it waits for the next. No attempt waits for
// anything earlier in the order than what it holds, so no two attempts can each hold what the other waits for.
// Everything is given back in the reverse order, each part once it is really free.

/** The kinds in the order every attempt acquires them. */
export const acquisitionOrder: readonly ResourceKind[] = ['lock', 'desktop', 'device', 'data-folder', 'sessions']

/**
 * The desktop, devices and data folders of this process, shared by every run in it: a Mac has one interactive desktop,
 * and a folder on disk is one folder whichever run names it.
 */
export const hostResources: SharedLocks = new SharedLocks()

/**
 * One thing a test needs before it acts: a kind, a name as the config gives it, the key it is held under, and the apps
 * it serves. Two apps on one desktop, one device or one data folder need it once. `count` is the number of sessions,
 * one for each app.
 */
export type ResourceNeed = { readonly kind: ResourceKind; readonly name: string; readonly key: string; readonly apps: readonly string[]; readonly count?: number }

/** What a test's needs are computed from: its apps and the target each runs on, the config's apps, its locks, and the session owner when the run counts sessions. */
export type NeedsSource = {
  readonly apps: readonly string[]
  readonly targets: Variant
  readonly config: ReadonlyMap<string, LoadedApp>
  readonly locks: readonly string[]
  readonly owner?: string | undefined
}

/**
 * A test's needs, from its declared apps and locks, in the order they are acquired. A web browser target needs only a
 * session, and only when the run counts sessions; a macOS app needs the desktop, an iOS app its simulator device, and
 * an Electron app on a named data folder that folder, held under its real path.
 *
 * @example resourceNeeds({ apps: ['mac', 'web'], targets: { mac: 'macos', web: 'chrome' }, config, locks: ['inbox'] }).map((need) => need.kind) // ['lock', 'desktop']
 */
export function resourceNeeds(source: NeedsSource): ResourceNeed[] {
  const needs = new Map<string, { kind: ResourceKind; name: string; key: string; apps: string[] }>()
  for (const lock of source.locks) needs.set(tableKey({ kind: 'lock', key: lock }), { kind: 'lock', name: lock, key: lock, apps: [] })
  for (const app of source.apps) {
    const target = targetOf(source, app)
    const resource = target === undefined ? undefined : targetResource(target)
    if (resource === undefined) continue
    const known = needs.get(tableKey(resource))
    if (known === undefined) needs.set(tableKey(resource), { ...resource, apps: [app] })
    else known.apps.push(app)
  }
  const ordered: ResourceNeed[] = [...needs.values()]
  if (source.owner !== undefined && source.apps.length > 0) ordered.push({ kind: 'sessions', name: source.owner, key: source.owner, apps: [...source.apps], count: source.apps.length })
  return ordered.sort(compareNeeds)
}

/**
 * The acquisition order: by kind, in `acquisitionOrder`, then by key, comparing code units so the order is the same on
 * every machine.
 *
 * @example [{ kind: 'data-folder', key: 'b' }, { kind: 'lock', key: 'a' }].sort(compareNeeds)[0]?.kind // 'lock'
 */
export function compareNeeds(first: Pick<ResourceNeed, 'kind' | 'key'>, second: Pick<ResourceNeed, 'kind' | 'key'>): number {
  const byKind = acquisitionOrder.indexOf(first.kind) - acquisitionOrder.indexOf(second.kind)
  if (byKind !== 0) return byKind
  return first.key < second.key ? -1 : first.key > second.key ? 1 : 0
}

/**
 * The key a data folder is held under: its real path, through every link, with the part that does not exist yet added
 * as written; on a volume that ignores case, the whole of it in lower case. So two names for one folder are one lease.
 * Throws when the path cannot be resolved or the volume's case rule cannot be read.
 *
 * @example folderKey('/work/.data/Desk') === folderKey('/work/.data/desk') // true on a volume that ignores case
 */
export function folderKey(path: string): string {
  const missing: string[] = []
  let existing = resolve(path)
  while (!existsSync(existing) && dirname(existing) !== existing) {
    missing.unshift(basename(existing))
    existing = dirname(existing)
  }
  const real = realpathSync.native(existing)
  const whole = missing.length === 0 ? real : join(real, ...missing)
  return ignoresCase(probeFolder(real, missing.length === 0)) ? whole.toLowerCase() : whole
}

/**
 * The resource a session of this target takes, as the execution record names it.
 *
 * @example sessionResource({ name: 'macos', platform: 'macos', appPath: '/Applications/TaskDesk.app' }) // 'desktop'
 */
export function sessionResource(target: LoadedTarget | undefined): SessionResource {
  if (target === undefined) return 'browser-context'
  if ('platform' in target) return target.platform === 'macos' ? 'desktop' : 'device'
  if (target.browser !== 'electron') return 'browser-context'
  return target.userDataDir === undefined ? 'app-launch' : 'data-folder'
}

/**
 * A part of a lease in words, naming each app with its target when the attempt has a variant.
 *
 * @example describeLeasePart({ kind: 'desktop', name: 'macos', apps: ['mac'] }, { mac: 'macos' }) // 'the desktop of mac=macos'
 */
export function describeLeasePart(part: LeasePart, variant?: Variant): string {
  const apps = listWords((part.apps ?? []).map((app) => (variant?.[app] === undefined ? app : variantKey({ [app]: variant[app] }))), 'and')
  const of = apps === '' ? '' : ` of ${apps}`
  switch (part.kind) {
    case 'lock':
      return `lock ${part.name}`
    case 'desktop':
      return `the desktop${of}`
    case 'device':
      return `the simulator ${part.name}${of}`
    case 'data-folder':
      return `the data folder ${part.name}${of}`
    case 'sessions': {
      const count = part.count ?? 1
      return `${count} ${count === 1 ? 'session' : 'sessions'} of ${part.name}`
    }
  }
}

/**
 * Parts of a lease in words, joined as a sentence lists a set.
 *
 * @example describeLeaseParts([{ kind: 'lock', name: 'inbox' }, { kind: 'desktop', name: 'macos', apps: ['mac'] }]) // 'lock inbox and the desktop of mac'
 */
export function describeLeaseParts(parts: readonly LeasePart[], variant?: Variant): string {
  return listWords(
    parts.map((part) => describeLeasePart(part, variant)),
    'and',
  )
}

/** How an attempt draws on the host's session budget, when the run counts sessions. */
export type SessionDraw = { readonly budget: SessionBudget; readonly owner: string; readonly waitMs: number }

/** One stage of an attempt's acquisition, as it is granted: its locks, its desktop, devices and data folders, or its sessions. */
export type AcquiredStage =
  | { readonly kind: 'locks'; readonly needs: readonly ResourceNeed[]; readonly waitedMs: number; readonly heldBy: readonly string[] }
  | { readonly kind: 'resources'; readonly needs: readonly ResourceNeed[]; readonly waitedMs: number; readonly heldBy: readonly string[]; readonly heldElsewhere: number }
  | { readonly kind: 'sessions'; readonly lease: SessionLease }

/**
 * What an attempt asks for: its needs, the test it runs, which a record of a wait names, the run it belongs to, its
 * place in the run's order, which decides who goes first among the run's tests waiting for a lock, the run's lock
 * table, the process's table of desktops, devices and data folders, the host's budget when sessions are counted, and
 * the bounds. `pastLeaseMs` is how long it waits behind a lease that has expired; `releaseWithinMs` is how long a part
 * of its own lease may take to come free once it lets go. `onAcquired` is told of each stage as it is granted.
 */
export type ResourceRequest = {
  readonly attemptId: string
  readonly holder: string
  readonly scope: string
  readonly position: number
  readonly needs: readonly ResourceNeed[]
  readonly locks: SharedLocks
  readonly resources: SharedLocks
  readonly sessions?: SessionDraw | undefined
  readonly pastLeaseMs: number
  readonly releaseWithinMs: number
  /** Names each app with its target in failure messages. */
  readonly variant?: Variant | undefined
  readonly onAcquired?: ((stage: AcquiredStage) => void) | undefined
}

/**
 * The answer to a request: the lease, or why there is none, holding nothing. `stopped` is a request withdrawn when the
 * run stopped, whose failure the run replaces with its own reason. A refused request gave back whatever it held.
 */
export type ResourceGrant = { readonly ok: true; readonly lease: ResourceLease } | { readonly ok: false; readonly stopped: boolean; readonly failure: Failure }

/**
 * Acquires what an attempt needs, stage by stage in the acquisition order: its locks, then its desktop, devices and data
 * folders, then its sessions. A request that cannot have everything within its bounds gives back what it held, in
 * reverse order, and holds nothing.
 *
 * @example const grant = await acquireResources({ attemptId, holder: testId, scope: runId, position: 0, needs, locks, resources: hostResources, pastLeaseMs: 60_000, releaseWithinMs: 10_000 }, stopped)
 */
export async function acquireResources(request: ResourceRequest, stopped: Promise<unknown>): Promise<ResourceGrant> {
  const locks = request.needs.filter((need) => need.kind === 'lock')
  const resources = request.needs.filter((need) => need.kind !== 'lock' && need.kind !== 'sessions')
  const counted = request.needs.find((need) => need.kind === 'sessions')
  const heldLocks = await reserveStage(request, request.locks, locks, request.position, stopped)
  if (!heldLocks.ok) return heldLocks
  if (heldLocks.lease !== undefined) request.onAcquired?.({ kind: 'locks', needs: locks, waitedMs: heldLocks.lease.waitedMs, heldBy: heldLocks.lease.heldBy })
  // The machine's resources go to the run that asked first, whatever each run's own order.
  const heldResources = await reserveStage(request, request.resources, resources, 0, stopped)
  if (!heldResources.ok) {
    heldLocks.lease?.release()
    return heldResources
  }
  if (heldResources.lease !== undefined) {
    const { waitedMs, heldBy, heldElsewhere } = heldResources.lease
    request.onAcquired?.({ kind: 'resources', needs: resources, waitedMs, heldBy, heldElsewhere: heldElsewhere ?? 0 })
  }
  let sessions: SessionLease | undefined
  if (counted !== undefined && request.sessions !== undefined) {
    const { budget, owner, waitMs } = request.sessions
    const sessionRequest: SessionRequest = { owner, count: counted.count ?? counted.apps.length, holder: request.holder, waitMs, scope: request.scope }
    const grant = await budget.reserve(sessionRequest, stopped)
    if (!grant.ok) {
      heldResources.lease?.release()
      heldLocks.lease?.release()
      if (grant.reason === 'stopped') return { ok: false, stopped: true, failure: withdrawn() }
      const refused = sessionRefusal(grant, sessionRequest, budget.limits)
      const exclusive = [...locks, ...resources]
      const gaveBack = exclusive.length === 0 ? {} : { held: describeLeaseParts(exclusive.map(leasePart), request.variant) }
      return { ok: false, stopped: false, failure: { ...refused, details: { ...refused.details, ...gaveBack } } }
    }
    sessions = grant.lease
    request.onAcquired?.({ kind: 'sessions', lease: sessions })
  }
  return { ok: true, lease: new ResourceLease({ request, locks: heldLocks.lease, resources: heldResources.lease, sessions }) }
}

/**
 * What made an app ready for an attempt says when what it took is free again: an Electron app once its processes are
 * gone, a native session once it has ended. This is the hook a session provider fills; an app made ready without it
 * that holds a desktop, a device or a data folder keeps that part until the run ends.
 */
export type HeldApp = { readonly whenFree?: (() => Promise<void>) | undefined }

/**
 * When a part of a lease is really free: at once for a lock or sessions, which the caller gives back by its own rule;
 * otherwise once every app made ready on it says so. A part no app was made ready on is free at once.
 *
 * @example await partFree(need, new Map([['desk', { whenFree: () => app.gone }]]))
 */
export function partFree(need: ResourceNeed, apps: ReadonlyMap<string, HeldApp>): Promise<void> | undefined {
  if (need.kind === 'lock' || need.kind === 'sessions') return undefined
  const signals = need.apps.flatMap((app) => {
    const held = apps.get(app)
    if (held === undefined) return []
    return [held.whenFree?.() ?? new Promise<void>(() => undefined)]
  })
  return signals.length === 0 ? undefined : Promise.all(signals).then(() => undefined)
}

/**
 * What a lease's release asks of its holder. `whenFree` resolves once a desktop, a device or a data folder is really
 * free; undefined when it already is. A hook that throws or rejects says nothing about whether the part is free, so the
 * part stays held as one that never came free. `giveBackSessions` gives the sessions back by the caller's own rule,
 * which waits for the attempt's browser contexts to close, and says whether it gave them back now. Once the run is
 * ending nothing is bounded, since everything closes with it.
 */
export type ReleaseOptions = {
  readonly whenFree: (part: ResourceNeed) => Promise<void> | undefined
  readonly giveBackSessions: (sessions: SessionLease) => boolean
  readonly ending: boolean
}

/** What did not come free within its time once the attempt let go, which stays held until it is, and what had really come back by then. */
export type LeaseExpiry = { readonly held: readonly ResourceNeed[]; readonly released: readonly ResourceNeed[] }

/** The order a lease gives things back in: the reverse of the acquisition order. */
export function releaseOrder(needs: readonly ResourceNeed[]): ResourceNeed[] {
  return [...needs].sort(compareNeeds).reverse()
}

/**
 * What an attempt holds while it runs: its attempt, what it covers in the acquisition order, when it was taken, and how
 * long a desktop, a device or a data folder may take to come free once the attempt lets go. One that does not come
 * free in that time expires the lease and stays held until it is free, even past the run's end, so no later run in the
 * process is handed it while it may be in use. The attempt's own budgets bound everything before it lets go.
 */
export class ResourceLease {
  readonly attemptId: string
  readonly holder: string
  readonly covers: readonly ResourceNeed[]
  readonly takenAt: Date
  readonly releaseWithinMs: number
  readonly sessions: SessionLease | undefined
  readonly #locks: HeldLocks | undefined
  readonly #resources: HeldLocks | undefined
  readonly #released = new Set<ResourceNeed>()
  /** Parts waiting to come free, each with the signal that says it is. */
  readonly #pending = new Map<ResourceNeed, Promise<void>>()
  readonly #expiryListeners = new Set<(expiry: LeaseExpiry) => void>()
  #expiry: LeaseExpiry | undefined
  #releasing: Promise<void> | undefined

  constructor({ request, locks, resources, sessions }: { request: ResourceRequest; locks: HeldLocks | undefined; resources: HeldLocks | undefined; sessions: SessionLease | undefined }) {
    this.attemptId = request.attemptId
    this.holder = request.holder
    this.covers = [...request.needs].sort(compareNeeds)
    this.takenAt = new Date()
    this.releaseWithinMs = request.releaseWithinMs
    this.sessions = sessions
    this.#locks = locks
    this.#resources = resources
  }

  /** Whether the lease holds anything at all. A test with no locks, no resources and no session limits holds none. */
  get empty(): boolean {
    return this.covers.length === 0
  }

  /** What expired, once something did. */
  get expiry(): LeaseExpiry | undefined {
    return this.#expiry
  }

  /** The lease as records write it, with every name passed through `redact`. */
  record(redact: (text: string) => string): LeaseRecord {
    return { covers: this.covers.map((need) => redactedPart(leasePart(need), redact)), takenAt: this.takenAt.toISOString(), releaseWithinMs: Math.max(1, this.releaseWithinMs) }
  }

  /** Tells `listener` once, when the lease expires. Returns a function that removes it. */
  onExpired(listener: (expiry: LeaseExpiry) => void): () => void {
    this.#expiryListeners.add(listener)
    return () => this.#expiryListeners.delete(listener)
  }

  /**
   * Gives back everything in the reverse of the acquisition order: sessions by the caller's rule, then each data folder,
   * device and desktop once it is free, then the locks. A part not free within `releaseWithinMs` expires the lease and
   * stays held until it is, and the rest is given back. A second call waits for the first.
   */
  release(options: ReleaseOptions): Promise<void> {
    this.#releasing ??= this.#release(options)
    return this.#releasing
  }

  /**
   * Once the run has closed everything that could hold a part: waits up to `timeoutMs` for the parts still coming free,
   * and gives each back as it does. A part still not free then stays held and expires the lease, if it has not already
   * expired for it, so the record says it stayed.
   */
  async finish(timeoutMs: number): Promise<void> {
    await this.#releasing
    await bounded(Promise.all(this.#pending.values()), Math.min(Math.max(0, timeoutMs), maxTimeout))
    const left = [...this.#pending.keys()]
    if (left.length > 0) this.#expire(left)
  }

  async #release({ whenFree, giveBackSessions, ending }: ReleaseOptions): Promise<void> {
    const deadline = new Deadline(Math.min(Math.max(0, this.releaseWithinMs), maxTimeout))
    const stuck: ResourceNeed[] = []
    for (const need of releaseOrder(this.covers)) {
      if (need.kind === 'sessions') {
        if (this.sessions !== undefined && giveBackSessions(this.sessions)) this.#released.add(need)
        continue
      }
      const free = need.kind === 'lock' ? undefined : freeSignal(whenFree, need)
      if (free === undefined) {
        this.#giveBack(need)
        continue
      }
      this.#pending.set(need, free)
      void free.then(() => this.#giveBack(need))
      if (ending) continue
      const waited = await bounded(free, deadline.remainingMs)
      if (waited.status !== 'done') stuck.push(need)
    }
    if (stuck.length > 0) this.#expire(stuck)
  }

  #giveBack(need: ResourceNeed): void {
    this.#pending.delete(need)
    if (this.#released.has(need)) return
    this.#released.add(need)
    const table = need.kind === 'lock' ? this.#locks : this.#resources
    table?.releaseOne(tableKey(need))
  }

  // Marks the lease expired, so waiters behind what it still holds start counting against their bound, and tells
  // whoever listens. A lease expires once.
  #expire(stuck: readonly ResourceNeed[]): void {
    if (this.#expiry !== undefined) return
    this.#expiry = { held: stuck, released: this.covers.filter((need) => this.#released.has(need)) }
    this.#resources?.expire()
    for (const listener of this.#expiryListeners) listener(this.#expiry)
  }
}

/** A need as a part of a lease record. */
export function leasePart(need: ResourceNeed): LeasePart {
  return { kind: need.kind, name: need.name, ...(need.apps.length === 0 ? {} : { apps: [...need.apps] }), ...(need.count === undefined ? {} : { count: need.count }) }
}

// One stage: the needs of one table, taken all at once. A stage with no needs holds nothing.
async function reserveStage(request: ResourceRequest, table: SharedLocks, needs: readonly ResourceNeed[], position: number, stopped: Promise<unknown>): Promise<{ ok: true; lease: HeldLocks | undefined } | { ok: false; stopped: boolean; failure: Failure }> {
  if (needs.length === 0) return { ok: true, lease: undefined }
  const grant: LockGrant = await table.reserve({ names: needs.map(tableKey), position, holder: request.holder, scope: request.scope }, stopped, { pastLeaseMs: request.pastLeaseMs })
  if (grant.ok) return { ok: true, lease: grant.lease }
  if (grant.reason === 'stopped') return { ok: false, stopped: true, failure: withdrawn() }
  const waitingFor = needs.filter((need) => grant.waitingFor.includes(tableKey(need)))
  return { ok: false, stopped: false, failure: exclusiveRefusal({ waitingFor, heldBy: grant.heldBy, heldElsewhere: grant.heldElsewhere, waitedMs: grant.waitedMs, pastLeaseMs: request.pastLeaseMs, variant: request.variant }) }
}

// A part's free signal. A hook that throws, or a signal that rejects, says nothing about the part, which then never
// counts as free: it waits for no signal that will come.
function freeSignal(whenFree: ReleaseOptions['whenFree'], need: ResourceNeed): Promise<void> | undefined {
  let signal: Promise<void> | undefined
  try {
    signal = whenFree(need)
  } catch {
    return new Promise<void>(() => undefined)
  }
  return signal?.catch(() => new Promise<void>(() => undefined))
}

// What a withdrawn request says until the run puts its own reason in its place.
function withdrawn(): Failure {
  return failure('interrupted', 'The run was interrupted.')
}

type Refused = { waitingFor: readonly ResourceNeed[]; heldBy: readonly string[]; heldElsewhere: number; waitedMs: number; pastLeaseMs: number; variant: Variant | undefined }

// A part that stayed held past its holder's lease, as the failure of the attempt that waited for it. Another run's
// tests are counted, never named.
function exclusiveRefusal(refused: Refused): Failure {
  const what = describeLeaseParts(refused.waitingFor.map(leasePart), refused.variant)
  const named = refused.heldBy.length === 0 ? [] : [listWords(refused.heldBy, 'and')]
  const elsewhere = refused.heldElsewhere === 0 ? [] : ['another run in this process']
  const holders = [...named, ...elsewhere].join(' and ') || 'another test'
  const message = `Not run: ${what} did not come free. ${holders} held it past the end of its lease, and the test waited ${refused.pastLeaseMs} ms more, ${refused.waitedMs} ms in all.`
  const holder = { ...(refused.heldBy.length === 0 ? {} : { heldBy: listWords(refused.heldBy, 'and') }), ...(refused.heldElsewhere === 0 ? {} : { heldElsewhere: refused.heldElsewhere }) }
  return { ...failure('setup_failed', message), details: { waitedFor: what, ...holder, waitedMs: refused.waitedMs, pastLeaseMs: refused.pastLeaseMs } }
}

function redactedPart(part: LeasePart, redact: (text: string) => string): LeasePart {
  return { ...part, name: redact(part.name) }
}

// Each need's name in its table. Locks and the machine's resources live in different tables, and a kind keeps a lock
// named like a folder from ever meeting it.
function tableKey(need: Pick<ResourceNeed, 'kind' | 'key'>): string {
  return JSON.stringify([need.kind, need.key])
}

function targetOf(source: NeedsSource, app: string): LoadedTarget | undefined {
  const name = source.targets[app]
  return name === undefined ? undefined : source.config.get(app)?.targets.get(name)
}

// The desktop is one, the Mac Retest runs on; a simulator is one device and runtime; a data folder is its real path.
function targetResource(target: LoadedTarget): { kind: 'desktop' | 'device' | 'data-folder'; name: string; key: string } | undefined {
  if ('platform' in target) {
    if (target.platform === 'macos') return { kind: 'desktop', name: 'macos', key: 'macos' }
    const name = `${target.device} (${target.runtime})`
    return { kind: 'device', name, key: name }
  }
  if (target.browser === 'electron' && target.userDataDir !== undefined) return { kind: 'data-folder', name: target.userDataDir, key: folderKey(target.userDataDir) }
  return undefined
}

// Where to read a folder's case rule: beside it, on the same volume, so the probe never touches the folder an app may be
// using; in it when it is the root of a volume of its own; and in the nearest existing folder when it does not exist.
function probeFolder(real: string, exists: boolean): string {
  if (!exists || dirname(real) === real) return real
  return statSync(dirname(real)).dev === statSync(real).dev ? dirname(real) : real
}

// The case rule of each folder a probe was written in, read once in a process.
const caseRules = new Map<string, boolean>()

// Whether the volume a folder is on ignores case: a probe file written in a temporary folder there is looked for under
// its name with the case turned over. A probe that cannot be written or read throws, rather than guess a rule that
// could put two names for one folder under two leases.
function ignoresCase(folder: string): boolean {
  const known = caseRules.get(folder)
  if (known !== undefined) return known
  const probe = mkdtempSync(join(folder, '.retest-case-'))
  try {
    writeFileSync(join(probe, 'probe'), '')
    const answer = turnedOverExists(join(probe, 'PROBE'))
    caseRules.set(folder, answer)
    return answer
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
}

function turnedOverExists(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}
