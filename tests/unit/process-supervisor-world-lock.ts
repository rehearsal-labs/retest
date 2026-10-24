// One reader or writer of a stand-in world file at a time, across processes: a run end, an end's terminations and a
// test's own changes can each start the stand-in at once, and two of them reading and writing the file together lose a
// change or read half a file.
//
// The lock is a folder beside the file holding its holder's pid, made whole under another name and renamed into place,
// so a lock never stands without its holder. A holder ended while it held the lock, as the metadata worker on Windows
// ends a run it gave up on, leaves it behind, and a waiter that finds that holder gone takes it over. Taking over is one
// waiter's at a time: it first makes the lock's breaking folder, then, holding that, reads the lock again and renames
// it away only while it is still the lock it found abandoned, so a lock a live holder made since is never taken.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { errorCode } from '../../src/shared/error-code.ts'

const pause = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
const waitLimitMs = 60_000
// A holder does its work in milliseconds. One older than this is taken over even while a process runs under its pid,
// which may since be another process's; it is far past any holder's work, and well inside the wait.
const abandonedAfterMs = 30_000
// The lock is taken, or, on Windows, was just given back and is still being removed, which refuses it a moment longer.
const busy = new Set(['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES', 'EBUSY'])
let made = 0

/**
 * Runs `work` while this process alone holds the world file `file`, and gives it back however `work` ends. With
 * `until`, a time on `Date.now()`'s clock, the lock is not tried for after it, and `work` is not run: undefined.
 * Without it, a lock not had within a minute is an error.
 */
export function withWorld<T>(file: string, work: () => T): T
export function withWorld<T>(file: string, work: () => T, until: number): T | undefined
export function withWorld<T>(file: string, work: () => T, until?: number): T | undefined {
  const lock = `${file}.lock`
  const own = `${lock}.${process.pid}-${made += 1}`
  const giveUpAt = until ?? Date.now() + waitLimitMs
  mkdirSync(own)
  writeFileSync(join(own, 'holder'), `${process.pid}`)
  try {
    for (;;) {
      // Checked before each try, so no try comes after the time it was given.
      if (Date.now() > giveUpAt) {
        if (until !== undefined) return undefined
        throw new Error(`The world file ${file} stayed locked for ${waitLimitMs} ms.`)
      }
      try {
        renameSync(own, lock)
        break
      } catch (error) {
        const code = errorCode(error)
        if (code === undefined || !busy.has(code)) throw error
        const found = abandoned(lock)
        if (found !== undefined) takeOver(lock, found)
        Atomics.wait(pause, 0, 0, 2)
      }
    }
  } finally {
    rmSync(own, { recursive: true, force: true })
  }
  try {
    return work()
  } finally {
    giveBack(lock)
  }
}

// The lock as found, by its folder and its holder, when its holder has ended or it is older than any holder's work. A
// lock whose holder cannot be read, which no holder here makes, is judged by its age alone.
function abandoned(lock: string): string | undefined {
  let found: { readonly ino: number; readonly mtimeMs: number }
  try {
    found = statSync(lock)
  } catch {
    // Given back or taken over meanwhile; the next try decides.
    return undefined
  }
  const holder = holderOf(lock)
  const old = Date.now() - found.mtimeMs > abandonedAfterMs
  return old || (holder !== undefined && !running(holder)) ? `${found.ino}:${holder ?? 'unknown'}` : undefined
}

function holderOf(lock: string): number | undefined {
  try {
    return Number(readFileSync(join(lock, 'holder'), 'utf8'))
  } catch {
    return undefined
  }
}

function takeOver(lock: string, found: string): void {
  const breaking = `${lock}.breaking`
  try {
    mkdirSync(breaking)
  } catch {
    // Another waiter is taking it over. A breaking folder older than any takeover was left by one ended as it did.
    try {
      if (Date.now() - statSync(breaking).mtimeMs > abandonedAfterMs) removeAway(breaking)
    } catch {
      // Gone meanwhile.
    }
    return
  }
  try {
    if (abandoned(lock) === found) removeAway(lock)
  } finally {
    rmSync(breaking, { recursive: true, force: true })
  }
}

/**
 * Gives back the lock on the world file `file` when this process holds it, as a holder does: renamed away first, so no
 * waiter ever finds the lock half removed, and then removed. A test that made the lock by hand as its holder frees it so.
 */
export function giveBackWorld(file: string): void {
  giveBack(`${file}.lock`)
}

// Gives back a lock this process holds; one taken over meanwhile, after this holder stalled past `abandonedAfterMs`,
// is another holder's now and stays.
function giveBack(lock: string): void {
  if (holderOf(lock) === process.pid) removeAway(lock)
}

// Renamed away first, so the lock's own name is free at once, even while Windows still removes the folder.
function removeAway(folder: string): void {
  const away = `${folder}.gone-${process.pid}-${made += 1}`
  try {
    renameSync(folder, away)
  } catch {
    return
  }
  rmSync(away, { recursive: true, force: true })
}

function running(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) === 'EPERM'
  }
}
