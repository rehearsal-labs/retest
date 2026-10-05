import type { OwnedProcessIdentity, ProcessOwnershipSystem } from '../../shared/process-ownership.ts'
import type { WebKitHomeRecord } from './process.ts'
import { readdir, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { errorMessage } from '../../protocol/failures.ts'
import { parse, s } from '../../protocol/schema.ts'
import { OwnedProcessGroup, readProcessTableAsync, sameProcessIdentity } from '../../shared/process-ownership.ts'
import { homeRecordFile, processStartedAt, unknownStartedAt } from './process.ts'

/**
 * What reads a process's start time and what reads and signals processes; the host's own unless a test gives them.
 * `startedAt` gives the start of a running pid, undefined only when a reading shows no process has it, and throws when
 * the reading fails.
 */
export type SweepSystem = { startedAt: (pid: number) => string | undefined; processes?: ProcessOwnershipSystem; read?: () => readonly OwnedProcessIdentity[] | Promise<readonly OwnedProcessIdentity[]> }

const identitySchema = s.object({
  pid: s.number({ integer: true, min: 2 }),
  parentPid: s.number({ integer: true, min: 0 }),
  groupId: s.number({ integer: true, min: 0 }),
  startedAt: s.string(),
  command: s.string(),
  state: s.optional(s.string()),
})

const recordSchema = s.object({
  version: s.literal(1),
  startTimeVersion: s.optional(s.number({ integer: true, min: 1 })),
  path: s.string(),
  launcher: s.object({ pid: s.number({ integer: true, min: 1 }), startedAt: s.string() }),
  processes: s.array(identitySchema),
})

const hostSystem: SweepSystem = { startedAt: processStartedAt, read: readProcessTableAsync }

/**
 * Ends what WebKit launches of earlier Retest processes left behind, by their own records and nothing else. Each
 * `retest-webkit-` home in `folder` holds an owner record naming the Retest process that made it, by pid and start time,
 * and every browser process it recorded. A home whose Retest process still runs is left alone. Otherwise each recorded
 * process that still runs as the same process, by `sameProcessIdentity`, now a child of launchd, is killed, and the home is
 * removed once none of them runs. A home with no record, or one that cannot be read, is left where it is, since nothing
 * proves whose it is. A reading that fails proves nothing either, so a home is left whole, and nothing of it signalled,
 * when its Retest process or any recorded process could not be read, and while a process runs with the pid of a Retest
 * process whose start was never read. Returns a line for each thing it did or could not do, and for each home a reading
 * kept it from sweeping.
 *
 * @example const notes = await sweepWebKitHomes(tmpdir())
 */
export async function sweepWebKitHomes(folder: string, system: SweepSystem = hostSystem): Promise<string[]> {
  let entries: string[]
  let root: string
  try {
    // Homes are made, and their records written, with the folder's links resolved.
    root = await realpath(folder)
    entries = await readdir(root)
  } catch (error) {
    return [`Could not look for WebKit homes left in ${folder}: ${errorMessage(error)}`]
  }
  const notes: string[] = []
  for (const entry of entries) {
    if (!entry.startsWith('retest-webkit-')) continue
    notes.push(...(await sweepHome(join(root, entry), system)))
  }
  return notes
}

async function sweepHome(home: string, system: SweepSystem): Promise<string[]> {
  const record = await readRecord(home)
  if (record === undefined || record.path !== home) return []
  const { launcher } = record
  let table: readonly OwnedProcessIdentity[] | undefined
  try {
    if (system.read !== undefined) table = await system.read()
    else if (record.startTimeVersion !== 1) table = system.processes?.read() ?? await readProcessTableAsync()
  } catch (error) {
    return [`Left the WebKit home ${home} in place because the whole process table could not be read: ${errorMessage(error)}.`]
  }
  if (record.startTimeVersion !== 1) {
    const file = join(home, homeRecordFile)
    if (table === undefined || table.some(entry => entry.pid === launcher.pid || record.processes.some(process => process.pid === entry.pid) || entry.command.includes(home))) return [`Left the WebKit home ${home} and its processes alone, since Retest cannot confirm the recorded start time zone in ${file}. Remove ${file} once no runner is running.`]
    try {
      await rm(home, { recursive: true, force: true, maxRetries: 3 })
      return [`Removed the WebKit home ${home}; all recorded pids are absent from the whole process table.`]
    } catch (error) {
      return [`Could not remove the WebKit home ${home}: ${errorMessage(error)}`]
    }
  }
  let launcherStart: string | undefined
  try {
    launcherStart = table === undefined ? system.startedAt(launcher.pid) : table.find(entry => entry.pid === launcher.pid)?.startedAt
  } catch (error) {
    return [`Left the WebKit home ${home} in place, since whether Retest process ${launcher.pid}, which made it, still runs could not be read: ${errorMessage(error)}`]
  }
  if (launcherStart === launcher.startedAt) return []
  if (launcherStart !== undefined && launcher.startedAt !== unknownStartedAt) return [`Left the WebKit home ${home} in place; its launcher pid ${launcher.pid} is present with a different start, which cannot prove absence. Remove ${join(home, homeRecordFile)} once no runner is running.`]
  // A start that was never read cannot tell the Retest process from another with its pid, so only a reading that shows
  // no process with that pid frees the home.
  if (launcherStart !== undefined && launcher.startedAt === unknownStartedAt) {
    return [`Left the WebKit home ${home} in place, since Retest process ${launcher.pid} made it without reading its own start and a process ${launcher.pid} still runs.`]
  }
  const reading = runningAsRecorded(record.processes, system)
  if (reading.problems.length > 0) {
    return [`Left the WebKit home ${home}, which Retest process ${launcher.pid} left behind, in place and ended none of its processes: ${reading.problems.join(' ')}`]
  }
  const notes: string[] = []
  let left = 0
  for (const { recorded, ownership } of reading.running) {
    const problems = ownership.signal('SIGKILL')
    notes.push(problems.length === 0
      ? `Ended process ${recorded.pid}, which a WebKit launch of Retest process ${launcher.pid} recorded and left running.`
      : `Could not end process ${recorded.pid}, which a WebKit launch of Retest process ${launcher.pid} left running: ${problems.join(' ')}`)
    if (problems.length > 0) left += 1
  }
  if (left > 0) return notes
  try {
    await rm(home, { recursive: true, force: true, maxRetries: 3 })
    notes.push(`Removed the WebKit home ${home}, which Retest process ${launcher.pid} left behind.`)
  } catch (error) {
    notes.push(`Could not remove the WebKit home ${home}: ${errorMessage(error)}`)
  }
  return notes
}

// Every recorded process is read before any is signalled, so a reading that fails for one of them, as when the system
// has no file left to open, holds them all rather than end some on the strength of a reading that went wrong.
function runningAsRecorded(processes: readonly OwnedProcessIdentity[], system: SweepSystem): { running: { recorded: OwnedProcessIdentity; ownership: OwnedProcessGroup }[]; problems: readonly string[] } {
  const running: { recorded: OwnedProcessIdentity; ownership: OwnedProcessGroup }[] = []
  for (const recorded of processes) {
    const ownership = new OwnedProcessGroup(recorded.pid, 1, system.processes)
    ownership.capture()
    const current = ownership.verifiedIdentity(recorded.pid)
    if (ownership.readProblems.length > 0) return { running: [], problems: ownership.readProblems }
    if (current !== undefined) {
      if (!sameProcessIdentity(recorded, current)) return { running: [], problems: [`Recorded pid ${recorded.pid} is present with a different identity; a mismatch cannot prove absence.`] }
      running.push({ recorded, ownership })
    }
  }
  return { running, problems: [] }
}

async function readRecord(home: string): Promise<WebKitHomeRecord | undefined> {
  let text: string
  try {
    text = await readFile(join(home, homeRecordFile), 'utf8')
  } catch {
    return undefined
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  const read = parse(recordSchema, value)
  return read.ok ? read.value : undefined
}
