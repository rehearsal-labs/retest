import type { Dirent } from 'node:fs'
import type { RetestEvent } from '../protocol/events.ts'
import { lstatSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { retestEventSchema } from '../protocol/events.ts'
import { eventsFile, resultFile } from '../protocol/run-folder.ts'
import { parse } from '../protocol/schema.ts'
import { readMetadataProcessAsync } from '../shared/metadata-process.ts'
import { readProcessTableAsync } from '../shared/process-ownership.ts'
import { createArtifactFolder, readArtifactFile, referenceProblem, resolveReference } from '../store/artifacts.ts'

/** A Retest process, by pid and start time as `ps` prints it, so a pid used again by another process is never taken for it. */
export type ProcessMark = { readonly startTimeVersion?: number; readonly pid: number; readonly startedAt?: string | undefined }

/**
 * A run that recorded and did not finish: its id, its folder, the Retest process that owned its media process, and the
 * output of each recording it began, as a reference in its folder without the video's extension.
 */
export type UnfinishedRun = { readonly runId: string; readonly folder: string; readonly owner: ProcessMark; readonly outputs: readonly string[] }

// How many run folders beside this one are read, newest first, and how much of each one's events.
const maxFolders = 16
const maxEventBytes = 32 * 1024 * 1024
const maxOutputs = 64
const markedLines = ['"type":"run.started"', '"type":"media.started"', '"type":"recording.started"']

/**
 * The runs beside `runFolder` that began recordings and never wrote `result.json`: the folders in the same parent that
 * hold a Retest event log whose run started a media process. Only the newest folders are read, each only up to a size,
 * and only the lines that start the run, its media process and its recordings. Nothing is written. A folder that cannot
 * be read is passed over.
 *
 * @example unfinishedRuns('/project/.retest/runs/2026-10-06T10-00-00')
 */
export function unfinishedRuns(runFolder: string): UnfinishedRun[] {
  const parent = dirname(runFolder)
  const own = basename(runFolder)
  let entries: Dirent[]
  try {
    entries = readdirSync(parent, { withFileTypes: true })
  } catch {
    return []
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name !== own)
    .map((entry) => join(parent, entry.name))
    .flatMap((folder) => {
      const modified = modifiedMs(folder)
      return modified === undefined ? [] : [{ folder, modified }]
    })
    .sort((first, second) => second.modified - first.modified)
    .slice(0, maxFolders)
  return candidates.flatMap(({ folder }) => {
    const run = unfinishedRun(folder)
    return run === undefined ? [] : [run]
  })
}

/**
 * Whether the process a mark names still runs: true for a confirmed current start, false only when a whole table
 * shows its pid absent; undefined for a present legacy or mismatched start, or an unreadable host. Unknowns stay alone.
 *
 * @example await processRuns({ pid: 4242, startedAt: 'Mon Oct  6 10:00:01 2026' }) // false
 */
export async function processRuns(mark: ProcessMark): Promise<boolean | undefined> {
  try {
    const found = (await readProcessTableAsync()).find(entry => entry.pid === mark.pid)
    if (found === undefined) return false
    if (mark.startTimeVersion !== 1) return undefined
    return mark.startedAt === undefined || mark.startedAt === found.startedAt.replace(/\s+/g, ' ') ? true : undefined
  } catch {
    return undefined
  }
}

/**
 * When this process started, as `ps` prints it, so a later run can tell it from another process with the same pid.
 * Undefined when the host could not be read.
 */
export async function ownStartTime(): Promise<string | undefined> {
  return (await processStartTimes([process.pid]))?.get(process.pid)
}

// One reading for the pids asked; this process is always among those read, so `ps` succeeds when the others are gone.
async function processStartTimes(pids: readonly number[]): Promise<Map<number, string> | undefined> {
  const asked = [...new Set([...pids, process.pid])].filter((pid) => Number.isSafeInteger(pid) && pid > 0)
  let text: string
  try {
    text = await readMetadataProcessAsync({ command: '/bin/ps', args: ['-o', 'pid=,lstart=', '-p', asked.join(',')], environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC0' } })
  } catch {
    return undefined
  }
  const times = new Map<number, string>()
  for (const line of text.split('\n')) {
    const fields = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
    if (fields?.[1] !== undefined && fields[2] !== undefined) times.set(Number(fields[1]), fields[2].replace(/\s+/g, ' '))
  }
  return times
}

function modifiedMs(folder: string): number | undefined {
  try {
    const stats = lstatSync(folder)
    return stats.isDirectory() ? stats.mtimeMs : undefined
  } catch {
    return undefined
  }
}

function unfinishedRun(folder: string): UnfinishedRun | undefined {
  if (exists(join(folder, resultFile))) return undefined
  const read = readArtifactFile(folder, eventsFile, { maxBytes: maxEventBytes })
  if (!read.ok) return undefined
  const text = read.bytes.toString('utf8')
  let runId: string | undefined
  let owner: ProcessMark | undefined
  const outputs: string[] = []
  for (const line of text.split('\n')) {
    if (!markedLines.some((mark) => line.includes(mark))) continue
    const event = parseEvent(line)
    if (event === undefined) continue
    if (event.type === 'run.started') runId = event.runId
    else if (event.type === 'media.started') owner ??= event.media.owner
    else if (event.type === 'recording.started' && outputs.length < maxOutputs) {
      const output = withoutExtension(event.path)
      if (output !== undefined && !outputs.includes(output)) outputs.push(output)
    }
  }
  if (runId === undefined || owner === undefined || outputs.length === 0) return undefined
  return { runId, folder, owner, outputs }
}

function parseEvent(line: string): RetestEvent | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  const parsed = parse(retestEventSchema, value)
  return parsed.ok ? parsed.value : undefined
}

// A recording's path in its run folder without the video's extension, as its media process was given it; only a
// reference inside that folder, with no link on its way, counts.
function withoutExtension(path: string): string | undefined {
  const match = /^(.*)\.(mp4|webm)$/.exec(path)
  const output = match?.[1]
  if (output === undefined || referenceProblem(path) !== undefined) return undefined
  return output
}

/**
 * The absolute path of a reference in a run folder, refusing one with a link on its way out of the folder.
 *
 * @example outputPath('/runs/old', 'artifacts/k3v9/web-1a2b/recording-1')
 */
export function outputPath(folder: string, reference: string): string | undefined {
  const resolved = createArtifactFolder(folder, reference)
  if (!resolved.ok) return undefined
  const lexical = resolveReference(folder, reference)
  return lexical.ok ? lexical.path : undefined
}

function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
