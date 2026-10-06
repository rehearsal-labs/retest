import type { MediaEnvironment } from '../cli/install/media-tools.ts'
import type { MediaInspection } from '../cli/install/media-record.ts'
import type { Hello } from './protocol.ts'
import type { FileIdentity } from '../shared/regular-file.ts'
import { lstat, realpath } from 'node:fs/promises'
import { Deadline } from '../protocol/deadline.ts'
import { inspectMedia } from '../cli/install/media-record.ts'
import { mediaTarget } from '../cli/install/media-pins.ts'
import { findMediaTool, probeMediaBinary } from '../cli/install/media-tools.ts'
import { checkFileIdentity, describeRefusal, openRegularFile } from '../shared/regular-file.ts'

export type MediaLocationOptions = { readonly executable?: string; readonly ffmpeg?: string; readonly env?: MediaEnvironment; readonly timeoutMs?: number; readonly signal?: AbortSignal; readonly mode?: 'probe' | 'discover' }
export type LocatedMedia = { readonly ok: true; readonly executable: string; readonly executableIdentity: FileIdentity; readonly ffmpeg: string; readonly source: 'setting' | 'environment' | 'cache'; readonly inspection?: MediaInspection; readonly hello: Hello } | { readonly ok: false; readonly message: string }
export type DiscoveredMedia = Omit<Extract<LocatedMedia, { ok: true }>, 'hello'> | Extract<LocatedMedia, { ok: false }>
export type LocatedFfmpeg = { readonly ok: true; readonly path: string; readonly source: 'setting' | 'environment' | 'PATH' } | { readonly ok: false; readonly message: string }
export const ffmpegFix: string = 'Install ffmpeg with your host package manager, for example brew install ffmpeg on macOS or sudo apt-get install ffmpeg on Debian, then set RETEST_FFMPEG to its executable or put it on PATH. Retest ships and downloads no ffmpeg.'

/** An explicit setting, then RETEST_FFMPEG, then PATH. An unusable explicit name never falls through. */
export async function locateFfmpeg(options: Pick<MediaLocationOptions, 'ffmpeg' | 'env'> = {}): Promise<LocatedFfmpeg> {
  const env = options.env ?? process.env
  const given = options.ffmpeg ?? env['RETEST_FFMPEG']
  const name = given ?? 'ffmpeg'
  const path = name === '' ? undefined : await findMediaTool(name, env)
  if (path === undefined) return { ok: false, message: `ffmpeg is a declared recording prerequisite and no executable was found ${given === undefined ? 'on PATH' : 'at the explicit setting or RETEST_FFMPEG'}. ${ffmpegFix}` }
  return { ok: true, path, source: options.ffmpeg !== undefined ? 'setting' : env['RETEST_FFMPEG'] !== undefined ? 'environment' : 'PATH' }
}

/** Call only when recording is requested. No Cargo target directory is searched and nothing is installed. */
export function locateMedia(options: MediaLocationOptions & { readonly mode: 'discover' }): Promise<DiscoveredMedia>
export function locateMedia(options?: MediaLocationOptions & { readonly mode?: 'probe' }): Promise<LocatedMedia>
export async function locateMedia(options: MediaLocationOptions = {}): Promise<LocatedMedia | DiscoveredMedia> {
  const controller = new AbortController()
  const signal = options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal])
  const deadline = new Deadline(options.timeoutMs ?? 15_000, { signal })
  const stopped = Promise.withResolvers<Extract<DiscoveredMedia, { ok: false }>>()
  const stop = (): void => stopped.resolve({ ok: false, message: options.signal?.aborted === true ? 'Media discovery was stopped.' : 'Media discovery exceeded its deadline.' })
  signal.addEventListener('abort', stop, { once: true })
  const timer = setTimeout(() => controller.abort(), deadline.waitToEndMs)
  let found: DiscoveredMedia
  try {
    if (signal.aborted) stop()
    found = await Promise.race([discoverLocation(options, deadline), stopped.promise])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
  }
  if (!found.ok || options.mode === 'discover') return found
  if (signal.aborted || deadline.reached) return { ok: false, message: 'Media discovery was stopped or exceeded its deadline before the probe.' }
  const target = mediaTarget()
  if (target === undefined) return { ok: false, message: 'Media discovery has no pinned host target.' }
  const probe = await probeMediaBinary(found.executable, found.ffmpeg, target, deadline.commandTimeoutMs)
  if (!probe.ok) return probe
  const afterProbe = await checkFileIdentity(found.executable, found.executableIdentity)
  if (afterProbe !== undefined) return { ok: false, message: `${afterProbe} Run npx retest install media.` }
  return { ...found, hello: probe.hello }
}

