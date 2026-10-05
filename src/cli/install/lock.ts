import type { NativeTools } from '../../native/processes.ts'
import type { Infer } from '../../protocol/schema.ts'
import type { Machine, ProcessStart, StartReader, StartReading } from './process-start.ts'
import { createHash, randomBytes } from 'node:crypto'
import { link, lstat, mkdir, open, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { processExists, systemTools } from '../../native/processes.ts'
import { errorMessage } from '../../protocol/failures.ts'
import { parse, s } from '../../protocol/schema.ts'
import { errorCode } from '../../shared/error-code.ts'
import { entryKind, readRecordText } from '../../shared/regular-file.ts'
import { readProcessTableAsync } from '../../shared/process-ownership.ts'
import { compareStarts, readMachine, startReader } from './process-start.ts'

// One install of a build at a time on one machine, using nothing only macOS has: the file system, and the start of a
// process as /proc keeps it on Linux and `ps` prints it on macOS. The lock is a folder of generations. Generation n is
// the file `<n>.json`: a random token, the machine and pid namespace, the pid and the start of the process that holds
// it, when it took it, and how it was started. `<n>.<token>.released` says that holder let go. A taker reads the
// newest generation, and makes the next one only when that one was let go or a fresh whole table confirms its pid
// absent from this machine; it does so by linking a finished
// file under that name, which fails rather than replaces, so of every taker that tries, exactly one makes it. Any other
// reading of the holder, a start that proves nothing, or one that cannot be read, keeps the lock where it is. Installs
// from machines or containers sharing a cache are not coordinated: a generation of another one is refused, never
// judged.
//
// A taker holds the lock only once its generation is still the newest after it was made, so one made under a number a
// slow taker read long ago steps back. Only generations older than the one before the newest are removed, by the taker
// that just made the newest, and never one a holder or a taker still reads: a holder's release checks its token first,
// and a taker that finds the newest gone reads the folder again.

/** A held install lock, or why it could not be taken, and whether that was because the install was stopped. */
export type InstallLock = HeldLock | { readonly ok: false; readonly message: string; readonly stopped?: true }

/** A held install lock. `release` resolves with a problem when the lock was not let go. */
type HeldLock = { readonly ok: true; release(): Promise<string | undefined> }

/** What taking the lock may be given: the tools `ps` comes from, the install's signal, and, for tests, the platform and start reader. */
export type InstallLockOptions = {
  readonly tools?: NativeTools | undefined
  readonly signal?: AbortSignal | undefined
  readonly platform?: NodeJS.Platform
  readonly readStart?: StartReader
}

/** Version 2 names its start clock: UTC0 seconds or Linux boot ticks. Legacy clocks cannot confirm a present holder. */
export type Generation = {
  readonly version: 2
  readonly token: string
  readonly machine: string
  readonly host: string
  readonly pid: number
  readonly start: ProcessStart
  readonly since: string
  readonly command: string
}

const generationSchema = s.object({
  version: s.literal(2),
  token: s.string(),
  machine: s.string(),
  host: s.string(),
  pid: s.number({ integer: true, min: 1 }),
  start: s.object({ clock: s.enum(['boot-ticks', 'utc-seconds']), value: s.number({ integer: true, min: 0 }) }),
  since: s.string(),
  command: s.string(),
})

// Legacy local generations predate the explicit clock and may predate machine tags. Never compare their start.
const legacyGenerationSchema = s.object({
  version: s.literal(1), token: s.optional(s.string()), machine: s.optional(s.string()), host: s.optional(s.string()),
  pid: s.number({ integer: true, min: 1 }), start: s.optional(s.union([s.string(), s.number({ integer: true, min: 0 })])),
  startedAt: s.optional(s.string()), since: s.optional(s.string()), command: s.string(),
})

/** How many generations a taker tries to make in a row while each it tries is made by another first. */
const attempts = 8

type Refusal = { readonly ok: false; readonly message: string; readonly stopped?: true }

/**
 * Takes the lock that keeps two installs of one build apart on this machine, without waiting for a holder. A lock
 * another live process holds refuses, naming the lock and that process; one this process already holds says so; one
 * held from another machine or container is refused, never taken. The lock lasts until `release`, and a holder that
 * ends without it is passed over by the next taker. Nothing is thrown: a folder that cannot be read is a refusal.
 *
 * @example const lock = await takeInstallLock('/…/retest/locks/electron-44.5.1-mac-arm64.lock', { signal })
 */
export async function takeInstallLock(path: string, options: InstallLockOptions = {}): Promise<InstallLock> {
  const { signal } = options
  const stopped = (): Refusal => ({ ok: false, message: `The install was stopped while it took the install lock ${path}.`, stopped: true })
  if (stoppedBy(signal)) return stopped()
  const platform = options.platform ?? process.platform
  const readStart = options.readStart ?? startReader({ platform, tools: options.tools ?? systemTools, signal })
  const folder = await lockFolder(path)
  if (folder !== undefined) return { ok: false, message: folder }
  const machine = await readMachine({ platform, signal })
  if (stoppedBy(signal)) return stopped()
  if (!machine.ok) return { ok: false, message: `${machine.problem} The install lock ${path} records which machine holds it, so Retest installs nothing without it.` }
  const own = await readStart(process.pid)
  if (stoppedBy(signal)) return stopped()
  if (own.state !== 'present') return { ok: false, message: `Retest could not read when this process started (${own.state === 'unreadable' ? own.problem : 'it is not listed'}). The install lock ${path} names its holder by its start, so Retest installs nothing without it.` }
  const context: Context = { path, machine: machine.machine, tag: machineTag(machine.machine), ownStart: own.start, readStart }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (stoppedBy(signal)) return stopped()
    const outcome = await tryOnce(context)
    if (stoppedBy(signal)) {
      if (outcome.kind === 'held') await outcome.lock.release()
      return stopped()
    }
    if (outcome.kind === 'held') return outcome.lock
    if (outcome.kind === 'refused') return { ok: false, message: outcome.message }
  }
  return { ok: false, message: `Other processes kept taking the install lock ${path} before this one could, ${attempts} times. Run the install again.` }
}

