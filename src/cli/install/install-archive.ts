import type { ArchivePin, BuildInspection, CacheFolders, InstalledBuildRecord, LicenceReading } from '../../browser/builds.ts'
import type { NativeTools } from '../../native/processes.ts'
import type { UnpackTools } from './unpack.ts'
import { constants } from 'node:fs'
import { access, lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { buildFolder, describePin, describePlatform, describeTreeProblems, fileSha256, inspectBuild, pinRefusal, readBundledLicence, readFileSha256, readLicences, recordFile, scanTree, treeFolder } from '../../browser/builds.ts'
import { folderChecksum } from '../../native/executors.ts'
import { processExists } from '../../native/processes.ts'
import { isMissingFile } from '../../shared/error-code.ts'
import { downloadFile, mirroredUrl, shownAddress } from './download.ts'
import { takeInstallLock } from './lock.ts'
import { licenceLines, mirrorProblem } from './report.ts'
import { unpackArchive } from './unpack.ts'

/** Licence notices a build lacks, introduced by `lead`, for a terminal to list one to a line. */
export type MissingNotices = { readonly lead: string; readonly files: readonly { readonly path: string; readonly title: string }[] }

/**
 * How an install ended: the build installed now or found installed, or why it is not, whether it was stopped, and for
 * a build refused over its licence notices, which ones.
 */
export type InstallResult =
  | { readonly ok: true; readonly action: 'installed' | 'already_installed'; readonly inspection: BuildInspection }
  | { readonly ok: false; readonly message: string; readonly stopped: boolean; readonly notices?: MissingNotices }

/** What installing one archive build needs. `fetch`, `tools` and `now` are the real ones unless a test passes others. */
export type InstallArchiveOptions = {
  readonly pin: ArchivePin
  readonly folders: CacheFolders
  /** A mirror to fetch from instead of the publisher; the archive must still have the pinned checksum. */
  readonly mirror?: string | undefined
  readonly signal: AbortSignal
  readonly tools: UnpackTools
  readonly platform: NodeJS.Platform
  /** Written to the record, as the version of Retest that installed the build. */
  readonly version: string
  /** One line for each step a person waits on, such as the download. */
  readonly report: (line: string) => void
  readonly fetch?: typeof fetch | undefined
  readonly now?: (() => Date) | undefined
  readonly idleMs?: number | undefined
  readonly totalMs?: number | undefined
  /** The tools the install lock reads a holder's start with, `ps` among them on macOS; the system's unless a test passes others. */
  readonly lockTools?: NativeTools | undefined
}

/** No archive Retest pins is near this, and no download writes more. */
export const maximumArchiveBytes: number = 2 * 1024 * 1024 * 1024
const defaultIdleMs = 60_000
const defaultTotalMs = 60 * 60_000
const unpackTimeoutMs = 10 * 60_000

/**
 * Installs one pinned archive build into the cache, downloading it only now that it is asked for. In order: a pin
 * Retest does not install is refused before anything is fetched; the build's install lock is taken, and a lock another
 * process holds refuses the install, naming the lock and its holder; a build already installed as its pin and record
 * say is left as it is, and an archive left beside it is deleted; one that is there but not as recorded is refused and
 * named. Partial downloads and staging folders of installs whose process is gone are deleted. The archive is downloaded
 * beside the cache and kept under a temporary name until its size and SHA-256 match the pin; one that does not match is
 * deleted unread. It is then unpacked into a staging folder, where it may hold only folders, files without a set-id
 * bit and links that stay inside it, and where the executable, the pinned files and every licence notice the pin names
 * must be present with their checksums. Only then is the record written and the staging folder renamed into place, so
 * a build folder always holds a finished, checked build, and the archive is deleted. A verified archive whose
 * unpacking failed is kept for the next attempt.
 *
 * @example await installArchive({ pin, folders, signal, tools: systemUnpackTools, platform: process.platform, version: retestVersion, report: console.log })
 */
export async function installArchive(options: InstallArchiveOptions): Promise<InstallResult> {
  const { pin, folders } = options
  if (pin.licences.inspected && pin.licences.files.some((file) => file.bundled !== undefined)) {
    for (const line of licenceLines(pin)) options.report(line)
  }
  const refusal = pinRefusal(pin)
  if (refusal !== undefined) return { ...refused(refusal.message), ...(refusal.lead === undefined ? {} : { notices: { lead: refusal.lead, files: refusal.missing } }) }
  const pinnedSha256 = pin.archive.sha256
  if (pinnedSha256 === undefined) return refused(`No checksum is pinned for the ${describePin(pin)} archive.`)
  const mirrorRefusal = options.mirror === undefined ? undefined : mirrorProblem(options.mirror)
  if (mirrorRefusal !== undefined) return refused(mirrorRefusal)
  await mkdir(folders.browsers, { recursive: true })
  const lock = await takeInstallLock(installLockPath(folders, pin), { tools: options.lockTools, signal: options.signal })
  if (!lock.ok) return { ok: false, message: lock.message, stopped: lock.stopped === true }
  let result: InstallResult
  try {
    result = await installLocked(options, pinnedSha256)
  } finally {
    const problem = await lock.release()
    if (problem !== undefined) options.report(problem)
  }
  return result
}

async function installLocked(options: InstallArchiveOptions, pinnedSha256: string): Promise<InstallResult> {
  const { pin, folders } = options
  const folder = buildFolder(folders, pin)
  const archive = archivePath(folders, pin)
  const before = await inspectBuild(pin, folders)
  if (before.state === 'installed') {
    // An archive a killed install left after renaming its build into place is of no further use.
    await rm(archive, { force: true })
    return { ok: true, action: 'already_installed', inspection: before }
  }
  if (before.state !== 'missing') return refused(`${describePin(pin)} is in ${folder}, but not as recorded: ${before.problems.join(' ')} Remove ${folder} and run the install again.`)
  await sweepStaging(folder)
  await sweepPartials(dirname(archive))
  const obtained = await obtainArchive({ ...options, archive, sha256: pinnedSha256 })
  if (!obtained.ok) return obtained
  const staging = `${folder}${stagingMark}${process.pid}`
  await rm(staging, { recursive: true, force: true })
  try {
    const placed = await unpackAndRecord({ options, archive, staging, obtained })
    if (!placed.ok) return placed
    await rename(staging, folder)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  await rm(archive, { force: true })
  const after = await inspectBuild(pin, folders)
  if (after.state !== 'installed') return refused(`${describePin(pin)} was unpacked into ${folder}, then did not read as installed: ${after.problems.join(' ')}`)
  return { ok: true, action: 'installed', inspection: after }
}

/**
 * The lock that keeps two installs of one build apart on this machine: a folder of its own beside the cache's builds,
 * which holds the lock's newest generations and stays there once made.
 *
 * @example installLockPath(folders, pin) // '…/retest/locks/electron-44.5.1-mac-arm64.lock'
 */
export function installLockPath(folders: CacheFolders, pin: ArchivePin): string {
  return join(dirname(folders.browsers), 'locks', `${basename(buildFolder(folders, pin))}.lock`)
}

/**
 * Where an archive waits while it is checked: in a downloads folder beside the builds, named after the pin and the
 * publisher's file name.
 *
 * @example archivePath(folders, pin) // '…/browsers/downloads/electron-44.5.1-mac-arm64-electron-v44.5.1-darwin-arm64.zip'
 */
export function archivePath(folders: CacheFolders, pin: ArchivePin): string {
  return join(folders.browsers, 'downloads', `${pin.engine}-${pin.version}-${pin.platform}-${basename(decodeURIComponent(new URL(pin.archive.url).pathname))}`)
}

const stagingMark = '.staging-'

type Obtained = { readonly ok: true; readonly size: number; readonly sha256: string; readonly fetchedFrom: string }

// A verified archive left by an earlier attempt is used again after its bytes are read once more. Anything else under
// that name is deleted, and the archive downloaded to a temporary name that becomes its own only once it matches.
async function obtainArchive(options: InstallArchiveOptions & { readonly archive: string; readonly sha256: string }): Promise<Obtained | InstallResult & { ok: false }> {
  const { pin, archive, sha256 } = options
  const source = pin.archive.url
  const url = mirroredUrl(source, options.mirror)
  const kept = await readFileSha256(archive)
  if (kept.kind === 'file' && kept.sha256 === sha256) {
    options.report(`Using the archive kept from an earlier attempt, ${archive}; its SHA-256 matches the pin.`)
    const size = (await lstat(archive)).size
    return { ok: true, size, sha256, fetchedFrom: 'an earlier attempt' }
  }
  if (kept.kind !== 'missing') await rm(archive, { recursive: true, force: true })
  await mkdir(dirname(archive), { recursive: true })
  const partial = `${archive}${partialMark}${process.pid}`
  await rm(partial, { force: true })
  const size = pin.archive.size === undefined ? '' : ` (${formatBytes(pin.archive.size)})`
  options.report(`Downloading ${describePin(pin)} for ${describePlatform(pin.platform)} from ${shownAddress(url)}${size}`)
  const downloaded = await downloadFile({
    url,
    to: partial,
    expectedSize: pin.archive.size,
    maximumBytes: maximumArchiveBytes,
    signal: options.signal,
    idleMs: options.idleMs ?? defaultIdleMs,
    totalMs: options.totalMs ?? defaultTotalMs,
    userAgent: `retest/${options.version}`,
    fetch: options.fetch,
  })
  if (!downloaded.ok) return { ok: false, message: `${downloaded.message} Nothing was installed.`, stopped: downloaded.stopped }
  if (downloaded.sha256 !== sha256) {
    await rm(partial, { force: true })
    return refused(`The archive from ${shownAddress(url)} has SHA-256 ${downloaded.sha256}, not the pinned ${sha256}. It was deleted unread and nothing was installed.`)
  }
  await rename(partial, archive)
  options.report(`Verified: ${downloaded.size} bytes, SHA-256 ${sha256}`)
  // A redirect's query can be a signature, such as the one on a release asset's address, and is never recorded.
  return { ok: true, size: downloaded.size, sha256, fetchedFrom: shownAddress(downloaded.answeredBy) }
}

const partialMark = '.partial-'

// Partial downloads left by installs whose process is gone are deleted; one whose process still runs is left to it,
// and so is one of this process's, which may belong to another install it is running.
async function sweepPartials(downloads: string): Promise<void> {
  const names = await readdir(downloads).catch((error: unknown) => (isMissingFile(error) ? [] : Promise.reject(error)))
  for (const name of names) {
    const at = name.lastIndexOf(partialMark)
    if (at < 0) continue
    const pid = Number(name.slice(at + partialMark.length))
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || mayStillRun(pid)) continue
    await rm(join(downloads, name), { force: true })
  }
}

// Above any pid a system hands out; `process.kill` refuses even to ask about one.
const largestPid = 2 ** 31 - 1

// Whether the process a leftover is named after may still be using it. A number no process can have is nobody's, and a
// question the system cannot answer leaves the leftover where it is.
function mayStillRun(pid: number): boolean {
  if (pid > largestPid) return false
  try {
    return processExists(pid)
  } catch {
    return true
  }
}

type Placement = { readonly options: InstallArchiveOptions; readonly archive: string; readonly staging: string; readonly obtained: Obtained }

async function unpackAndRecord({ options, archive, staging, obtained }: Placement): Promise<{ readonly ok: true } | InstallResult & { ok: false }> {
  const { pin } = options
  const root = join(staging, treeFolder)
  await mkdir(root, { recursive: true })
  const problem = await unpackArchive({ archive, format: pin.archive, into: root, platform: options.platform, tools: options.tools, signal: options.signal, timeoutMs: unpackTimeoutMs })
  if (options.signal.aborted) return { ok: false, message: `The install was stopped while the archive was unpacked. The verified archive is kept at ${archive} for the next attempt.`, stopped: true }
  if (problem !== undefined) return refused(`${problem} The verified archive is kept at ${archive} for the next attempt.`)
  const noticesProblem = await copyBundledLicences(pin, root)
  if (noticesProblem !== undefined) {
    await rm(archive, { force: true })
    return refused(`${noticesProblem} The archive was deleted and nothing was installed.`)
  }
  const checked = await checkUnpacked(pin, root)
  if (!checked.ok) {
    await rm(archive, { force: true })
    const notices = checked.missing === undefined ? {} : { notices: { lead: `${describePin(pin)} lacks these licence notices, so Retest deleted its archive and installed nothing:`, files: checked.missing } }
    return { ...refused(`${checked.message} The archive was deleted and nothing was installed.`), ...notices }
  }
  const record: InstalledBuildRecord = {
    schemaVersion: 1,
    engine: pin.engine,
    version: pin.version,
    platform: pin.platform,
    source: pin.archive.url,
    ...(pin.sourceCode === undefined ? {} : { sourceCode: pin.sourceCode }),
    fetchedFrom: obtained.fetchedFrom,
    archive: { size: obtained.size, sha256: obtained.sha256 },
    executable: { path: pin.executable.path, sha256: checked.executableSha256 },
    files: pin.files.map((file) => ({ path: file.path, sha256: file.sha256 })),
    licences: checked.licences.map((reading) => ({ path: reading.file.path, licence: reading.file.licence, sha256: reading.sha256 ?? '' })),
    tree: { sha256: checked.treeSha256 },
    installedAt: (options.now ?? (() => new Date()))().toISOString(),
    installedBy: options.version,
  }
  const temporary = join(staging, `${recordFile}.${process.pid}.tmp`)
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`)
  await rename(temporary, join(staging, recordFile))
  return { ok: true }
}

/** Place only checked notice bytes into the private staging tree, before its licence and tree checks. */
export async function copyBundledLicences(pin: ArchivePin, root: string): Promise<string | undefined> {
  if (!pin.licences.inspected) return pin.licences.reason
  for (const file of pin.licences.files) {
    if (file.bundled === undefined) continue
    const reading = readBundledLicence(file)
    if (!reading.ok) return `${file.path}: ${reading.problem}.`
    if (!/^licenses\/[A-Za-z0-9.-]+$/.test(file.path)) return `${file.path}: no portable installed notice path.`
    const target = join(root, file.path)
    const folder = dirname(target)
    await mkdir(folder, { recursive: true })
    if (!(await lstat(folder)).isDirectory()) return `${file.path}: its notice folder is not a directory.`
    // Never follow or overwrite a notice an archive supplied. Its own checksum check below must accept it.
    try {
      await writeFile(target, reading.bytes, { flag: 'wx', mode: 0o644 })
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) return `${file.path}: the notice could not be retained.`
    }
  }
  return undefined
}

type Checked =
  | { readonly ok: true; readonly executableSha256: string; readonly licences: readonly LicenceReading[]; readonly treeSha256: string }
  | { readonly ok: false; readonly message: string; readonly missing?: readonly { readonly path: string; readonly title: string }[] }

/**
 * Checks an unpacked build against its pin, before it is recorded: no link leads outside it, it holds nothing but
 * folders, files and links, no file has a set-id bit, the executable is there, executable and as pinned, each pinned
 * file has its checksum, every licence notice the pin names is present with its checksum, which are named when they
 * are not, and the whole build reads as the pinned tree when the pin has one.
 *
 * @example await checkUnpacked(pin, '/…/electron-44.5.1-mac-arm64.staging-4242/build')
 */
export async function checkUnpacked(pin: ArchivePin, root: string): Promise<Checked> {
  // Links an archive holds are made by the unpacking tool as they were packed, so one leading out would let the build
  // reach files that are not its own; a FIFO would stall every later read of the build, and a set-id file would run as
  // someone else.
  const tree = await scanTree(root)
  if (tree.leaving.length > 0) return { ok: false, message: `The archive holds links that lead outside the build: ${tree.leaving.slice(0, 5).join(', ')}.` }
  const unsafe = describeTreeProblems(tree, 'The archive')
  if (unsafe !== undefined) return { ok: false, message: unsafe }
  const executable = join(root, pin.executable.path)
  const executableReading = await readFileSha256(executable)
  if (executableReading.kind === 'missing') return { ok: false, message: `The archive holds no ${pin.executable.path}.` }
  if (executableReading.kind === 'other') return { ok: false, message: executableReading.problem }
  const executableSha256 = executableReading.sha256
  if (pin.executable.sha256 !== undefined && executableSha256 !== pin.executable.sha256) return { ok: false, message: `${pin.executable.path} has SHA-256 ${executableSha256}, not the pinned ${pin.executable.sha256}.` }
  if (!(await access(executable, constants.X_OK).then(() => true, () => false))) return { ok: false, message: `${pin.executable.path} is not executable.` }
  for (const file of pin.files) {
    const sha256 = await fileSha256(join(root, file.path)).catch(() => undefined)
    if (sha256 !== file.sha256) return { ok: false, message: `${file.path} is ${sha256 === undefined ? 'missing' : `there with SHA-256 ${sha256}`}, and the pin needs SHA-256 ${file.sha256}: ${file.why}.` }
  }
  if (!pin.licences.inspected) return { ok: false, message: pin.licences.reason }
  const licences = await readLicences(root, pin.licences.files)
  const absent = licences.filter((reading) => reading.state !== 'present')
  if (absent.length > 0) {
    const named = absent.map((reading) => `${reading.file.path} (${reading.file.title}, ${describeAbsence(reading)})`).join('; ')
    return { ok: false, message: `The build lacks licence notices it must carry: ${named}. Retest does not install a build without them.`, missing: absent.map((reading) => ({ path: reading.file.path, title: `${reading.file.title}, ${reading.state === 'changed' ? 'changed' : reading.state === 'missing' ? 'missing' : 'not a file'}` })) }
  }
  const treeSha256 = await folderChecksum(root)
  if (pin.treeSha256 !== undefined && treeSha256 !== pin.treeSha256) return { ok: false, message: `The unpacked build reads as ${treeSha256}, not the pinned ${pin.treeSha256}.` }
  return { ok: true, executableSha256, licences, treeSha256 }
}

function describeAbsence(reading: LicenceReading): string {
  if (reading.state === 'changed') return `SHA-256 ${reading.sha256 ?? ''}, not the pinned ${reading.file.sha256 ?? ''}`
  return reading.state === 'missing' ? 'missing' : (reading.problem ?? 'not a file')
}

// Staging folders of installs whose process is gone are removed; one whose process still runs is left to it.
async function sweepStaging(folder: string): Promise<void> {
  const parent = dirname(folder)
  const prefix = `${basename(folder)}${stagingMark}`
  const names = await readdir(parent).catch((error: unknown) => (isMissingFile(error) ? [] : Promise.reject(error)))
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const pid = Number(name.slice(prefix.length))
    if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && mayStillRun(pid)) continue
    await rm(join(parent, name), { recursive: true, force: true })
  }
}

function refused(message: string): InstallResult & { ok: false } {
  return { ok: false, message, stopped: false }
}

/** @example formatBytes(130_259_261) // '124.2 MiB' */
export function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}