async function discoverLocation(options: MediaLocationOptions, deadline: Deadline): Promise<DiscoveredMedia> {
  const interrupted = (): boolean => deadline.signal?.aborted === true || deadline.reached
  const stopped = (): DiscoveredMedia => ({ ok: false, message: 'Media discovery was stopped or exceeded its deadline.' })
  if (interrupted()) return stopped()
  const env = options.env ?? process.env
  const target = mediaTarget()
  if (target === undefined) return { ok: false, message: `Media discovery has no host target for ${process.platform} ${process.arch}. macOS arm64 is exercised; Linux x64 is unverified.` }
  const given = options.executable ?? env['RETEST_MEDIA_BINARY']
  let executable: string
  let source: 'setting' | 'environment' | 'cache'
  let inspection: MediaInspection | undefined
  let identity: FileIdentity | undefined
  if (given !== undefined) {
    const found = given === '' ? undefined : await findMediaTool(given, env)
    if (found === undefined) return { ok: false, message: 'The explicit media setting or RETEST_MEDIA_BINARY does not name an executable. Run npx retest install media, or name a matching release binary.' }
    executable = found
    source = options.executable === undefined ? 'environment' : 'setting'
    // A path into this cache must still pass its record. An explicit path cannot bypass a damaged cache.
    inspection = await inspectMedia(env, { deadline })
    if (interrupted()) return stopped()
    const canonical = await realpath(executable).catch(() => undefined)
    if (canonical === undefined) return { ok: false, message: `${executable} disappeared or cannot be read after discovery. Run npx retest install media, or name a readable release binary.` }
    const cachedFolder = inspection === undefined ? undefined : await realpath(inspection.folder).catch(() => undefined)
    const fromCache = inspection !== undefined && (executable === inspection.executablePath || executable.startsWith(`${inspection.folder}/`) || (cachedFolder !== undefined && canonical.startsWith(`${cachedFolder}/`)))
    if (fromCache && inspection !== undefined && inspection.state !== 'installed') return { ok: false, message: `${inspection.problems.join(' ')} Remove ${inspection.folder} and run npx retest install media.` }
    if (!fromCache) inspection = undefined
    const leaf = await lstat(executable).catch(() => undefined)
    if (leaf === undefined) return { ok: false, message: `${executable} disappeared during discovery.` }
    // Preserve an ordinary explicit pathname; a leaf alias executes the canonical file whose identity is checked.
    if (leaf.isSymbolicLink()) executable = canonical
  } else {
    inspection = await inspectMedia(env, { deadline })
    if (interrupted()) return stopped()
    if (inspection === undefined || inspection.state === 'missing') return { ok: false, message: 'No retest-media binary is installed. Run npx retest install media. For an explicit developer build set RETEST_MEDIA_BINARY; Cargo target folders are never searched.' }
    if (inspection.state !== 'installed') return { ok: false, message: `${inspection.problems.join(' ')} Remove ${inspection.folder} and run npx retest install media.` }
    executable = inspection.executablePath
    source = 'cache'
  }
  identity = inspection?.executableIdentity
  if (inspection !== undefined && identity === undefined) return { ok: false, message: `${executable} is damaged: inspection returned no hashed file identity. Run npx retest install media.` }
  if (identity === undefined) {
    const opened = await openRegularFile(executable)
    if (opened.kind !== 'opened') return { ok: false, message: opened.kind === 'missing' ? `${executable} disappeared during discovery.` : `${describeRefusal(opened, executable)}.` }
    identity = opened.identity
    await opened.handle.close()
  }
  if (interrupted()) return stopped()
  const ffmpeg = await locateFfmpeg(options)
  if (interrupted()) return stopped()
  if (!ffmpeg.ok) return ffmpeg
  const changed = await checkFileIdentity(executable, identity)
  if (changed !== undefined) return { ok: false, message: `${changed} Run npx retest install media.` }
  if (interrupted()) return stopped()
  return { ok: true, executable, executableIdentity: identity, ffmpeg: ffmpeg.path, source, ...(inspection === undefined ? {} : { inspection }) }
}
