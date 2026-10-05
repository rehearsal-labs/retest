import type { Failure } from '../../protocol/failures.ts'
import { constants } from 'node:fs'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { errorMessage } from '../../protocol/failures.ts'
import { isMissingFile } from '../../shared/error-code.ts'
import { readMetadataProcess } from '../../shared/metadata-process.ts'
import { sha256Hex } from '../../shared/sha256.ts'
import { LaunchError } from '../contract.ts'

/**
 * The WebKit build this driver was written and run against: Playwright's automation build, which speaks WebKit's
 * inspector protocol plus its own `Playwright` domain over `--inspector-pipe`. The protocol belongs to the build, so the
 * driver refuses a build whose `protocol.json` is not this one, whatever its folder is called.
 */
export type WebKitPin = {
  readonly revision: string
  readonly playwrightVersion: string
  readonly hostPlatform: string
  readonly protocolSha256: string
}

export const webKitPin: WebKitPin = {
  revision: '2359',
  playwrightVersion: '1.63.0',
  hostPlatform: 'mac26-arm64',
  protocolSha256: '5962bc790bde7750ce127029962a6c1bd93aed884cbcf832da8393c2a12c106c',
}

/** The environment variable that names an unpacked build when the target names none. */
export const webKitBuildVariable: string = 'RETEST_WEBKIT_BUILD'

/**
 * An unpacked macOS WebKit build. `directory` is absolute with its links resolved and no trailing separator, so it
 * compares with the paths `ps` prints. `revision` comes from a folder named `webkit-<revision>`, as Playwright's
 * installer names it, and is undefined for any other name. `version` is `WebKit.framework`'s own bundle version: the
 * user agent states none.
 */
export type WebKitBuild = {
  readonly directory: string
  readonly executable: string
  readonly protocolSha256: string
  readonly revision: string | undefined
  readonly version: string
}

/** Where a build is to be found, and what named it: the target's `executablePath` or the environment variable. */
export type WebKitBuildPath = { ok: true; path: string; source: string } | { ok: false; failure: Failure }

/**
 * The path a WebKit target names: its `executablePath`, or `RETEST_WEBKIT_BUILD`. Either may name the unpacked build's
 * folder or the executable inside it. Retest looks nowhere else: a build another tool installed is used only when
 * a path names it.
 *
 * @example webKitBuildPath({}, { RETEST_WEBKIT_BUILD: '/cache/webkit-2359' }) // { ok: true, path: '/cache/webkit-2359', source: 'RETEST_WEBKIT_BUILD' }
 */
export function webKitBuildPath(target: { readonly executablePath?: string | undefined }, environment: Readonly<Record<string, string | undefined>>): WebKitBuildPath {
  if (target.executablePath !== undefined) return { ok: true, path: target.executablePath, source: 'executablePath' }
  const configured = environment[webKitBuildVariable]
  if (configured !== undefined && configured !== '') return { ok: true, path: configured, source: webKitBuildVariable }
  const message = `A WebKit target needs a build. Give its executablePath, or set ${webKitBuildVariable}, to an unpacked Playwright WebKit build ${webKitPin.revision}, the folder or the executable inside it.`
  return { ok: false, failure: { class: 'setup_failed', message } }
}

/**
 * The build folder a path names: the folder itself, or the one that holds `Playwright.app` when the path names the
 * executable inside it.
 *
 * @example buildFolderOf('/cache/webkit-2359/Playwright.app/Contents/MacOS/Playwright') // '/cache/webkit-2359'
 */
export function buildFolderOf(path: string): string {
  const absolute = resolve(path)
  const parts = ['Playwright.app', 'Contents', 'MacOS', 'Playwright']
  let folder = absolute
  for (const part of [...parts].reverse()) {
    if (basename(folder) !== part) return absolute
    folder = dirname(folder)
  }
  return folder
}

