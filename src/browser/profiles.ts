import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { errorMessage } from '../protocol/failures.ts'

const ownershipFile = '.retest-profile-owner.json'

/** Creates an exclusive temporary profile and records its owner before any app can use it. */
export async function createTemporaryProfile(folder: string, pid: number = process.pid): Promise<string> {
  const root = await realpath(folder)
  const path = await mkdtemp(join(root, profilePrefix(pid)))
  try {
    await writeFile(join(path, ownershipFile), JSON.stringify({ version: 1, pid, path }), { flag: 'wx', mode: 0o600 })
    return path
  } catch (error) {
    await rm(path, { recursive: true, force: true })
    throw error
  }
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
