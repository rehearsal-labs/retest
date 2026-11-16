import { rmSync } from 'node:fs'
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { errorMessage } from '../protocol/failures.ts'

const ownershipFile = '.retest-profile-owner.json'
// The profiles this process made that no process has been started on yet. Nothing runs in them, so the process removes
// them as it exits, however it exits, as when a second Ctrl+C lands while a launch opens its log; the process started
// on one takes it over with an exit hook of its own, which removes it once that process is shown gone.
const unstarted = new Set<string>()
let removedAtExit = false

/**
 * Creates an exclusive temporary profile and records its owner before any app can use it. Until `profileStarted` hands
 * it to the process started on it, this process removes it as it exits.
 */
export async function createTemporaryProfile(folder: string, pid: number = process.pid): Promise<string> {
  const root = await realpath(folder)
  const path = await mkdtemp(join(root, profilePrefix(pid)))
  removeAtExit(path)
  try {
    await writeFile(join(path, ownershipFile), JSON.stringify({ version: 1, pid, path }), { flag: 'wx', mode: 0o600 })
    return path
  } catch (error) {
    await discardProfile(path)
    throw error
  }
}

/** Hands a temporary profile to the process just started on it, whose own exit hook removes it from now on. */
export function profileStarted(path: string): void {
  unstarted.delete(path)
}

/** Removes a temporary profile no process was started on. */
export async function discardProfile(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 3 })
  unstarted.delete(path)
}

function removeAtExit(path: string): void {
  unstarted.add(path)
  if (removedAtExit) return
  removedAtExit = true
  process.on('exit', () => {
    for (const unused of unstarted) {
      try {
        rmSync(unused, { recursive: true, force: true, maxRetries: 3 })
      } catch {
        // Throwing here would replace the exit code Retest chose, and skip the profiles after this one.
      }
    }
  })
}

/**
 * How the temporary profile folders of a process begin, so a later run can tell whose each one was.
 *
 * @example profilePrefix(4242) // 'retest-profile-4242-'
 */
export function profilePrefix(pid: number): string {
  return `retest-profile-${pid}-`
}

/**
 * Checks the folder where earlier launches left profiles, retaining every entry. A dead creator and a marker
 * cannot prove a folder is still disposable: a later app may use it as persistent storage. Only a launch's own
 * process record permits removing its temporary profile once its processes are confirmed gone.
 *
 * @example const problems = await removeStaleProfiles(tmpdir())
 */
export async function removeStaleProfiles(folder: string): Promise<string[]> {
  try {
    await readdir(folder)
  } catch (error) {
    return [`Could not look for stale browser profiles in ${folder}: ${errorMessage(error)}`]
  }
  return []
}
