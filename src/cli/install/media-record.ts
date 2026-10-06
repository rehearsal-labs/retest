import type { ParseResult, Schema } from '../../protocol/schema.ts'
import type { FileIdentity, FileReadControl } from '../../shared/regular-file.ts'
import type { MediaEnvironment } from './media-tools.ts'
import type { MediaPrebuiltPin, MediaTarget } from './media-pins.ts'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cacheFolders } from '../../browser/builds.ts'
import { MEDIA_PROTOCOL_VERSION } from '../../media/protocol.ts'
import { parse, s } from '../../protocol/schema.ts'
import { errorMessage } from '../../protocol/failures.ts'
import { Deadline } from '../../protocol/deadline.ts'
import { isMissingFile } from '../../shared/error-code.ts'
import { checkFileIdentity, readFileSha256, readRecordText } from '../../shared/regular-file.ts'
import { maximumMediaBinaryBytes, maximumMediaSourceBytes, mediaPrebuiltPins, mediaSourceDigest, mediaSourceFiles, mediaTarget, mediaVersion, minimumRust } from './media-pins.ts'
import { rustAtLeast } from './media-tools.ts'

export type MediaRecord = {
  schemaVersion: 1
  version: string
  protocol: number
  sourceDigest: string
  target: MediaTarget
  method: 'source' | 'prebuilt'
  rustcVersion: string | null
  binarySha256: string
  notices: { path: string; sha256: string }[]
  installedAt: string
  installedBy: string
}
const recordSchema: Schema<MediaRecord> = s.object({ schemaVersion: s.literal(1), version: s.string(), protocol: s.number({ integer: true, min: 1 }), sourceDigest: s.string(), target: s.enum(['aarch64-apple-darwin', 'x86_64-unknown-linux-gnu']), method: s.enum(['source', 'prebuilt']), rustcVersion: s.union([s.string(), s.literal(null)]), binarySha256: s.string(), notices: s.array(s.object({ path: s.string(), sha256: s.string() })), installedAt: s.string(), installedBy: s.string() })

export type MediaInspection = {
  readonly engine: 'media'; readonly version: string; readonly protocol: number; readonly target: MediaTarget
  readonly state: 'missing' | 'installed' | 'damaged' | 'unverifiable'; readonly folder: string
  readonly executablePath: string; readonly problems: readonly string[]; readonly record?: MediaRecord
  readonly executableIdentity?: FileIdentity
}

export function mediaPackageRoot(): string { return resolve(dirname(fileURLToPath(import.meta.url)), '../../..') }
export function mediaFolder(env: MediaEnvironment, target: MediaTarget): string | undefined {
  const folders = cacheFolders(env)
  return folders === undefined ? undefined : join(dirname(folders.browsers), 'media', `media-${mediaVersion}-${target}`)
}
export function mediaLockPath(folder: string): string { return join(dirname(dirname(folder)), 'locks', `${folder.split('/').at(-1) ?? 'media'}.lock`) }

/** Hashes the pinned allowlist only. A changed, absent or non-regular source is refused before cargo runs. */
export async function checkMediaSource(root: string, options: FileReadControl = {}): Promise<string | undefined> {
  const deadline = options.deadline ?? new Deadline(15_000, { signal: options.signal })
  const hash = createHash('sha256')
  for (const file of mediaSourceFiles) {
    const path = join(root, file.path)
    const reading = await readFileSha256(path, { maximumBytes: maximumMediaSourceBytes, deadline, ...(options.signal === undefined ? {} : { signal: options.signal }) })
    if (reading.kind !== 'file') return reading.kind === 'other' ? reading.problem : `${path} is missing. Reinstall the Retest package with its media source and notices.`
    if (reading.sha256 !== file.sha256) return `${path} has SHA-256 ${reading.sha256}, not the pinned ${file.sha256}. Reinstall the Retest package; cargo was not run.`
    hash.update(`${file.path}\0${reading.sha256}\n`)
  }
  return hash.digest('hex') === mediaSourceDigest ? undefined : 'The media source manifest does not match its pinned digest. Reinstall Retest.'
}

export function mediaNoticePins(): { path: string; sha256: string }[] {
  return mediaSourceFiles.filter((file) => file.path === 'LICENSE' || file.path === 'src/cli/install/media-notices.txt').map((file) => ({ path: file.path === 'LICENSE' ? 'LICENSE' : 'THIRD-PARTY-NOTICES.txt', sha256: file.sha256 }))
}

