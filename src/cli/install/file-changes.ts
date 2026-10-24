import { randomUUID } from 'node:crypto'
import { lstat, open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { errorMessage } from '../../protocol/failures.ts'
import { Deadline } from '../../protocol/deadline.ts'
import { errorCode } from '../../shared/error-code.ts'

// The renames and removals an install makes in the cache. Windows refuses to rename or remove a file another program
// holds open, which a virus scanner does for a moment with each file an unpack has just written, so there such a
// refusal is tried again for a while. Each change settles as done or as one clause saying why not, and is never
// thrown: a removal that fails after the build was placed must not undo the install, and one that fails while the
// install is already refusing must not hide the refusal.

/** What a change is told: the platform, the install's signal, and how long Windows is given to let go of a file. */
export type ChangeOptions = { readonly platform: NodeJS.Platform; readonly signal?: AbortSignal | undefined; readonly waitMs?: number }

/** How a change ended: done, or why not, as a clause with no full stop, and whether it ended because of a stop. */
export type Settled = { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly stopped: boolean }

/** How long Windows is given to let go of a file, as a virus scanner holds each file an unpack has just written. */
const defaultWaitMs = 10_000

/**
 * One rename or removal: what it does, the folder it changes, whose permission says whether this user may make it, and
 * for a rename the path it makes, which must not exist yet.
 */
export type FileChange = { readonly run: () => Promise<void>; readonly folder: string; readonly target?: string }

/**
 * Removes a file or a folder and everything in it, if it is there.
 *
 * @example await removePath('/…/browsers/downloads/electron.zip', { platform: process.platform, signal })
 */
export function removePath(path: string, options: ChangeOptions): Promise<Settled> {
  return settleChange({ run: () => rm(path, { recursive: true, force: true }), folder: dirname(path) }, options)
}

/**
 * Renames `from` to `to`, which must not exist yet.
 *
 * @example await renamePath(staging, folder, { platform: process.platform, signal })
 */
export function renamePath(from: string, to: string, options: ChangeOptions): Promise<Settled> {
  return settleChange({ run: () => rename(from, to), folder: dirname(to), target: to }, options)
}

// Windows gives EBUSY for a file another program holds open, and EPERM or EACCES both for that and for a folder this
// user may not change; a folder that refuses a new file of Retest's tells the second apart, and is not waited on.
const inUseCodes: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'EACCES'])
const deniedCodes: ReadonlySet<string> = new Set(['EPERM', 'EACCES'])

/**
 * Makes one change and says how it ended, without throwing. On Windows a refusal while a program holds a file open is
 * tried again until it is let go, `waitMs` passes or the signal stops it; a rename onto a path that exists, and a
 * folder this user may not change, are said at once. Elsewhere, and for any other error, the change is tried once.
 *
 * @example await settleChange({ run: () => rm(path, { force: true }), folder: dirname(path) }, { platform: 'win32', signal })
 */
export async function settleChange(change: FileChange, options: ChangeOptions): Promise<Settled> {
  const deadline = new Deadline(options.waitMs ?? defaultWaitMs)
  let writable: boolean | undefined
  for (;;) {
    let failure: unknown
    try {
      await change.run()
      return { ok: true }
    } catch (error) {
      failure = error
    }
    const code = errorCode(failure) ?? ''
    if (options.platform !== 'win32' || !inUseCodes.has(code)) return { ok: false, reason: errorMessage(failure), stopped: false }
    if (change.target !== undefined && (await exists(change.target))) return { ok: false, reason: `${change.target} already exists`, stopped: false }
    if (code !== 'EBUSY') writable ??= await canWriteIn(change.folder)
    if (writable === false) return { ok: false, reason: `Windows does not let this user change ${change.folder} (${code})`, stopped: false }
    if (options.signal?.aborted === true) return { ok: false, reason: `the install was stopped while a program held a file in it open (${code})`, stopped: true }
    if (deadline.reached) return { ok: false, reason: `a program still held a file in it open after ${Number((deadline.budgetMs / 1000).toFixed(1))} s (${code})`, stopped: false }
    await sleep(Math.min(250, deadline.waitToEndMs), undefined, options.signal === undefined ? {} : { signal: options.signal }).catch(() => undefined)
  }
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false)
}

// Whether this user may make a file in `folder`, by making one there and removing it again. Only a refusal of that file
// says no; a folder that cannot be tried for another reason is waited on as one a program holds.
async function canWriteIn(folder: string): Promise<boolean> {
  const probe = join(folder, `.retest-write-${process.pid}-${randomUUID()}`)
  try {
    const handle = await open(probe, 'wx')
    await handle.close()
  } catch (error) {
    return !deniedCodes.has(errorCode(error) ?? '')
  }
  await rm(probe, { force: true }).catch(() => undefined)
  return true
}