/**
 * The revision in a folder named `webkit-<revision>`.
 *
 * @example readRevision('/cache/ms-playwright/webkit-2359') // '2359'
 */
export function readRevision(directory: string): string | undefined {
  return /^webkit-(\d+)$/.exec(basename(directory))?.[1]
}

/**
 * Checks the build a path names and reads what it is: its executable, the sha256 of its `protocol.json`, its revision
 * and its WebKit version. A build on another host than macOS, a folder that is not a build, and a build whose
 * protocol is not the pinned one each fail with a `LaunchError` that says so and how to fix it.
 *
 * @example const build = await findWebKitBuild('/cache/webkit-2359', 'RETEST_WEBKIT_BUILD')
 */
export async function findWebKitBuild(path: string, source: string, platform: NodeJS.Platform = process.platform): Promise<WebKitBuild> {
  if (platform !== 'darwin') {
    throw new LaunchError(`Retest runs WebKit on macOS only, and this host is ${platform}.`, { failureClass: 'setup_failed' })
  }
  const named = buildFolderOf(path)
  const fix = `Give ${source} the folder of an unpacked Playwright WebKit build ${webKitPin.revision} for ${webKitPin.hostPlatform}, or the executable inside it.`
  const directory = await realpath(named).catch((error: unknown) => {
    const reason = isMissingFile(error) ? 'nothing is there' : errorMessage(error)
    throw new LaunchError(`No WebKit build at ${named}, the path ${source} gives: ${reason}. ${fix}`, { cause: error })
  })
  const folder = await stat(directory)
  if (!folder.isDirectory()) throw new LaunchError(`${directory}, the path ${source} gives, is not a build folder. ${fix}`)
  const executable = join(directory, 'Playwright.app', 'Contents', 'MacOS', 'Playwright')
  await access(executable, constants.X_OK).catch((error: unknown) => {
    throw new LaunchError(`${directory} holds no WebKit build: ${executable} is missing or may not run. ${fix}`, { cause: error })
  })
  const protocol = await readFile(join(directory, 'protocol.json')).catch((error: unknown) => {
    throw new LaunchError(`The WebKit build at ${directory} has no readable protocol.json. ${fix}`, { cause: error })
  })
  const protocolSha256 = sha256Hex(protocol)
  if (protocolSha256 !== webKitPin.protocolSha256) {
    throw new LaunchError(
      `The WebKit build at ${directory} speaks another protocol than the one Retest's WebKit driver was written for: its protocol.json has sha256 ${protocolSha256}, and build ${webKitPin.revision}'s has ${webKitPin.protocolSha256}. ${fix}`,
    )
  }
  return { directory, executable, protocolSha256, revision: readRevision(directory), version: readWebKitVersion(directory) }
}

/**
 * The build's WebKit version, the `CFBundleVersion` of its `WebKit.framework`, such as `626.1.6+`; `unknown` when
 * the bundle does not say.
 *
 * @example readWebKitVersion('/cache/webkit-2359') // '626.1.6+'
 */
export function readWebKitVersion(directory: string): string {
  const plist = join(directory, 'WebKit.framework', 'Resources', 'Info.plist')
  try {
    const text = readMetadataProcess({ command: '/usr/bin/plutil', args: ['-extract', 'CFBundleVersion', 'raw', '-o', '-', plist], environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } })
    const version = text.trim()
    return version === '' ? 'unknown' : version
  } catch {
    // A build whose framework states no version still runs; its identity says the version is unknown.
    return 'unknown'
  }
}

/**
 * How a build names itself in a run's records: its WebKit version, and the build revision when the folder names one.
 *
 * @example describeBuildVersion({ version: '626.1.6+', revision: '2359' }) // '626.1.6+, build 2359'
 */
export function describeBuildVersion(build: Pick<WebKitBuild, 'version' | 'revision'>): string {
  return build.revision === undefined ? build.version : `${build.version}, build ${build.revision}`
}
