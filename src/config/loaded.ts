import type { NativeNetworkDeclaration } from '../diagnostics/native-network.ts'
import type { DiagnosticsPolicy } from '../diagnostics/policy.ts'
import type { AppPixelRules } from '../media/policy.ts'
import type { Emulation } from '../protocol/emulation.ts'
import type { Timeouts } from '../protocol/timeouts.ts'
import type { Variant } from '../protocol/variant.ts'
import type { DeviceName } from './devices.ts'
import type { LoadedEvaluation } from './read-evaluation.ts'
import type { RecordingSettings } from './read-recording.ts'
import type { Channel, SecretContext } from './types.ts'

// A config as the runner reads it: validated, with defaults filled in and paths absolute. Maps keep the
// config's order and cannot confuse a name such as "constructor" with an inherited property.

/** `cwd` is absolute. */
export type LoadedStart = { readonly command: string; readonly ready: string; readonly cwd: string; readonly timeoutMs?: number }

/** A named device, or a screen of the config's own with `isMobile` filled in. */
export type LoadedEmulation = DeviceName | Emulation

/** A proxy's address as `scheme://host:port`, and its bypass rules, none when the config lists none. */
export type LoadedProxy = { readonly server: string; readonly bypass: readonly string[] }

type LoadedWebSettings = { readonly name: string; readonly headless: boolean; readonly emulate?: LoadedEmulation; readonly proxy?: LoadedProxy }

/** A target the Chromium driver runs. `executablePath` is absolute; a chromium target without one uses RETEST_CHROMIUM. */
export type LoadedChromiumTarget = LoadedWebSettings &
  ({ readonly browser: 'chromium'; readonly executablePath?: string } | { readonly browser: 'chrome' | 'edge'; readonly channel: Channel })

/** A Firefox or WebKit target, which no driver runs yet. `executablePath` is absolute. */
export type LoadedEngineTarget = LoadedWebSettings &
  ({ readonly browser: 'firefox'; readonly executablePath?: string } | { readonly browser: 'webkit'; readonly executablePath?: string })

/** A Firefox target, which Retest's Firefox driver runs over WebDriver BiDi. `executablePath` is absolute. */
export type LoadedFirefoxTarget = Extract<LoadedEngineTarget, { readonly browser: 'firefox' }>

/**
 * A WebKit target, which Retest's WebKit driver runs over the inspector pipe of Playwright's WebKit build. `executablePath`
 * is absolute and names the unpacked build's folder or the executable inside it.
 */
export type LoadedWebKitTarget = Extract<LoadedEngineTarget, { readonly browser: 'webkit' }>

export type LoadedWebTarget = LoadedChromiumTarget | LoadedEngineTarget

/**
 * An Electron app's target, which the Chromium driver runs over the app's own debugging pipe. `executablePath`,
 * `appPath` and `userDataDir` are absolute; `args` are empty when the config gives none, and `userDataDir` is absent
 * when each launch takes a new folder in the temporary folder, removed when the app quits. It never emulates a screen
 * or goes through a proxy.
 */
export type LoadedElectronTarget = {
  readonly name: string
  readonly browser: 'electron'
  readonly executablePath: string
  readonly appPath: string
  readonly args: readonly string[]
  readonly userDataDir?: string
  readonly emulate?: never
  readonly proxy?: never
}

/**
 * Where a native app's diagnostics come from: its standard output, unless `logs` is 'none', and the network file its
 * `network` names, with an absolute path. A target whose config declares none has no `diagnostics`, which reads as
 * standard output and no network source.
 */
export type LoadedNativeDiagnostics = { readonly logs: 'stdout' | 'none'; readonly network?: NativeNetworkDeclaration }

/**
 * A native app's target, which no driver runs yet. `appPath` is absolute. It never emulates a screen or goes through
 * a proxy: those belong to browsers.
 */
export type LoadedNativeTarget = { readonly arguments?: readonly string[]; readonly environment?: Readonly<Record<string, string>>; readonly diagnostics?: LoadedNativeDiagnostics; readonly name: string; readonly emulate?: never; readonly proxy?: never } & (
  | { readonly platform: 'ios-simulator'; readonly appPath: string; readonly device: string; readonly runtime: string }
  | { readonly platform: 'macos'; readonly appPath: string }
)

export type LoadedTarget = LoadedWebTarget | LoadedElectronTarget | LoadedNativeTarget

export type LoadedApp = {
  readonly name: string
  readonly baseUrl?: string
  readonly start?: LoadedStart
  readonly targets: ReadonlyMap<string, LoadedTarget>
}

/**
 * Where a secret comes from: an environment variable the run reads once, at its start, or a function the parent
 * calls on each use, passing the context on to the config's function. `read` resolves to a non-empty string, or
 * rejects with an error that never holds the value.
 */
export type LoadedSecretSource = { readonly env: string } | { readonly read: (context: SecretContext) => Promise<string> }

/** A secret's source, and the origins beyond its test's apps' base URLs where it may be typed. */
export type LoadedSecret = { readonly source: LoadedSecretSource; readonly origins: readonly string[] }

/**
 * `file` is the config's absolute path. `defaultApp` is absent when several apps leave it unnamed. `tags`,
 * `states` and `locks` are absent when the config does not list them. `testIds` only feeds the type check, so it is
 * not kept. `evaluation` is absent when the config declares no judges, and `diagnostics` when it sets no diagnostics.
 * `recording` is absent when the config has no `recording` block, and `pixels` when it states no app's pixel rules.
 */
export type LoadedConfig = {
  readonly file: string
  readonly apps: ReadonlyMap<string, LoadedApp>
  readonly defaultApp?: string
  readonly runs: readonly Readonly<Variant>[]
  readonly secrets: ReadonlyMap<string, LoadedSecret>
  readonly tags?: readonly string[]
  readonly states?: readonly string[]
  readonly locks?: readonly string[]
  readonly timeouts: Readonly<Partial<Timeouts>>
  readonly evaluation?: LoadedEvaluation
  readonly diagnostics?: DiagnosticsPolicy
  readonly recording?: RecordingSettings
  readonly pixels?: ReadonlyMap<string, AppPixelRules>
}
