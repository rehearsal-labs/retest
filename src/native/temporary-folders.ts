import type { NativeTools } from './processes.ts'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { errorMessage } from '../protocol/failures.ts'
import { parse, s } from '../protocol/schema.ts'
import { readOwnStart, readProcessTable } from './processes.ts'

// The folders a native run keeps in the temporary folder: an executor's result bundle and derived data, where XCTest
// names its typing activities by the first characters typed, and each runtime's own folder. A close deletes them, and
// so does the exit hook; a SIGKILL runs neither. So each folder carries a record of the Retest process that made it, by
// pid and start, and a later start deletes a folder whose maker is gone. A folder without a record, or whose maker runs
// or cannot be read, is left alone.

/** The kinds of folder a native run makes, by the prefix of its name. */
export type OwnedFolderPrefix = 'retest-executor-' | 'retest-macos-' | 'retest-ios-'

const prefixes: readonly OwnedFolderPrefix[] = ['retest-executor-', 'retest-macos-', 'retest-ios-']
const ownerFile = 'retest-owner.json'
const ownerSchema = s.object({ startTimeVersion: s.optional(s.number({ integer: true, min: 1 })), pid: s.number({ integer: true, min: 2 }), startedAt: s.string() })

/** The folder maker. Start version 1 is C-locale UTC0; an absent or unknown version cannot confirm ownership. */
export type FolderOwner = { readonly startTimeVersion?: number; readonly pid: number; readonly startedAt: string }

/**
 * A new folder in the temporary folder that names this process as its maker. Rejects, leaving nothing, when this
 * process's start cannot be read or the record cannot be written.
 *
 * @example await makeOwnedFolder('retest-executor-', systemTools) // '/var/folders/…/T/retest-executor-Ab12Cd'
 */
export async function makeOwnedFolder(prefix: OwnedFolderPrefix, tools: NativeTools): Promise<string> {
  const owner: FolderOwner = { startTimeVersion: 1, pid: process.pid, startedAt: await readOwnStart(tools.hiddenVariables) }
  const folder = await mkdtemp(join(tmpdir(), prefix))
  try {
    await writeFile(join(folder, ownerFile), JSON.stringify(owner), { mode: 0o600, flag: 'wx' })
  } catch (error) {
    await rm(folder, { recursive: true, force: true })
    throw error
  }
  return folder
}

/** What a sweep did: the folders it deleted, how many it left alone, and the deletions that failed. */
export type FolderSweep = { readonly removed: readonly string[]; readonly kept: number; readonly problems: readonly string[] }

/**
 * Deletes native run folders whose recorded maker's pid is absent from a fresh whole table. A start mismatch alone
 * never frees a folder. A folder with no readable record, or whose maker runs or cannot be
 * read, is kept; links are never followed.
 *
 * @example (await sweepOwnedFolders(systemTools)).removed // ['/var/folders/…/T/retest-executor-Ab12Cd']
 */
export async function sweepOwnedFolders(_tools: NativeTools, root: string = tmpdir()): Promise<FolderSweep> {
  const entries = await readdir(root, { withFileTypes: true })
  let table: Awaited<ReturnType<typeof readProcessTable>> | undefined
  const removed: string[] = []
  const problems: string[] = []
  let kept = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || !prefixes.some((prefix) => entry.name.startsWith(prefix))) continue
    const folder = join(root, entry.name)
    const owner = await readOwner(folder)
    if (owner === undefined) { kept += 1; continue }
    try {
      table ??= await readProcessTable()
    } catch (error) {
      kept += 1
      problems.push(`Retest cannot confirm absence for ${join(folder, ownerFile)} because the whole process table could not be read: ${errorMessage(error)}.`)
      continue
    }
    if (table.some(entry => entry.pid === owner.pid)) {
      kept += 1
      if (owner.startTimeVersion !== 1) problems.push(`Retest cannot confirm the recorded start time zone in ${join(folder, ownerFile)}; the folder and process were left alone. Remove ${join(folder, ownerFile)} once no runner is running.`)
      continue
    }
    try {
      await rm(folder, { recursive: true, force: true, maxRetries: 2 })
      removed.push(folder)
    } catch (error) {
      problems.push(`Retest could not delete ${folder}, which a Retest process that is gone left behind: ${errorMessage(error)}`)
    }
  }
  return { removed, kept, problems }
}

async function readOwner(folder: string): Promise<FolderOwner | undefined> {
  try {
    const parsed = parse(ownerSchema, JSON.parse(await readFile(join(folder, ownerFile), 'utf8')))
    return parsed.ok ? parsed.value : undefined
  } catch {
    return undefined
  }
}
