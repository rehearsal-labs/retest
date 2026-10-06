import type { MediaEnvironment, MediaToolRunner } from './media-tools.ts'
import type { MediaInspection, MediaRecord } from './media-record.ts'
import type { MediaPrebuiltPin, MediaTarget } from './media-pins.ts'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { MEDIA_PROTOCOL_VERSION } from '../../media/protocol.ts'
import { describeCommand } from '../../native/processes.ts'
import { errorMessage } from '../../protocol/failures.ts'
import { Deadline } from '../../protocol/deadline.ts'
import { openRegularFile, readFileSha256, readRecordText } from '../../shared/regular-file.ts'
import { downloadFile, mirroredUrl } from './download.ts'
import { takeInstallLock } from './lock.ts'
import { checkMediaSource, inspectMedia, mediaFolder, mediaLockPath, mediaNoticePins, mediaPackageRoot } from './media-record.ts'
import { maximumMediaBinaryBytes, mediaPrebuiltPins, mediaSourceDigest, mediaSourceFiles, mediaTarget, mediaVersion } from './media-pins.ts'
import { probeMediaBinary, readRustTools, runMediaTool } from './media-tools.ts'
import { mirrorProblem } from './report.ts'

export type MediaInstallOptions = {
  readonly env: MediaEnvironment; readonly signal: AbortSignal; readonly version: string; readonly report: (line: string) => void
  readonly binary?: string | undefined; readonly mirror?: string | undefined; readonly offline?: boolean
  readonly packageRoot?: string; readonly pins?: readonly MediaPrebuiltPin[]; readonly target?: MediaTarget; readonly run?: MediaToolRunner
}
export type MediaInstallResult = { readonly ok: true; readonly action: 'installed' | 'already_installed'; readonly inspection: MediaInspection } | { readonly ok: false; readonly message: string; readonly stopped: boolean }

/** Explicit source build or exactly pinned prebuilt. Uses the current install lock and never repairs a damaged cache. */
export async function installMedia(options: MediaInstallOptions): Promise<MediaInstallResult> {
  const refuse = (message: string): MediaInstallResult => ({ ok: false, message, stopped: options.signal.aborted })
  const target = options.target ?? mediaTarget()
  if (target === undefined) return refuse(`No media build path for ${process.platform} ${process.arch}. macOS arm64 is exercised; Linux x64 is planned and unverified.`)
  const pins = options.pins ?? mediaPrebuiltPins
  const prebuilt = options.binary !== undefined || options.mirror !== undefined
  const pin = prebuilt ? pins.find((candidate) => candidate.target === target && candidate.version === mediaVersion && candidate.protocol === MEDIA_PROTOCOL_VERSION && candidate.sourceDigest === mediaSourceDigest) : undefined
  if (prebuilt && (pin === undefined || !/^[a-f0-9]{64}$/.test(pin.sha256) || !Number.isSafeInteger(pin.size) || pin.size <= 0 || pin.size > maximumMediaBinaryBytes)) return refuse(`No checksum is pinned for a prebuilt retest-media ${mediaVersion} protocol ${MEDIA_PROTOCOL_VERSION} for ${target}. Nothing was read or downloaded. Run npx retest install media to build from source.`)
  if (options.binary !== undefined && options.mirror !== undefined) return refuse('Choose one prebuilt source: --media-binary or --media-mirror.')
  if (options.mirror !== undefined) {
    const problem = mirrorProblem(options.mirror)
    if (problem !== undefined) return refuse(problem)
  }
  const folder = mediaFolder(options.env, target)
  if (folder === undefined) return refuse('HOME is not an absolute folder, so Retest has no media cache. Set HOME and run npx retest install media.')
  const root = options.packageRoot ?? mediaPackageRoot()
  const sourceProblem = await checkMediaSource(root, { signal: options.signal })
  if (sourceProblem !== undefined) return refuse(sourceProblem)
  const lock = await takeInstallLock(mediaLockPath(folder), { signal: options.signal })
  if (!lock.ok) return { ok: false, message: lock.message, stopped: lock.stopped === true }
  let result: MediaInstallResult
  let cleanupProblem: string | undefined
  const staging = `${folder}.staging-${process.pid}-${randomUUID()}`
  try {
    result = await installLocked(options, target, folder, root, staging, pin)
  } catch (error) { result = refuse(`Media install failed: ${errorMessage(error)} Nothing was installed.`) }
  finally {
    try { await rm(staging, { recursive: true, force: true }) }
    catch (error) { cleanupProblem = `Media staging cleanup failed at ${staging}: ${errorMessage(error)}.` }
    finally {
      const problem = await lock.release()
      if (problem !== undefined) options.report(problem)
    }
  }
  if (cleanupProblem !== undefined) return result.ok
    ? refuse(`The media binary ${result.action === 'installed' ? 'was installed' : 'was already installed'}, but cleanup is not proven. ${cleanupProblem}`)
    : { ...result, message: `${result.message} ${cleanupProblem}` }
  return result
}

