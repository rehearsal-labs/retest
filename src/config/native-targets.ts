import type { LoadedAgentDeviceTarget, LoadedNativeTarget } from './loaded.ts'

// What a native target runs on, as the runner, the leases and the config checks key it: the Mac's one desktop, one
// simulator device type and runtime, or one Android emulator or device, by the name or serial its target gives.

/**
 * The native runtime a target takes, as a key: `macos`, `iPhone 17 (26.5)`, or `android device Pixel_9` and
 * `android serial emulator-5554`. Two targets with one key cannot run at once.
 *
 * @example nativeRuntimeKey({ name: 'phone', platform: 'ios-simulator', appPath: '/TaskPhone.app', device: 'iPhone 17', runtime: '26.5' }) // 'iPhone 17 (26.5)'
 */
export function nativeRuntimeKey(target: LoadedNativeTarget): string {
  if (target.platform === 'macos') return 'macos'
  if (target.platform === 'android') return `android ${describeAndroidDevice(target.device)}`
  return `${target.device} (${target.runtime})`
}

/**
 * An Android target's device as its config names it.
 *
 * @example describeAndroidDevice({ serial: 'emulator-5554' }) // 'serial emulator-5554'
 */
export function describeAndroidDevice(device: Extract<LoadedNativeTarget, { readonly platform: 'android' }>['device']): string {
  return 'serial' in device ? `serial ${device.serial}` : `device ${device.name}`
}

/**
 * The target as one that runs through agent-device, or undefined for one that runs on Retest's own executors: every
 * Android target runs through it, and an iOS simulator target whose config asks for it.
 *
 * @example agentDeviceTarget({ name: 'phone', platform: 'ios-simulator', appPath: '/TaskPhone.app', device: 'iPhone 17', runtime: '26.5', driver: 'agent-device' })?.driver // 'agent-device'
 */
export function agentDeviceTarget(target: LoadedNativeTarget): LoadedAgentDeviceTarget | undefined {
  if (target.platform === 'android') return target
  if (target.platform === 'ios-simulator' && target.driver === 'agent-device') return { ...target, driver: 'agent-device' }
  return undefined
}

/**
 * Whether a target runs through agent-device rather than Retest's own executors.
 *
 * @example throughAgentDevice({ name: 'desk', platform: 'macos', appPath: '/TaskDesk.app' }) // false
 */
export function throughAgentDevice(target: LoadedNativeTarget): boolean {
  return agentDeviceTarget(target) !== undefined
}
