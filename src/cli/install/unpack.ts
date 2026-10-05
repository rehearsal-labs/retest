import type { ArchiveFormat } from '../../browser/builds.ts'
import { lstat, mkdtemp, realpath, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { describeCommand, runCommand } from '../../native/processes.ts'
import { isMissingFile } from '../../shared/error-code.ts'

// Unpacks an archive whose checksum was already verified, with the system's own tools: ditto on macOS, unzip on Linux,
// and hdiutil for a macOS disk image. Nothing is unpacked before its bytes match the pin.

/** The tools that unpack archives, by absolute path. */
export type UnpackTools = { readonly ditto: string; readonly unzip: string; readonly hdiutil: string }

export const systemUnpackTools: UnpackTools = { ditto: '/usr/bin/ditto', unzip: '/usr/bin/unzip', hdiutil: '/usr/bin/hdiutil' }

/** What `unpackArchive` needs: the verified archive, how it is packed, an empty folder to unpack into, and the host. */
export type UnpackRequest = {
  readonly archive: string
  readonly format: ArchiveFormat
  readonly into: string
  readonly platform: NodeJS.Platform
  readonly tools: UnpackTools
  readonly signal: AbortSignal
  readonly timeoutMs: number
}

/**
 * Unpacks a verified archive into an empty folder, and returns why it could not, or undefined once it has. A zip is
 * unpacked whole, keeping its links and modes; from a disk image, only the app bundle the pin names is copied, and the
 * image is detached again whatever happened.
 *
 * @example await unpackArchive({ archive, format: { format: 'zip' }, into, platform: 'darwin', tools: systemUnpackTools, signal, timeoutMs: 600_000 })
 */
export async function unpackArchive(request: UnpackRequest): Promise<string | undefined> {
  if (request.format.format === 'dmg') return request.platform === 'darwin' ? copyFromDiskImage(request, request.format.app) : 'A disk image is unpacked only on macOS.'
  if (request.platform === 'darwin') return run(request.tools.ditto, ['-x', '-k', request.archive, request.into], request, 'ditto')
  if (!(await exists(request.tools.unzip))) return `Unpacking a zip on Linux needs unzip at ${request.tools.unzip}. Install it, for example with apt-get install unzip, and run the install again.`
  return run(request.tools.unzip, ['-q', request.archive, '-d', request.into], request, 'unzip')
}

async function copyFromDiskImage(request: UnpackRequest, app: string): Promise<string | undefined> {
  const mountPoint = await mkdtemp(join(tmpdir(), 'retest-install-image-'))
  // -nobrowse keeps the image out of Finder; with no input, an image that asks for a licence agreement fails rather
  // than waiting for an answer.
  const attached = await runCommand(request.tools.hdiutil, ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mountPoint, request.archive], { timeoutMs: request.timeoutMs, signal: request.signal })
  if (attached.code !== 0) {
    // hdiutil hands the attach to a system helper that outlives it, so an attach Retest ended for its time or a stop
    // can still finish after hdiutil is gone. Whatever the helper attached from this archive is detached again.
    const left = await detachLeftAttach(request, mountPoint, attached.timedOut || attached.stopped ? leftAttachWaitMs : 0)
    if (left === undefined) await rmdir(mountPoint).catch(() => undefined)
    return `The disk image could not be attached: ${describeCommand('hdiutil attach', attached)}.${left === undefined ? '' : ` ${left}`}`
  }
  let problem: string | undefined
  try {
    const source = join(mountPoint, app)
    if (!(await exists(source))) problem = `The disk image holds no ${app}.`
    else problem = await run(request.tools.ditto, [source, join(request.into, app)], request, 'ditto')
  } finally {
    const detached = await detach(request, mountPoint)
    if (detached === undefined) await rmdir(mountPoint).catch(() => undefined)
    else problem = problem === undefined ? detached : `${problem} ${detached}`
  }
  return problem
}

