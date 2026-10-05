import type { Dirent } from 'node:fs'
import type { OwnedProcessIdentity } from '../../shared/process-ownership.ts'
import type { OwnerRecord } from './profile.ts'
import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Deadline } from '../../protocol/deadline.ts'
import { errorMessage } from '../../protocol/failures.ts'
import { errorCode } from '../../shared/error-code.ts'
import { sameProcessIdentity } from '../../shared/process-ownership.ts'
import { firefoxFolderPrefix, ownerRecordFile, readOwnerRecord } from './profile.ts'
import { isRunning, readProcessIdentityAsync, readProcessTableAsync } from './process-table.ts'

/**
 * What a sweep did: the Firefoxes of launchers that are gone it ended, by process id, the folders of such launches it
 * removed, what it left alone and why, and what it could not do.
 */
export type SweepReport = { ended: number[]; removed: string[]; kept: string[]; problems: string[] }

/** How the sweep reads processes and ends one; the host's own unless a test gives another. */
export type SweepSystem = {
  read(deadline?: Deadline): readonly OwnedProcessIdentity[] | Promise<readonly OwnedProcessIdentity[]>
  readProcess?(pid: number, deadline?: Deadline): OwnedProcessIdentity | undefined | Promise<OwnedProcessIdentity | undefined>
  kill(pid: number): void
}

const ownedFolder = new RegExp(`^${firefoxFolderPrefix}(\\d+)-[A-Za-z0-9]+$`)
const killGraceMs = 2000
const pollMs = 20

const host: SweepSystem = {
  read: readProcessTableAsync,
  readProcess: readProcessIdentityAsync,
  kill: (pid) => {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      if (errorCode(error) !== 'ESRCH') throw error
    }
  },
}

/**
 * Ends the Firefoxes, and removes the folders, that launches whose launching process is gone left in `root`. Chromium
 * exits when the pipe from the process that started it closes; Firefox's Remote Agent is a WebSocket, so a launcher
 * killed outright leaves its Firefox running, its profile in place and its one BiDi session taken for good.
 *
 * Only what a launch recorded is ended: a folder's owner record names the launching process and the Firefox, each by
 * pid, start time and command line. A Firefox is ended only when the launcher's pid is absent from a whole table
 * and a process still has exactly the Firefox's recorded identity, checked again right before the signal; then
 * the processes it started, read as its children in its own process group, follow. A folder with no record, an owner
 * still alive, a Firefox whose identity no longer matches or one that would not end is left as it is, and named.
 *
 * @example const { ended, removed, kept, problems } = await sweepOrphanedFirefoxes(tmpdir())
 */
export async function sweepOrphanedFirefoxes(root: string, system: SweepSystem = host): Promise<SweepReport> {
  const report: SweepReport = { ended: [], removed: [], kept: [], problems: [] }
  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    report.problems.push(`Could not look for Firefox folders that earlier launches left in ${root}: ${errorMessage(error)}`)
    return report
  }
  const folders = entries.filter((entry) => entry.isDirectory() && ownedFolder.test(entry.name)).map((entry) => join(root, entry.name))
  if (folders.length === 0) return report
  let table: readonly OwnedProcessIdentity[]
  try {
    table = await system.read()
  } catch (error) {
    report.problems.push(`Could not read the process table, so no Firefox folder was swept: ${errorMessage(error)}`)
    return report
  }
  for (const folder of folders) await sweepFolder(folder, table, system, report)
  return report
}

async function sweepFolder(folder: string, table: readonly OwnedProcessIdentity[], system: SweepSystem, report: SweepReport): Promise<void> {
  const record = await readOwnerRecord(folder)
  const ownerPid = Number(ownedFolder.exec(folder.slice(folder.lastIndexOf('/') + 1))?.[1])
  if (record === undefined) {
    try {
      await lstat(join(folder, 'retest-owner.json'))
      report.kept.push(`${folder}: cannot confirm its ownership record, so the folder and processes were left alone.`)
      return
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        report.kept.push(`${folder}: cannot confirm its ownership record: ${errorMessage(error)}; the folder and processes were left alone.`)
        return
      }
    }
    // A launch that died before it recorded its Firefox: the folder goes only once nothing uses its profile and its
    // launcher is gone, and a Firefox still using it is left, since nothing recorded which process it is.
    const ownerAlive = table.some((entry) => entry.pid === ownerPid && isRunning(entry))
    const inUse = table.some((entry) => isRunning(entry) && entry.command.includes(join(folder, 'profile')))
    if (ownerAlive) return
    if (inUse) {
      report.kept.push(`${folder}: a process uses its profile, and no record names it, so it was left alone.`)
      return
    }
    await remove(folder, report)
    return
  }
  if (record.startTimeVersion !== 1) {
    if (record.owner.pid === ownerPid && !table.some(entry => entry.pid === record.owner.pid || entry.pid === record.firefox.pid || entry.command.includes(join(folder, 'profile')))) {
      await remove(folder, report)
      return
    }
    const file = join(folder, ownerRecordFile)
    report.kept.push(`${folder}: cannot confirm the recorded start time zone in ${file}; the folder and processes were left alone. Remove ${file} once no runner is running.`)
    return
  }
  if (record.owner.pid !== ownerPid || sameBirth(table, record.owner)) return
  if (table.some(entry => entry.pid === record.owner.pid)) {
    report.kept.push(`${folder}: its launcher pid is present with a different start, which cannot prove absence. Remove ${join(folder, ownerRecordFile)} once no runner is running.`)
    return
  }
  const firefox = table.find((entry) => entry.pid === record.firefox.pid && isRunning(entry))
  if (firefox !== undefined && !sameIdentity(firefox, record.firefox)) {
    report.kept.push(`${folder}: process ${record.firefox.pid} is no longer the Firefox its launch recorded, so it was left alone.`)
    return
  }
  if (firefox !== undefined) {
    const ended = await endRecorded(record, system)
    if (ended !== undefined) {
      report.problems.push(ended)
      report.kept.push(`${folder}: its Firefox did not end.`)
      return
    }
    report.ended.push(record.firefox.pid)
  }
  await remove(folder, report)
}

