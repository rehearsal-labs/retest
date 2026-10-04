import type { NativeRuntimeIdentity } from '../browser/contract.ts'
import type { Failure } from '../protocol/failures.ts'
import type { ExecutorBuild } from './executors.ts'
import type { NativeTools } from './processes.ts'
import { join } from 'node:path'
import { errorMessage } from '../protocol/failures.ts'
import { isPlainObject } from '../protocol/schema.ts'
import { folderChecksum } from './executors.ts'
import { describeCommand, runCommand } from './processes.ts'

// What a native result must name so a reader knows exactly what ran: the app build, from its own Info.plist and its
// checksum, the operating system it ran on, the simulator for iOS, and the executor build and Xcode of the tested set.
// The wiring writes this value into the run's events; nothing here writes events itself.

/** An app bundle as its Info.plist states it, with the checksum of the whole bundle. */
export type AppBundle = {
  readonly appPath: string
  readonly bundleId: string
  /** `CFBundleShortVersionString`. */
  readonly version?: string
  /** `CFBundleVersion`. */
  readonly build?: string
  readonly displayName?: string
  readonly name?: string
  readonly executable: string
  readonly platforms: readonly string[]
  readonly sha256: string
}

/** The operating system a native app ran on, as it names itself. */
export type OperatingSystem = { readonly name: 'iOS' | 'macOS'; readonly version: string; readonly build: string }

/** The simulator an iOS app ran on: its name, its device type and its id. */
export type SimulatorDevice = { readonly name: string; readonly type: string; readonly udid: string }

/**
 * Everything a native result names about what ran: the app build, the operating system, the simulator for iOS, the
 * executor build and the Xcode it was built with.
 */
export type NativeExecutionIdentity = {
  readonly platform: 'ios-simulator' | 'macos'
  readonly app: { readonly bundleId: string; readonly version?: string; readonly build?: string; readonly path: string; readonly sha256: string }
  readonly os: OperatingSystem
  readonly device?: SimulatorDevice
  /**
   * The executor build. `commitVerified` is true for a build this cache compiled from the pinned commit, and false for
   * one it took over, whose checkout is at the pinned commit but whose products do not say what they were compiled from.
   */
  readonly executor: { readonly name: string; readonly version: string; readonly commit: string; readonly commitVerified: boolean; readonly productsSha256: string; readonly codeDirectoryHash?: string; readonly origin: 'built' | 'adopted' }
  readonly xcode: { readonly version: string; readonly build: string }
}

const supportedPlatform: Readonly<Record<'ios-simulator' | 'macos', string>> = { 'ios-simulator': 'iPhoneSimulator', macos: 'MacOSX' }

/**
 * Reads an app bundle's Info.plist and checksum. The bundle must be built for the platform: an iOS simulator build
 * lists iPhoneSimulator among its supported platforms, a Mac app MacOSX.
 *
 * @example (await readAppBundle('/…/TaskPhone.app', 'ios-simulator', systemTools)).ok // true
 */