// Read through a call, since a signal can be aborted across any await in between.
function stoppedBy(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

type Context = { readonly path: string; readonly machine: Machine; readonly tag: string; readonly ownStart: ProcessStart; readonly readStart: StartReader }

type Outcome = { readonly kind: 'held'; readonly lock: HeldLock } | { readonly kind: 'refused'; readonly message: string } | { readonly kind: 'again' }

// One reading of the folder and, when the newest generation is free, one try at the next.
async function tryOnce(context: Context): Promise<Outcome> {
  const { path } = context
  const listed = await listGenerations(context)
  if (!listed.ok) return { kind: 'refused', message: listed.message }
  const newest = listed.newest
  if (newest > 0) {
    const reading = await readGeneration(path, newest)
    if (reading.kind === 'missing') return { kind: 'again' }
    if (reading.kind === 'unreadable') return { kind: 'refused', message: describeBlocker(path, newest, { kind: 'unreadable', problem: reading.problem }) }
    if (reading.kind === 'legacy') {
      const file = join(path, `${newest}.json`)
      const legacy = reading.generation
      if (legacy.machine !== undefined && legacy.machine !== context.machine.id) return { kind: 'refused', message: `The install generation ${file} belongs to another machine or boot namespace, whose process table this machine cannot confirm. Remove ${file} once no install of this build is running there.` }
      try {
        if ((await readProcessTableAsync()).some(entry => entry.pid === legacy.pid)) return { kind: 'refused', message: `Retest cannot confirm the recorded start time zone in the install generation ${file}; pid ${legacy.pid} is present. Remove ${file} once no install of this build is running.` }
      } catch (error) {
        return { kind: 'refused', message: `Retest cannot confirm absence for install generation ${file}: ${errorMessage(error)}. Remove ${file} once no install of this build is running.` }
      }
    } else {
      const generation = reading.generation
      const released = await isReleased(path, newest, generation.token)
      let absent = false
      if (!released && generation.machine === context.machine.id) {
        try { absent = !(await readProcessTableAsync()).some(entry => entry.pid === generation.pid) }
        catch (error) { return { kind: 'refused', message: `Retest could not read the whole process table for install generation ${join(path, `${newest}.json`)}: ${errorMessage(error)}.` } }
      }
      const needsReading = !released && !absent && generation.machine === context.machine.id && generation.pid !== process.pid
      let current: StartReading | undefined = absent ? { state: 'absent' } : needsReading ? await context.readStart(generation.pid) : undefined
      if (!absent && current?.state === 'absent') {
        try {
          if ((await readProcessTableAsync()).some(entry => entry.pid === generation.pid)) current = { state: 'unreadable', problem: 'the pid remains present in the whole table despite the individual reading' }
        } catch (error) { current = { state: 'unreadable', problem: errorMessage(error) } }
      }
      const decision = decideGeneration(generation, { machine: context.machine.id, ownPid: process.pid, ownStart: context.ownStart, released, current })
      if (decision !== 'free') return { kind: 'refused', message: describeBlocker(path, newest, decision) }
    }
  }
  const made = await makeGeneration(context, newest + 1)
  if (made.kind !== 'made') return made.kind === 'taken' ? { kind: 'again' } : { kind: 'refused', message: made.message }
  // A number read long ago may have been made again after the generations past it were removed: only a generation
  // that is still the newest holds the lock.
  const after = await listGenerations(context)
  if (!after.ok || after.newest !== newest + 1) {
    await release(path, newest + 1, made.token)
    return after.ok ? { kind: 'again' } : { kind: 'refused', message: after.message }
  }
  await removeOldGenerations(path, newest + 1)
  return { kind: 'held', lock: heldLock(path, newest + 1, made.token) }
}

/** Why the newest generation keeps a taker out. */
export type Blocker =
  | { readonly kind: 'self'; readonly generation: Generation }
  | { readonly kind: 'running'; readonly generation: Generation }
  | { readonly kind: 'foreign'; readonly generation: Generation }
  | { readonly kind: 'unsure'; readonly generation: Generation }
  | { readonly kind: 'unknown'; readonly generation: Generation; readonly problem: string }
  | { readonly kind: 'unreadable'; readonly problem: string }

/**
 * Whether a generation leaves the lock free, as a taker on `machine` reads it: let go; or held by this machine's
 * process whose pid is absent from a fresh whole table. A start mismatch alone never frees it. A generation of another
 * machine or container is never judged, a start that proves nothing either way keeps it, and so does one that cannot
 * be read. `current` is the start of the holder's pid read now, for a holder on this machine other than this process.
 *
 * @example decideGeneration(generation, { machine, ownPid: 4242, ownStart, released: false, current: { state: 'absent' } }) // 'free'
 */
export function decideGeneration(generation: Generation, context: { readonly machine: string; readonly ownPid: number; readonly ownStart: ProcessStart; readonly released: boolean; readonly current: StartReading | undefined }): Blocker | 'free' {
  if (context.released) return 'free'
  if (generation.machine !== context.machine) return { kind: 'foreign', generation }
  if (generation.pid === context.ownPid) {
    const own = compareStarts(generation.start, context.ownStart)
    if (own === 'same') return { kind: 'self', generation }
    return { kind: 'unsure', generation }
  }
  const { current } = context
  if (current === undefined || current.state === 'unreadable') return { kind: 'unknown', generation, problem: current?.problem ?? 'its start was not read' }
  if (current.state === 'absent') return 'free'
  const compared = compareStarts(generation.start, current.start)
  if (compared === 'same') return { kind: 'running', generation }
  return { kind: 'unsure', generation }
}

function describeBlocker(path: string, number: number, blocker: Blocker): string {
  const after = 'Wait for it to finish, then run the install again.'
  if (blocker.kind === 'unreadable') return `The install lock ${path} is held by ${join(path, `${number}.json`)}, which names no holder Retest can read (${blocker.problem}), so Retest leaves it alone. Once no install of this build runs, remove the folder, then run the install again.`
  const { generation } = blocker
  if (blocker.kind === 'self') return `This process already holds the install lock ${path}, since ${generation.since}: an install of this build it started has not finished. ${after}`
  if (blocker.kind === 'running') return `Another Retest process (pid ${generation.pid}, started as ${JSON.stringify(generation.command.slice(0, 300))}, since ${generation.since}) holds the install lock ${path} and is installing this build. ${after}`
  if (blocker.kind === 'foreign') return `The install lock ${path} is held from another machine or container (${generation.host}, pid ${generation.pid}, since ${generation.since}), whose processes Retest cannot see, so it leaves that lock alone. Retest keeps one install at a time on one machine, and does not coordinate a cache shared between machines or containers: give each its own cache, through HOME, or XDG_CACHE_HOME on Linux, or remove the folder once no install runs there.`
  if (blocker.kind === 'unsure') return `The process now under pid ${generation.pid}, which has held the install lock ${path} since ${generation.since}, has a different start, which cannot prove absence. Remove ${join(path, `${number}.json`)} once no install of this build is running.`
  return `Retest could not read whether the process holding the install lock ${path} (pid ${generation.pid}, since ${generation.since}) still runs (${blocker.problem}), so it leaves that lock alone. Run the install again once that process has ended.`
}

// The lock's folder, made when missing. Anything else at its path is not a lock Retest keeps, and is left alone.
async function lockFolder(path: string): Promise<string | undefined> {
  const made = await mkdir(path, { recursive: true }).then(() => undefined, (error: unknown) => error)
  const stats = await lstat(path).catch(() => undefined)
  if (stats?.isDirectory() === true) return undefined
  if (stats !== undefined) return `${path}, where the install lock is kept, is ${entryKind(stats)}, not a folder. Remove it once no install of this build runs, then run the install again.`
  return `Retest could not make the install lock ${path}: ${errorMessage(made ?? new Error('it was not there once made'))}.`
}

// The newest generation in the folder, or 0 when there is none yet. Hidden files this machine's gone writers left are
// removed; another machine's are left alone, since its pids mean nothing here.
async function listGenerations(context: Context): Promise<{ readonly ok: true; readonly newest: number } | { readonly ok: false; readonly message: string }> {
  const { path } = context
  let names: string[]
  try {
    names = await readdir(path)
  } catch (error) {
    return { ok: false, message: `Retest could not read the install lock ${path}: ${errorMessage(error)}.` }
  }
  let newest = 0
  for (const name of names) {
    const generation = /^(\d+)\.json$/.exec(name)?.[1]
    if (generation !== undefined) {
      newest = Math.max(newest, Number(generation))
      continue
    }
    const temporary = /^\.([0-9a-f]{12})-(\d+)-[0-9a-f]+\.tmp$/.exec(name)
    if (temporary === null || temporary[1] !== context.tag || mayStillRun(Number(temporary[2]))) continue
    try {
      await rm(join(path, name), { force: true })
    } catch (error) {
      return { ok: false, message: `Retest could not remove ${name}, which a gone install left in the install lock ${path}: ${errorMessage(error)}.` }
    }
  }
  return { ok: true, newest }
}

async function readGeneration(path: string, number: number): Promise<{ readonly kind: 'found'; readonly generation: Generation } | { readonly kind: 'legacy'; readonly generation: Infer<typeof legacyGenerationSchema> } | { readonly kind: 'missing' } | { readonly kind: 'unreadable'; readonly problem: string }> {
  const reading = await readRecordText(join(path, `${number}.json`))
  if (reading.kind !== 'text') return reading
  let value: unknown
  try {
    value = JSON.parse(reading.text)
  } catch (error) {
    return { kind: 'unreadable', problem: errorMessage(error) }
  }
  const parsed = parse(generationSchema, value)
  if (parsed.ok) return { kind: 'found', generation: parsed.value }
  const legacy = parse(legacyGenerationSchema, value)
  if (legacy.ok && (legacy.value.start !== undefined || legacy.value.startedAt !== undefined)) return { kind: 'legacy', generation: legacy.value }
  return { kind: 'unreadable', problem: 'it does not name a holder as this version of Retest writes one' }
}

function releasedName(number: number, token: string): string {
  return `${number}.${token}.released`
}

async function isReleased(path: string, number: number, token: string): Promise<boolean> {
  return lstat(join(path, releasedName(number, token))).then(() => true, () => false)
}

// A generation is made whole and on disk: written under a hidden name and flushed, then linked under its own, which
// fails rather than replaces when another taker made that generation first, and the folder flushed after the link.
async function makeGeneration(context: Context, number: number): Promise<{ readonly kind: 'made'; readonly token: string } | { readonly kind: 'taken' } | { readonly kind: 'failed'; readonly message: string }> {
  const { path } = context
  const token = randomBytes(16).toString('hex')
  const generation: Generation = { version: 2, token, machine: context.machine.id, host: context.machine.host, pid: process.pid, start: context.ownStart, since: new Date().toISOString(), command: holderCommand() }
  const temporary = join(path, `.${context.tag}-${process.pid}-${randomBytes(8).toString('hex')}.tmp`)
  try {
    await writeDurably(temporary, `${JSON.stringify(generation)}\n`)
    await link(temporary, join(path, `${number}.json`))
    await syncFolder(path)
    return { kind: 'made', token }
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return { kind: 'taken' }
    return { kind: 'failed', message: `Retest could not take the install lock ${path}: ${errorMessage(error)}.` }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function heldLock(path: string, number: number, token: string): HeldLock {
  let releasing: Promise<string | undefined> | undefined
  return { ok: true, release: () => (releasing ??= release(path, number, token)) }
}

// Lets go of generation `number` only while it is still this holder's, by its token: a folder removed and made again
// meanwhile holds another process's generation under that number, which this release must not free.
async function release(path: string, number: number, token: string): Promise<string | undefined> {
  const reading = await readGeneration(path, number)
  if (reading.kind !== 'found' || reading.generation.token !== token) return `The install lock ${path} no longer holds this process's generation ${number}, so nothing there was let go.`
  try {
    await writeDurably(join(path, releasedName(number, token)), `${token}\n`)
    await syncFolder(path)
    return undefined
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return undefined
    return `The install lock ${path} was not let go: ${errorMessage(error)}. The next install passes it over once this process has ended.`
  }
}

// Keeps the newest generation and the one before it, which a taker may still be reading, and removes the rest. A file
// that cannot be removed stays; it holds nobody, since a generation older than the one before the newest was passed.
async function removeOldGenerations(path: string, newest: number): Promise<void> {
  const names = await readdir(path).catch(() => [])
  for (const name of names) {
    const number = /^(\d+)\./.exec(name)?.[1]
    if (number !== undefined && Number(number) < newest - 1) await rm(join(path, name), { force: true }).catch(() => undefined)
  }
}

async function writeDurably(path: string, text: string): Promise<void> {
  const handle = await open(path, 'wx')
  try {
    await handle.writeFile(text)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

// A link or a new file is on disk only once the folder that names it is; a file system that cannot flush a folder
// still has the file, so that is not a reason to refuse.
async function syncFolder(path: string): Promise<void> {
  const handle = await open(path, 'r').catch(() => undefined)
  if (handle === undefined) return
  try {
    await handle.sync().catch(() => undefined)
  } finally {
    await handle.close()
  }
}

// A short name for this machine in the hidden files it writes, so it removes only its own gone writers' files.
function machineTag(machine: Machine): string {
  return createHash('sha256').update(machine.id).digest('hex').slice(0, 12)
}

// Whether the process a hidden file is named after may still be writing it; a pid no process can have is nobody's, and
// a question the system cannot answer leaves the file where it is.
function mayStillRun(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2 ** 31 - 1) return false
  try {
    return processExists(pid)
  } catch {
    return true
  }
}

// How this process was started: its program and entry script, never the arguments after them, which can carry a value
// that must not reach a file.
function holderCommand(): string {
  return [process.execPath, process.argv[1]].filter((part) => part !== undefined && part.length > 0).join(' ')
}
