import type { Dirent } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { errorMessage } from '../protocol/failures.ts'
import { errorCode } from '../shared/error-code.ts'

const ownedProfile = /^retest-profile-(\d+)-[A-Za-z0-9]+$/

/**
 * How the temporary profile folders of a process begin, so a later run can tell whose each one was.
 *
 * @example profilePrefix(4242) // 'retest-profile-4242-'
 */
export function profilePrefix(pid: number): string {
  return `retest-profile-${pid}-`
}

/**
 * Removes the Retest profile folders in `folder` whose owning process no longer exists, as a run that was
 * killed outright leaves them. A profile whose owner is alive, or may be, is kept. Resolves with what could
 * not be removed.
 *
 * @example const problems = await removeStaleProfiles(tmpdir())
 */
export async function removeStaleProfiles(folder: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(folder, { withFileTypes: true })
  } catch (error) {
    return [`Could not look for stale browser profiles in ${folder}: ${errorMessage(error)}`]
  }
  const stale = entries.filter((entry) => entry.isDirectory() && ownerIsGone(entry.name))
  const problems: string[] = []
  for (const entry of stale) {
    const path = join(folder, entry.name)
    await rm(path, { recursive: true, force: true, maxRetries: 3 }).catch((error: unknown) => {
      problems.push(`Could not remove the stale browser profile ${path}: ${errorMessage(error)}`)
    })
  }
  return problems
}

// Signal 0 only asks whether a process exists. EPERM means it does, and belongs to someone else.
function ownerIsGone(name: string): boolean {
  const pid = Number(ownedProfile.exec(name)?.[1])
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return errorCode(error) === 'ESRCH'
  }
}
