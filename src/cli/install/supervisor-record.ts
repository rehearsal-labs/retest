import type { FileIdentity, FileReadControl } from '../../shared/regular-file.ts'
import type { SupervisorEnvironment, SupervisorRecord } from './supervisor-locate.ts'
import type { SupervisorTarget } from './supervisor-pins.ts'
import { createHash } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Deadline } from '../../protocol/deadline.ts'
import { errorMessage } from '../../protocol/failures.ts'
import { isMissingFile } from '../../shared/error-code.ts'
import { checkFileIdentity, readFileSha256, readRecordText } from '../../shared/regular-file.ts'
import { rustAtLeast } from './media-tools.ts'
import { readSupervisorRecord, supervisorFolder } from './supervisor-locate.ts'
import { maximumSupervisorBinaryBytes, maximumSupervisorSourceBytes, minimumSupervisorRust, supervisorExecutable, supervisorSourceDigest, supervisorSourceFiles, supervisorTarget, supervisorVersion } from './supervisor-pins.ts'

export type { SupervisorEnvironment, SupervisorRecord } from './supervisor-locate.ts'
export { locateSupervisor, supervisorFolder, supervisorInstallCommand } from './supervisor-locate.ts'

export type SupervisorInspection = {
  readonly engine: 'supervisor'; readonly version: string; readonly target: SupervisorTarget
  readonly state: 'missing' | 'installed' | 'damaged'; readonly folder: string
  readonly executablePath: string; readonly problems: readonly string[]; readonly record?: SupervisorRecord
  readonly executableIdentity?: FileIdentity
}

export function supervisorPackageRoot(): string { return resolve(dirname(fileURLToPath(import.meta.url)), '../../..') }

export function supervisorLockPath(folder: string): string { return join(dirname(dirname(folder)), 'locks', `${basename(folder)}.lock`) }

/** The notices an installed supervisor carries beside it, under the names it keeps them by. */
export function supervisorNoticePins(): { path: string; sha256: string }[] {
  return supervisorSourceFiles.filter((file) => file.path === 'LICENSE' || file.path === 'supervisor/NOTICES').map((file) => ({ path: file.path === 'LICENSE' ? 'LICENSE' : 'THIRD-PARTY-NOTICES.txt', sha256: file.sha256 }))
}

/** Hashes the pinned allowlist only. A changed, absent or non-regular source is refused before cargo runs. */
export async function checkSupervisorSource(root: string, options: FileReadControl = {}): Promise<string | undefined> {
  const deadline = options.deadline ?? new Deadline(15_000, { signal: options.signal })
  const hash = createHash('sha256')
  for (const file of supervisorSourceFiles) {
    const path = join(root, ...file.path.split('/'))
    const reading = await readFileSha256(path, { maximumBytes: maximumSupervisorSourceBytes, deadline, ...(options.signal === undefined ? {} : { signal: options.signal }) })
    if (reading.kind !== 'file') return reading.kind === 'other' ? reading.problem : `${path} is missing. Reinstall the Retest package with its supervisor source and notices.`
    if (reading.sha256 !== file.sha256) return `${path} has SHA-256 ${reading.sha256}, not the pinned ${file.sha256}. Reinstall the Retest package; cargo was not run.`
    hash.update(`${file.path}\0${reading.sha256}\n`)
  }
  return hash.digest('hex') === supervisorSourceDigest ? undefined : 'The supervisor source manifest does not match its pinned digest. Reinstall Retest.'
}

/** Reads an installed supervisor back: its record, its binary and notices against the record, and nothing else beside them. */
export async function inspectSupervisor(env: SupervisorEnvironment, options: FileReadControl & { readonly target?: SupervisorTarget; readonly verify?: boolean } = {}): Promise<SupervisorInspection | undefined> {
  const deadline = options.deadline ?? new Deadline(15_000, { signal: options.signal })
  const target = options.target ?? supervisorTarget()
  if (target === undefined) return undefined
  const folder = supervisorFolder(env, target)
  if (folder === undefined) return undefined
  const base = { engine: 'supervisor' as const, version: supervisorVersion, target, folder, executablePath: join(folder, supervisorExecutable) }
  const bad = (problem: string): SupervisorInspection => ({ ...base, state: 'damaged', problems: [problem] })
  try {
    const stats = await lstat(folder)
    if (!stats.isDirectory()) return bad(`${folder} is not a regular cache folder. Remove it before installing again.`)
  } catch (error) {
    return isMissingFile(error) ? { ...base, state: 'missing', problems: [] } : bad(`${folder} cannot be read: ${errorMessage(error)}`)
  }
  const path = join(folder, 'build.json')
  const read = await readRecordText(path, { deadline, ...(options.signal === undefined ? {} : { signal: options.signal }) })
  if (read.kind !== 'text') return bad(`${path} cannot be read: ${read.kind === 'missing' ? 'it is missing' : read.problem}.`)
  const checked = checkRecord(path, read.text, target)
  if (!checked.ok) return bad(checked.problem)
  const record = checked.record
  const notices = supervisorNoticePins()
  let executableIdentity: FileIdentity | undefined
  for (const file of [{ path: supervisorExecutable, sha256: record.binarySha256 }, ...notices]) {
    const filePath = join(folder, file.path)
    const reading = await readFileSha256(filePath, { maximumBytes: file.path === supervisorExecutable ? maximumSupervisorBinaryBytes : maximumSupervisorSourceBytes, deadline, ...(options.signal === undefined ? {} : { signal: options.signal }) })
    if (reading.kind !== 'file') return bad(reading.kind === 'missing' ? `${filePath} is missing.` : reading.problem)
    if (reading.sha256 !== file.sha256) return bad(`${filePath} has SHA-256 ${reading.sha256}, not the recorded ${file.sha256}.`)
    if (file.path === supervisorExecutable) executableIdentity = reading.identity
  }
  if (options.verify === true) {
    const allowed = new Set(['build.json', supervisorExecutable, ...notices.map((notice) => notice.path)])
    let names: string[]
    try { names = await readdir(folder) } catch (error) { return bad(`${folder} cannot be checked: ${errorMessage(error)}.`) }
    const unexpected = names.filter((name) => !allowed.has(name))
    if (unexpected.length > 0) return bad(`${folder} holds unrecorded entries: ${unexpected.slice(0, 5).join(', ')}.`)
  }
  if (executableIdentity === undefined) return bad(`${base.executablePath} has no hashed file identity.`)
  const changed = await checkFileIdentity(base.executablePath, executableIdentity)
  if (changed !== undefined) return bad(changed)
  return { ...base, state: 'installed', problems: [], record, executableIdentity }
}

// The record as the locator reads it, and also the toolchain it names and the notices it lists, which an install
// checks and a launch has no need to.
function checkRecord(path: string, text: string, target: SupervisorTarget): { readonly ok: true; readonly record: SupervisorRecord } | { readonly ok: false; readonly problem: string } {
  const read = readSupervisorRecord(path, text, target)
  if (!read.ok) return read
  if (!rustAtLeast(read.record.rustcVersion, minimumSupervisorRust)) return { ok: false, problem: `${path} names no supported rustc build version.` }
  if (JSON.stringify(read.record.notices) !== JSON.stringify(supervisorNoticePins())) return { ok: false, problem: `${path} does not name the pinned licence notices.` }
  return read
}