/** Records and all named files use the installer's bounded regular-file readers. A prebuilt without a pin is never read. */
export async function inspectMedia(env: MediaEnvironment, options: FileReadControl & { readonly target?: MediaTarget; readonly pins?: readonly MediaPrebuiltPin[]; readonly verify?: boolean } = {}): Promise<MediaInspection | undefined> {
  const deadline = options.deadline ?? new Deadline(15_000, { signal: options.signal })
  const target = options.target ?? mediaTarget()
  if (target === undefined) return undefined
  const folder = mediaFolder(env, target)
  if (folder === undefined) return undefined
  const base = { engine: 'media' as const, version: mediaVersion, protocol: MEDIA_PROTOCOL_VERSION, target, folder, executablePath: join(folder, 'retest-media') }
  const bad = (problem: string, state: 'damaged' | 'unverifiable' = 'damaged'): MediaInspection => ({ ...base, state, problems: [problem] })
  try {
    const stats = await lstat(folder)
    if (!stats.isDirectory()) return bad(`${folder} is not a regular cache folder. Remove it before installing again.`)
  } catch (error) {
    return isMissingFile(error) ? { ...base, state: 'missing', problems: [] } : bad(`${folder} cannot be read: ${errorMessage(error)}`)
  }
  const path = join(folder, 'build.json')
  const read = await readRecordText(path, { deadline, ...(options.signal === undefined ? {} : { signal: options.signal }) })
  if (read.kind !== 'text') return bad(`${path} cannot be read: ${read.kind === 'missing' ? 'it is missing' : read.problem}.`)
  let parsed: ParseResult<MediaRecord>
  try { parsed = readMediaRecord(read.text) } catch { return bad(`${path} is not JSON.`) }
  if (!parsed.ok) return bad(`${path} is not a valid media build record.`)
  const record = parsed.value
  if (record.version !== mediaVersion || record.protocol !== MEDIA_PROTOCOL_VERSION || record.target !== target || record.sourceDigest !== mediaSourceDigest) return bad(`${path} names another media version, protocol, source or target.`)
  if (!/^[a-f0-9]{64}$/.test(record.binarySha256) || !Number.isFinite(Date.parse(record.installedAt)) || record.installedBy === '') return bad(`${path} has an invalid checksum or installer identity.`)
  if (record.method === 'prebuilt') {
    const pin = (options.pins ?? mediaPrebuiltPins).find((candidate) => candidate.target === target && candidate.version === record.version && candidate.protocol === record.protocol && candidate.sourceDigest === record.sourceDigest)
    if (pin === undefined) return bad(`No checksum is pinned for a prebuilt retest-media ${mediaVersion} for ${target}. Nothing in this folder was checked. Remove ${folder}; run npx retest install media to build from source.`, 'unverifiable')
    if (pin.sha256 !== record.binarySha256 || record.rustcVersion !== null) return bad(`${path} does not match the pinned prebuilt checksum or build method.`)
  } else if (record.rustcVersion === null || !rustAtLeast(record.rustcVersion, minimumRust)) return bad(`${path} names no supported rustc build version.`)
  const notices = mediaNoticePins()
  if (JSON.stringify(record.notices) !== JSON.stringify(notices)) return bad(`${path} does not name the pinned licence notices.`)
  let executableIdentity: FileIdentity | undefined
  for (const file of [{ path: 'retest-media', sha256: record.binarySha256 }, ...notices]) {
    const filePath = join(folder, file.path)
    const reading = await readFileSha256(filePath, { maximumBytes: file.path === 'retest-media' ? maximumMediaBinaryBytes : maximumMediaSourceBytes, deadline, ...(options.signal === undefined ? {} : { signal: options.signal }) })
    if (reading.kind !== 'file') return bad(reading.kind === 'missing' ? `${filePath} is missing.` : reading.problem)
    if (reading.sha256 !== file.sha256) return bad(`${filePath} has SHA-256 ${reading.sha256}, not the recorded ${file.sha256}.`)
    try {
      const stats = await lstat(filePath, { bigint: true })
      if (!stats.isFile()) return bad(`${filePath} is no longer a regular file.`)
      if (stats.dev.toString() !== reading.identity.device || stats.ino.toString() !== reading.identity.inode) return bad(`${filePath} was replaced after Retest hashed it; its file identity no longer matches.`)
      if ((stats.mode & 0o6000n) !== 0n) return bad(`${filePath} has a set-user-id or set-group-id bit.`)
      if (file.path === 'retest-media') executableIdentity = reading.identity
    } catch (error) { return bad(`${filePath} cannot be checked: ${errorMessage(error)}.`) }
  }
  if (!(await access(base.executablePath, constants.X_OK).then(() => true, () => false))) return bad(`${base.executablePath} is not executable.`)
  if (options.verify === true) {
    const allowed = new Set(['build.json', 'retest-media', ...notices.map((notice) => notice.path)])
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

function readMediaRecord(text: string): ParseResult<MediaRecord> { return parse(recordSchema, JSON.parse(text)) }
