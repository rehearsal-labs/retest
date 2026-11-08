import type { NativeExecutionRecord } from '../protocol/execution.ts'

// How the reports name what a native session ran on, the same in the terminal's timeline and the HTML report: the
// platform and its version, and the executor with the Xcode it ran with when there is one.

/**
 * Where a native session ran, in words.
 *
 * @example nativePlatformWords(identity) // 'iOS Simulator 26.5'
 */
export function nativePlatformWords(identity: NativeExecutionRecord): string {
  if (identity.platform === 'macos') return 'macOS'
  if (identity.platform === 'android') return `Android ${identity.os.version}${identity.android === undefined ? '' : ` on ${identity.android.name} (${identity.android.serial})`}`
  return `iOS Simulator ${identity.os.version}`
}

/**
 * The kind of app a native session ran.
 *
 * @example nativeAppKind(identity) // 'iOS simulator app'
 */
export function nativeAppKind(identity: NativeExecutionRecord): string {
  if (identity.platform === 'macos') return 'macOS app'
  return identity.platform === 'android' ? 'Android app' : 'iOS simulator app'
}

/**
 * The executor a native session ran on, short: its name and version, and the Xcode it ran with when there is one.
 *
 * @example nativeExecutorWords(identity) // 'agent-device 0.21.36 · Xcode 27.0 (27A266a)'
 */
export function nativeExecutorWords(identity: NativeExecutionRecord): string {
  const xcode = identity.xcode === undefined ? '' : ` · Xcode ${identity.xcode.version} (${identity.xcode.build})`
  return `${identity.executor.name} ${identity.executor.version}${xcode}`
}

/**
 * The executor a native session ran on, in full: a build Retest made from a pinned commit, with its commit and
 * products, or the agent-device package the project installed.
 *
 * @example nativeExecutorDetail(identity) // 'agent-device 0.21.36, the package the project installed'
 */
export function nativeExecutorDetail(identity: NativeExecutionRecord): string {
  const { executor } = identity
  if ('package' in executor) return `${executor.name} ${executor.version}, the package the project installed`
  return `${executor.name} ${executor.version}, commit ${executor.commit}${executor.commitVerified ? ', verified' : ', not verified'}, ${executor.origin}, products sha256 ${executor.productsSha256}`
}
