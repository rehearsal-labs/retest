import type { ResetPolicy } from '../browser/contract.ts'

// What clean state means for a native app, per platform, as Retest arranges it and as far as it reaches. A relaunch
// alone clears nothing: an app's defaults, files and keychain items outlive its process on both platforms.

/** One kind of state an app can leave behind, and what the policy does about it. */
export type StateItem = { readonly state: string; readonly how: string }

/**
 * A platform's reset policy: where one isolation boundary starts and ends, what Retest clears at that boundary, what
 * it leaves for the app's own reset to clear, what it does not isolate at all, and the contract's summary of it.
 */
export type NativeResetPolicy = {
  readonly platform: 'ios-simulator' | 'macos'
  readonly boundary: string
  readonly cleared: readonly StateItem[]
  /** State Retest does not touch and the app may clear itself, when the test passes it the app's own reset switch. */
  readonly leftToTheApp: readonly StateItem[]
  readonly notIsolated: readonly StateItem[]
  readonly contract: ResetPolicy
}

/**
 * iOS simulator apps. Each runtime starts on a simulator created for it from the target's device type and runtime and
 * deletes it when it closes, so nothing an app wrote survives into the next runtime. Within one runtime, a relaunch
 * keeps everything the app wrote.
 */
export const iosSimulatorResetPolicy: NativeResetPolicy = {
  platform: 'ios-simulator',
  boundary: 'One runtime: Retest creates a simulator when the runtime starts and shuts it down and deletes it when the runtime closes. Sessions within one runtime share that simulator.',
  cleared: [
    { state: "The app's container: its documents, caches and defaults", how: 'The app is installed on a simulator nothing else has used, and the simulator is deleted afterwards.' },
    { state: 'Keychain items', how: "The new simulator's keychain is empty." },
    { state: 'Privacy grants such as photos, contacts and location', how: 'The new simulator has granted nothing.' },
    { state: 'Other apps installed on the device, its settings and its logs', how: 'The new simulator has only what its runtime ships with, and WebDriverAgent.' },
  ],
  leftToTheApp: [{ state: 'Anything the app writes while it runs, across a terminate and relaunch within one runtime', how: 'A relaunch keeps it. A test that needs a clean app within one runtime passes the app its own reset switch, or uses a new runtime.' }],
  notIsolated: [
    { state: "The app's backend: accounts, records and sessions on its servers", how: 'Outside the simulator. The host prepares it, for example through a reset route of its service.' },
    { state: 'The Mac: its network, its clock and the simulator runtime itself', how: 'Shared by every simulator on the Mac.' },
    { state: 'The WebDriverAgent build in the executor cache', how: 'Built once for the pinned set and installed into each simulator by xcodebuild.' },
    { state: "The simulator's pasteboard", how: "Not checked. Simulator.app, while it is open, shares the Mac's pasteboard with a booted simulator." },
  ],
  contract: { appData: 'reset', keychain: 'reset' },
}

/**
 * macOS apps. Retest launches a new process of the app at its path and terminates that process at the end, and never
 * touches a copy it did not start. macOS has no per-app reset, and Retest deletes none of an app's data: it cannot know
 * that an app at a path is a test-owned copy rather than the user's own.
 */
export const macosResetPolicy: NativeResetPolicy = {
  platform: 'macos',
  boundary: 'One launch: Retest starts a new process of the app at its path, refuses to start while a copy with the same bundle id runs, and terminates the process it started when the session ends.',
  cleared: [
    { state: 'The running process and its memory', how: 'Each launch is a new process; a running copy blocks the launch rather than being reused.' },
  ],
  leftToTheApp: [
    { state: "The app's defaults domain", how: "Kept across a relaunch. Only the app's own reset clears it, such as a launch argument the app reads; the session passes the launch arguments the test gives it." },
    { state: 'Files the app keeps in Application Support, its container or its caches', how: 'Kept across a relaunch. A test-owned app needs a launch argument that points it at a fresh folder or deletes its own files.' },
    { state: 'Keychain items the app wrote', how: 'Kept. A test-owned app deletes the keychain items it names itself.' },
  ],
  notIsolated: [
    { state: 'Windows macOS restores from an earlier run (Saved Application State)', how: 'Retest clears nothing on disk. An app can turn restoration off, or be launched with -ApplePersistenceIgnoreState YES.' },
    { state: 'Autosaved documents, recent documents and the Apple menu Recent Items', how: 'Kept by macOS for the user, across launches and across runs.' },
    { state: 'Privacy grants (TCC), Launch Services registration and the pasteboard', how: 'Shared with the user and every other app.' },
    { state: 'Other apps, their windows, focus, the pointer and the keyboard', how: 'One interactive desktop: native work on it is serialized behind one macOS runner.' },
    { state: "The app's backend: accounts, records and sessions on its servers", how: 'Outside the Mac app. The host prepares it, for example through a reset route of its service.' },
  ],
  contract: { appData: 'kept', keychain: 'kept' },
}

/**
 * The reset policy of a native platform.
 *
 * @example resetPolicyFor('macos').contract // { appData: 'kept', keychain: 'kept' }
 */
export function resetPolicyFor(platform: 'ios-simulator' | 'macos'): NativeResetPolicy {
  return platform === 'ios-simulator' ? iosSimulatorResetPolicy : macosResetPolicy
}

/**
 * The policy in words, one line per item, for a report or the record.
 *
 * @example describeResetPolicy(iosSimulatorResetPolicy).split('\n')[0] // 'Boundary: One runtime: …'
 */
export function describeResetPolicy(policy: NativeResetPolicy): string {
  const section = (title: string, items: readonly StateItem[]): string[] => (items.length === 0 ? [] : [`${title}:`, ...items.map((item) => `  - ${item.state}. ${item.how}`)])
  return [
    `Boundary: ${policy.boundary}`,
    ...section('Cleared by Retest', policy.cleared),
    ...section("Left to the app's own reset", policy.leftToTheApp),
    ...section('Not isolated', policy.notIsolated),
    `App data ${policy.contract.appData}, keychain ${policy.contract.keychain}, as the session contract states it.`,
  ].join('\n')
}