// A detach the volume refuses because something still reads it is tried once more with -force. The mount point is
// removed only once nothing is mounted on it, and only if it is empty. `target` is the mount point, or the device of
// an image attached without one.
async function detach(request: UnpackRequest, target: string): Promise<string | undefined> {
  const options = { timeoutMs: 60_000 }
  const first = await runCommand(request.tools.hdiutil, ['detach', target], options)
  if (first.code === 0) return undefined
  const forced = await runCommand(request.tools.hdiutil, ['detach', '-force', target], options)
  if (forced.code === 0) return undefined
  return `The disk image is still attached at ${target}: ${describeCommand('hdiutil detach -force', forced)}. Detach it with hdiutil detach ${target}.`
}

/** How long a stopped or timed-out attach is watched for the system helper finishing it after hdiutil is gone. */
const leftAttachWaitMs = 2000

// After a failed attach, the images `hdiutil info` lists as mounted on this mount point, or as attached from this
// archive with nothing mounted yet, are detached by their device. One mounted anywhere else is not this install's and
// is left alone. A stopped or timed-out attach is watched for `waitMs`, since its helper may still be at work.
async function detachLeftAttach(request: UnpackRequest, mountPoint: string, waitMs: number): Promise<string | undefined> {
  const names = { images: await bothForms(request.archive), mountPoints: await bothForms(mountPoint) }
  const deadline = Date.now() + waitMs
  for (;;) {
    const info = await runCommand(request.tools.hdiutil, ['info'], { timeoutMs: 60_000 })
    if (info.code !== 0) return `Retest could not read whether the image is still attached: ${describeCommand('hdiutil info', info)}. If hdiutil info lists ${request.archive}, detach it with hdiutil detach.`
    const devices = attachedDevices(info.stdout, names)
    if (devices.length > 0) return detachAll(request, devices)
    if (Date.now() >= deadline) return undefined
    await sleep(250)
  }
}

async function detachAll(request: UnpackRequest, devices: readonly string[]): Promise<string | undefined> {
  const problems: string[] = []
  for (const device of devices) {
    const problem = await detach(request, device)
    if (problem !== undefined) problems.push(problem)
  }
  return problems.length === 0 ? undefined : problems.join(' ')
}

/**
 * The whole-disk devices `hdiutil info` lists for images mounted on one of `mountPoints`, or attached from one of
 * `images` with no mount point at all. An image mounted elsewhere is not counted.
 *
 * @example attachedDevices(text, { images: ['/…/Firefox 133.0.3.dmg'], mountPoints: ['/private/var/…/retest-install-image-a1b2'] }) // ['/dev/disk6']
 */
export function attachedDevices(info: string, names: { readonly images: readonly string[]; readonly mountPoints: readonly string[] }): string[] {
  const devices: string[] = []
  for (const block of info.split(/^=+$/m)) {
    const image = /^image-path\s*:\s*(.+)$/m.exec(block)?.[1]?.trim()
    const entries = block.split('\n').filter((line) => line.startsWith('/dev/')).map((line) => line.split('\t').map((field) => field.trim()))
    const whole = entries[0]?.[0]
    if (whole === undefined) continue
    const mounted = entries.map((fields) => fields[2] ?? '').filter((point) => point !== '')
    const ours = mounted.some((point) => names.mountPoints.includes(point)) || (mounted.length === 0 && image !== undefined && names.images.includes(image))
    if (ours) devices.push(whole)
  }
  return devices
}

// A path as given and as the system resolves it, which is how hdiutil lists it: /tmp is /private/tmp on macOS.
async function bothForms(path: string): Promise<string[]> {
  const real = await realpath(path).catch(() => path)
  return real === path ? [path] : [path, real]
}

async function run(tool: string, args: readonly string[], request: UnpackRequest, name: string): Promise<string | undefined> {
  const result = await runCommand(tool, args, { timeoutMs: request.timeoutMs, signal: request.signal })
  return result.code === 0 ? undefined : `Unpacking the archive failed: ${describeCommand(name, result)}.`
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: unknown) => !isMissingFile(error))
}
