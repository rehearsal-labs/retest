import type { LoadedFirefoxTarget } from '../../config/loaded.ts'
import type { Failure } from '../../protocol/failures.ts'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { findPin, installedBuild } from '../builds.ts'

/** Where Firefox installs on macOS, which a target without an executable path, and no installed pinned build, uses. */
export const defaultFirefoxPath = '/Applications/Firefox.app/Contents/MacOS/firefox'

/** The Firefox build a binary's files state: its version and build id, from the app's `application.ini`. */
export type FirefoxRelease = { version: string; buildId: string | undefined }

/**
 * The Firefox release the driver is tested with, from the pinned build: the facts the driver encodes (fields its
 * accessibility locator leaves out, role names, what its BiDi lacks) are this release's.
 *
 * @example testedFirefox() // { version: '133.0.3', buildId: '20241209150345' }
 */
export function testedFirefox(): FirefoxRelease {
  const pin = findPin('firefox', 'mac-arm64')
  if (pin === undefined) throw new Error('Retest pins no Firefox build for macOS on Apple silicon.')
  return { version: pin.version, buildId: pin.kind === 'archive' ? pin.build : undefined }
}

/**
 * What a Firefox's own files say against the tested release: undefined when it is the tested release, and otherwise a
 * sentence naming both, for `doctor` and a run's record to say of a Firefox a target named itself.
 *
 * @example untestedFirefox({ version: '150.0', buildId: '20260901000000' }) // 'Firefox 150.0 build 20260901000000 is not the tested Firefox 133.0.3 build 20241209150345.'
 */
export function untestedFirefox(release: FirefoxRelease | undefined, tested: FirefoxRelease = testedFirefox()): string | undefined {
  if (release !== undefined && release.version === tested.version && (tested.buildId === undefined || release.buildId === tested.buildId)) return undefined
  return `${release === undefined ? 'A Firefox whose files name no release' : `Firefox ${describeRelease(release)}`} is not the tested Firefox ${describeRelease(tested)}.`
}

function describeRelease({ version, buildId }: FirefoxRelease): string {
  return buildId === undefined ? version : `${version} build ${buildId}`
}

/**
 * Whether this machine is one Retest runs Firefox on: macOS on Apple silicon, the one platform the Firefox driver was
 * exercised on. Any other is refused by name rather than tried.
 *
 * @example firefoxPlatformProblem('linux', 'x64') // 'Retest runs Firefox on macOS on Apple silicon, and this machine is linux x64.'
 */
export function firefoxPlatformProblem(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  if (platform === 'darwin' && arch === 'arm64') return undefined
  return `Retest runs Firefox on macOS on Apple silicon, and this machine is ${platform} ${arch}.`
}

/**
 * The Firefox a target launches: the path it names, at whatever version it is (its real version and build are what the
 * run records); else the pinned build in this user's Retest cache; else Firefox where macOS installs it, only when its
 * files say it is the tested release, since the driver encodes that release's facts and another would run every test
 * on an engine nobody exercised. Nothing is downloaded. A machine Retest does not run Firefox on, a system Firefox of
 * another release, or no Firefox at all fails setup by name, saying what it found and the ways forward.
 *
 * @example await findFirefoxExecutable({ name: 'firefox', browser: 'firefox', headless: true }, 'web', process.env)
 */
export async function findFirefoxExecutable(
  target: LoadedFirefoxTarget,
  app: string,
  env: Readonly<Record<string, string | undefined>>,
  options: { systemPath?: string } = {},
): Promise<{ ok: true; path: string } | { ok: false; failure: Failure }> {
  const unsupported = firefoxPlatformProblem()
  const details = { app, target: target.name }
  if (unsupported !== undefined) return { ok: false, failure: { class: 'setup_failed', message: `${unsupported} The target ${target.name} of the app ${app} cannot start.`, details } }
  if (target.executablePath !== undefined) return { ok: true, path: target.executablePath }
  const installed = await installedBuild('firefox', env)
  if (installed.state === 'installed') return { ok: true, path: installed.executablePath }
  if (installed.state === 'damaged') return { ok: false, failure: { class: 'setup_failed', message: installed.message, details: { ...details, folder: installed.folder } } }
  const systemPath = options.systemPath ?? defaultFirefoxPath
  const tested = testedFirefox()
  // `retest install firefox` refuses the pin until its archive has a checksum, so the way named is the app itself.
  const install = `install the tested Firefox ${tested.version} at ${systemPath}`
  if (!existsSync(systemPath)) {
    const message = `No Firefox for the target ${target.name} of the app ${app}: no pinned build is in Retest's cache, and none is at ${systemPath}. Either ${install}, or give the target an executablePath.`
    return { ok: false, failure: { class: 'setup_failed', message, details } }
  }
  const release = await readFirefoxRelease(systemPath)
  const untested = untestedFirefox(release, tested)
  if (untested === undefined) return { ok: true, path: systemPath }
  const found = release === undefined ? `the Firefox at ${systemPath} names no release in its files` : `the Firefox at ${systemPath} is ${describeRelease(release)}`
  const message = `No tested Firefox for the target ${target.name} of the app ${app}: no pinned build is in Retest's cache, and ${found}, not the tested ${describeRelease(tested)}. Either name it with executablePath on the target to run it at that version, or ${install}.`
  return { ok: false, failure: { class: 'setup_failed', message, details: { ...details, ...(release === undefined ? {} : { found: release.version }), tested: tested.version } } }
}

/**
 * The version and build a Firefox binary's app states in its `application.ini`, read from the file without starting
 * anything, or undefined when the binary is not inside an app whose file says.
 *
 * @example await readFirefoxRelease('/Applications/Firefox.app/Contents/MacOS/firefox') // { version: '133.0.3', buildId: '20241209150345' }
 */
export async function readFirefoxRelease(executablePath: string): Promise<FirefoxRelease | undefined> {
  const file = join(dirname(dirname(executablePath)), 'Resources', 'application.ini')
  const text = await readFile(file, 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  const app = text.split(/^\[/m).find((section) => section.startsWith('App]'))
  const value = (key: string): string | undefined => new RegExp(`^${key}=(.+)$`, 'm').exec(app ?? '')?.[1]?.trim()
  const version = value('Version')
  if (version === undefined || value('Name') !== 'Firefox') return undefined
  return { version, buildId: value('BuildID') }
}