// The Firefox is signalled only after one more look shows the same identity; its children are the processes in its
// group that name it as their parent and started no earlier than it.
async function endRecorded(record: OwnerRecord, system: SweepSystem): Promise<string | undefined> {
  const pid = record.firefox.pid
  const deadline = new Deadline(killGraceMs)
  let table: readonly OwnedProcessIdentity[]
  try {
    table = await system.read(deadline)
  } catch (error) {
    return `Could not check Firefox ${pid} again before ending it: ${errorMessage(error)}`
  }
  const current = table.find((entry) => entry.pid === pid && isRunning(entry))
  if (deadline.reached) return `Could not verify Firefox ${pid}'s recorded processes before the cleanup deadline; they were left alone.`
  if (current === undefined) return undefined
  if (!sameIdentity(current, record.firefox)) return `Process ${pid} changed identity before it could be ended, so it was left alone.`
  const children = table.filter((entry) => isRunning(entry) && entry.parentPid === pid && entry.groupId === pid)
  try {
    for (const candidate of [...children, current]) {
      const fresh = system.readProcess === undefined
        ? (await system.read(deadline)).find((entry) => entry.pid === candidate.pid)
        : await system.readProcess(candidate.pid, deadline)
      if (deadline.reached) return `Could not verify Firefox ${pid}'s recorded processes before the cleanup deadline; they were left alone.`
      if (fresh === undefined || !isRunning(fresh)) continue
      if (!sameProcessIdentity(candidate, fresh)) return `Process ${candidate.pid} changed identity before it could be ended, so it was left alone.`
      if (deadline.reached) return `Could not verify Firefox ${pid}'s recorded processes before the cleanup deadline; they were left alone.`
      system.kill(candidate.pid)
    }
  } catch (error) {
    return `Could not end Firefox ${pid}: ${errorMessage(error)}`
  }
  const watched = new Map([current, ...children].map((entry) => [entry.pid, entry]))
  for (;;) {
    let remaining: OwnedProcessIdentity[]
    try {
      remaining = (await system.read(deadline)).filter((entry) => isRunning(entry) && watched.has(entry.pid))
    } catch (error) {
      return `Could not see whether Firefox ${pid} ended: ${errorMessage(error)}`
    }
    if (deadline.reached) return `Firefox ${pid} cleanup could not be confirmed before its deadline.`
    if (remaining.length === 0) return undefined
    if (deadline.expired) return `Firefox ${pid} and the processes it started were still there ${killGraceMs} ms after SIGKILL: ${remaining.map((entry) => entry.pid).join(', ')}.`
    await sleep(Math.min(pollMs, deadline.remainingMs))
  }
}

async function remove(folder: string, report: SweepReport): Promise<void> {
  try {
    await rm(folder, { recursive: true, force: true, maxRetries: 3 })
    report.removed.push(folder)
  } catch (error) {
    report.problems.push(`Could not remove the Firefox folder ${folder}: ${errorMessage(error)}`)
  }
}

// The launcher is alive when a process has its pid and the same start time; a pid that came back for another process
// is not the launcher.
function sameBirth(table: readonly OwnedProcessIdentity[], owner: { pid: number; startedAt: string }): boolean {
  return table.some((entry) => entry.pid === owner.pid && entry.startedAt === owner.startedAt && isRunning(entry))
}

// The recorded Firefox, by the rule every owned process is read by: a command line `ps` could not read, as while the
// process exits, is no difference.
function sameIdentity(entry: OwnedProcessIdentity, recorded: { pid: number; startedAt: string; command: string }): boolean {
  return sameProcessIdentity({ ...entry, pid: recorded.pid, startedAt: recorded.startedAt, command: recorded.command }, entry)
}