export async function readAppBundle(appPath: string, platform: 'ios-simulator' | 'macos', tools: NativeTools, signal?: AbortSignal): Promise<{ readonly ok: true; readonly bundle: AppBundle } | { readonly ok: false; readonly failure: Failure }> {
  const plist = platform === 'macos' ? join(appPath, 'Contents', 'Info.plist') : join(appPath, 'Info.plist')
  const read = await runCommand(tools.plutil, ['-convert', 'json', '-o', '-', plist], { timeoutMs: 15_000, signal, hiddenVariables: tools.hiddenVariables })
  if (read.code !== 0) return refused(`Retest cannot read the app's Info.plist at ${plist}: ${describeCommand('plutil', read)}.`)
  let info: unknown
  try {
    info = JSON.parse(read.stdout)
  } catch (error) {
    return refused(`The app's Info.plist at ${plist} is not readable: ${errorMessage(error)}.`)
  }
  if (!isPlainObject(info)) return refused(`The app's Info.plist at ${plist} is not a dictionary.`)
  const text = (key: string): string | undefined => {
    const value = info[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  const bundleId = text('CFBundleIdentifier')
  const executable = text('CFBundleExecutable')
  if (bundleId === undefined || executable === undefined) return refused(`The app's Info.plist at ${plist} names no bundle id or executable.`)
  const listed = info['CFBundleSupportedPlatforms']
  const platforms = Array.isArray(listed) ? listed.filter((entry): entry is string => typeof entry === 'string') : []
  if (!platforms.includes(supportedPlatform[platform])) {
    const built = platforms.length === 0 ? 'no platform' : platforms.join(', ')
    return refused(`${appPath} is built for ${built}, not ${supportedPlatform[platform]}.`)
  }
  const sha256 = await folderChecksum(appPath)
  const version = text('CFBundleShortVersionString')
  const build = text('CFBundleVersion')
  const displayName = text('CFBundleDisplayName')
  const name = text('CFBundleName')
  return {
    ok: true,
    bundle: {
      appPath,
      bundleId,
      ...(version === undefined ? {} : { version }),
      ...(build === undefined ? {} : { build }),
      ...(displayName === undefined ? {} : { displayName }),
      ...(name === undefined ? {} : { name }),
      executable,
      platforms,
      sha256,
    },
  }
}

/**
 * The names an app's tree may give it at its root: its display name, its name and its executable.
 *
 * @example appNames(bundle) // ['TaskDesk']
 */
export function appNames(bundle: AppBundle): string[] {
  return [...new Set([bundle.displayName, bundle.name, bundle.executable].filter((name): name is string => name !== undefined))]
}

/**
 * The Mac's own version and build, as `sw_vers` says them.
 *
 * @example await readMacosVersion(systemTools) // { name: 'macOS', version: '27.0.1', build: '26A434' }
 */
export async function readMacosVersion(tools: NativeTools, signal?: AbortSignal): Promise<OperatingSystem | undefined> {
  const version = await runCommand(tools.swVers, ['-productVersion'], { timeoutMs: 10_000, signal, hiddenVariables: tools.hiddenVariables })
  const build = await runCommand(tools.swVers, ['-buildVersion'], { timeoutMs: 10_000, signal, hiddenVariables: tools.hiddenVariables })
  if (version.code !== 0 || build.code !== 0) return undefined
  return { name: 'macOS', version: version.stdout.trim(), build: build.stdout.trim() }
}

/**
 * The identity a native result names, from what the runtime read.
 *
 * @example nativeExecutionIdentity({ platform: 'macos', bundle, os, build })
 */
export function nativeExecutionIdentity(parts: { readonly platform: 'ios-simulator' | 'macos'; readonly bundle: AppBundle; readonly os: OperatingSystem; readonly device?: SimulatorDevice; readonly build: ExecutorBuild }): NativeExecutionIdentity {
  const { bundle, build } = parts
  return {
    platform: parts.platform,
    app: { bundleId: bundle.bundleId, ...(bundle.version === undefined ? {} : { version: bundle.version }), ...(bundle.build === undefined ? {} : { build: bundle.build }), path: bundle.appPath, sha256: bundle.sha256 },
    os: parts.os,
    ...(parts.device === undefined ? {} : { device: parts.device }),
    executor: { name: build.executor, version: build.version, commit: build.commit, commitVerified: build.origin === 'built', productsSha256: build.productsSha256, ...(build.codeDirectoryHash === undefined ? {} : { codeDirectoryHash: build.codeDirectoryHash }), origin: build.origin },
    xcode: build.xcode,
  }
}

/**
 * The session contract's runtime identity for a native app: the bundle, the processes it owns, and for iOS the
 * simulator's device type and runtime.
 *
 * @example runtimeIdentity(identity, [4242]).kind // 'macos'
 */
export function runtimeIdentity(identity: NativeExecutionIdentity, processIds: readonly number[]): NativeRuntimeIdentity {
  const app = identity.app
  const version = app.version === undefined ? {} : { appVersion: app.version }
  if (identity.platform === 'macos') return { kind: 'macos', bundleId: app.bundleId, ...version, appPath: app.path, processIds: [...processIds] }
  return { kind: 'ios-simulator', bundleId: app.bundleId, ...version, appPath: app.path, device: identity.device?.type ?? 'unknown', runtime: `${identity.os.name} ${identity.os.version} (${identity.os.build})`, processIds: [...processIds] }
}

function refused(message: string): { readonly ok: false; readonly failure: Failure } {
  return { ok: false, failure: { class: 'setup_failed', message } }
}