async function installLocked(options: MediaInstallOptions, target: MediaTarget, folder: string, root: string, staging: string, pin: MediaPrebuiltPin | undefined): Promise<MediaInstallResult> {
  const refuse = (message: string): MediaInstallResult => ({ ok: false, message, stopped: options.signal.aborted })
  const before = await inspectMedia(options.env, { target, pins: options.pins ?? mediaPrebuiltPins, verify: true, signal: options.signal })
  if (before?.state === 'installed') return { ok: true, action: 'already_installed', inspection: before }
  if (before !== undefined && before.state !== 'missing') return refuse(`${before.problems.join(' ')} Remove ${folder} and run npx retest install media again.`)
  if (options.signal.aborted) return refuse('Media install was stopped before it built or copied anything.')
  let rustcVersion: string | null = null
  await mkdir(staging, { recursive: true })
  const executable = join(staging, 'retest-media')
  if (pin === undefined) {
    const run = options.run ?? runMediaTool
    const tools = await readRustTools(options.env, options.signal, run)
    if (!tools.ok) return refuse(tools.message)
    if (tools.target !== target) return refuse(`rustc targets ${tools.target}, expected the host ${target}. Select the matching Rust host toolchain, then run npx retest install media.`)
    rustcVersion = tools.rustcVersion
    const source = join(staging, 'source')
    for (const file of mediaSourceFiles) {
      const from = join(root, file.path)
      const to = join(source, file.path)
      const reading = await readRecordText(from)
      if (reading.kind !== 'text') return refuse(`${from} cannot be copied: ${reading.kind === 'missing' ? 'missing' : reading.problem}.`)
      await mkdir(dirname(to), { recursive: true })
      await writeFile(to, reading.text, { flag: 'wx' })
    }
    const copiedProblem = await checkMediaSource(source, { signal: options.signal })
    if (copiedProblem !== undefined) return refuse(copiedProblem)
    const targetDir = join(staging, 'target')
    const args = ['build', '--release', '--locked', ...(options.offline === true ? ['--offline'] : []), '--manifest-path', join(source, 'media', 'Cargo.toml'), '--target', target, '--target-dir', targetDir]
    options.report(`Building retest-media ${mediaVersion} with ${tools.rustcVersion}; Cargo.lock is pinned. ffmpeg is a separate host prerequisite.`)
    const built = await run(tools.cargo, args, { env: options.env, signal: options.signal, cwd: source, timeoutMs: 30 * 60_000, environment: { RUSTC: tools.rustc, CARGO_TARGET_DIR: targetDir } })
    const afterProblem = await checkMediaSource(source, { signal: options.signal })
    if (afterProblem !== undefined) return refuse(`The build changed the pinned source or Cargo.lock. ${afterProblem}`)
    if (built.code !== 0 || built.stopped || built.timedOut || built.cleanupProblems.length > 0) return refuse(`${describeCommand('cargo build --release --locked', built)}. Nothing was installed.`)
    const placed = await copyRegularBinary(join(targetDir, target, 'release', 'retest-media'), executable)
    if (placed !== undefined) return refuse(placed)
    await rm(source, { recursive: true })
    await rm(targetDir, { recursive: true })
  } else {
    if (options.binary !== undefined) {
      const copied = await copyRegularBinary(options.binary, executable, pin.size)
      if (copied !== undefined) return refuse(copied)
    } else {
      const downloaded = await downloadFile({ url: mirroredUrl(pin.url, options.mirror), to: executable, expectedSize: pin.size, maximumBytes: pin.size, signal: options.signal, idleMs: 60_000, totalMs: 60 * 60_000, userAgent: `retest/${options.version}` })
      if (!downloaded.ok) return { ok: false, message: downloaded.message, stopped: downloaded.stopped }
    }
    const hash = await readFileSha256(executable, { maximumBytes: pin.size, deadline: new Deadline(15_000, { signal: options.signal }) })
    if (hash.kind === 'other') return refuse(hash.problem)
    if (hash.kind !== 'file' || hash.sha256 !== pin.sha256) return refuse('The media prebuilt binary does not match its pinned SHA-256. It was deleted without being executed and nothing was installed.')
  }
  if (options.signal.aborted) return refuse('Media install was stopped before the binary probe. Nothing was installed.')
  await chmod(executable, 0o755)
  const probe = await probeMediaBinary(executable, '/usr/bin/false', target)
  if (!probe.ok) return refuse(probe.message)
  if (options.signal.aborted) return refuse('Media install was stopped after its build. Nothing was installed.')
  const hash = await readFileSha256(executable, { maximumBytes: maximumMediaBinaryBytes, deadline: new Deadline(15_000, { signal: options.signal }) })
  if (hash.kind === 'other') return refuse(hash.problem)
  if (hash.kind !== 'file') return refuse('The built media binary cannot be checked as a regular file.')
  for (const file of mediaSourceFiles.filter((file) => file.path === 'LICENSE' || file.path === 'src/cli/install/media-notices.txt')) {
    const read = await readRecordText(join(root, file.path))
    if (read.kind !== 'text') return refuse(`The pinned licence ${file.path} cannot be read.`)
    await writeFile(join(staging, file.path === 'LICENSE' ? 'LICENSE' : 'THIRD-PARTY-NOTICES.txt'), read.text, { flag: 'wx' })
  }
  const sourceProblem = await checkMediaSource(root, { signal: options.signal })
  if (sourceProblem !== undefined) return refuse(sourceProblem)
  const record: MediaRecord = { schemaVersion: 1, version: mediaVersion, protocol: MEDIA_PROTOCOL_VERSION, sourceDigest: mediaSourceDigest, target, method: pin === undefined ? 'source' : 'prebuilt', rustcVersion, binarySha256: hash.sha256, notices: mediaNoticePins(), installedAt: new Date().toISOString(), installedBy: options.version }
  await writeFile(join(staging, 'build.json'), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
  await rename(staging, folder)
  const after = await inspectMedia(options.env, { target, pins: options.pins ?? mediaPrebuiltPins, verify: true, signal: options.signal })
  return after?.state === 'installed' ? { ok: true, action: 'installed', inspection: after } : refuse(`The media folder did not read as installed: ${after?.problems.join(' ') ?? 'no cache'}.`)
}

async function copyRegularBinary(from: string, to: string, expectedSize?: number): Promise<string | undefined> {
  const opened = await openRegularFile(from)
  if (opened.kind !== 'opened') return `${from} is not a readable regular media binary: ${opened.kind}.`
  try {
    if (opened.size > maximumMediaBinaryBytes || (expectedSize !== undefined && opened.size !== expectedSize)) return `${from} does not have the pinned or bounded binary size.`
    // Bounded read from the checked descriptor, including one byte for a file growing during the read.
    const bytes = Buffer.alloc(opened.size + 1)
    let filled = 0
    while (filled < bytes.length) {
      const read = await opened.handle.read(bytes, filled, bytes.length - filled, null)
      if (read.bytesRead === 0) break
      filled += read.bytesRead
    }
    if (filled !== opened.size) return `${from} changed size while it was copied.`
    await writeFile(to, bytes.subarray(0, filled), { flag: 'wx', mode: 0o755 })
    return undefined
  } finally { await opened.handle.close() }
}
