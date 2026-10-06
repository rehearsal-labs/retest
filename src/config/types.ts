import type { EvaluationLimits } from '../evaluation/budget.ts'
import type { EvaluatorFactory, JsonValue } from '../evaluation/contract.ts'
import type { DiagnosticLimits } from '../protocol/diagnostics.ts'
import type { EvidenceKind } from '../protocol/evaluation.ts'
import type { Timeouts } from '../protocol/timeouts.ts'
import type { DeviceName } from './devices.ts'

// Optional keys are written `?: T | undefined` so a project's config type-checks with or without
// exactOptionalPropertyTypes. The loader treats a key set to undefined as absent.

export const browserNames = ['chromium', 'chrome', 'edge'] as const
export const channels = ['stable', 'beta', 'dev', 'canary'] as const

export type BrowserName = (typeof browserNames)[number]
export type Channel = (typeof channels)[number]

/**
 * A screen to emulate, for a device the table does not have. `touch` gives the page a touch screen, which
 * makes `tap()` available; `isMobile` defaults to false; without `userAgent` the browser keeps its own.
 */
export type CustomEmulation = {
  readonly viewport: { readonly width: number; readonly height: number }
  readonly deviceScaleFactor: number
  readonly touch: boolean
  readonly isMobile?: boolean | undefined
  readonly userAgent?: string | undefined
}

/**
 * How Retest starts an app's server. `ready` is an http or https URL that answers once the server is up;
 * `cwd` is relative to the config's folder, which is the default. `timeoutMs` defaults to the setup budget.
 */
export type StartCommand = {
  readonly command: string
  readonly ready: string
  readonly cwd?: string | undefined
  readonly timeoutMs?: number | undefined
}

/** Settings that belong to an app, never to one of the targets in its `targets` map. */
export type AppSettings = {
  readonly baseUrl?: string | undefined
  readonly start?: StartCommand | undefined
}

/**
 * A proxy the target's pages send their requests through. Chrome sends loopback addresses around it unless
 * `bypass` holds `<-loopback>`.
 */
export type ProxySettings = {
  /** The proxy's address: http, https, socks4 or socks5, with no user name or password in it. */
  readonly server: string
  /** Chrome's bypass rules, such as 'localhost', '*.internal' or '<-loopback>'. */
  readonly bypass?: readonly string[] | undefined
}

/** A page's size in CSS pixels. */
export type Viewport = { readonly width: number; readonly height: number }

/**
 * What every target takes. `headless` defaults to true; `emulate` names a device or describes a screen; `viewport`
 * only sizes the page, as a custom emulation with no touch screen and a pixel ratio of 1 does, and the loader refuses
 * it beside `emulate`, which already sets the size; `proxy` sends the pages' requests through a proxy.
 */
export type TargetSettings = {
  readonly headless?: boolean | undefined
  readonly emulate?: DeviceName | CustomEmulation | undefined
  readonly viewport?: Viewport | undefined
  readonly proxy?: ProxySettings | undefined
}

/** `executablePath` is relative to the config's folder, and falls back to the RETEST_CHROMIUM environment variable. */
export type ChromiumOptions = TargetSettings & { readonly executablePath?: string | undefined }
/** `channel` defaults to stable. */
export type BrandedOptions = TargetSettings & { readonly channel?: Channel | undefined }
/** `executablePath` is relative to the config's folder. */
export type EngineOptions = TargetSettings & { readonly executablePath?: string | undefined }

export type ChromiumTarget = ChromiumOptions & { readonly browser: 'chromium' }
export type ChromeTarget = BrandedOptions & { readonly browser: 'chrome' }
export type EdgeTarget = BrandedOptions & { readonly browser: 'edge' }
/**
 * Firefox, driven over WebDriver BiDi on macOS on Apple silicon. Without `executablePath` a run uses the pinned build in
 * Retest's cache, when one is there, or Firefox where macOS installs it. A Firefox target takes a viewport; a proxy, or
 * a device or emulation beyond a viewport at a pixel ratio of 1, fails the test's setup by name.
 */
export type FirefoxTarget = EngineOptions & { readonly browser: 'firefox' }
/**
 * Playwright's WebKit build, driven over its inspector pipe on macOS. `executablePath` names the unpacked build's folder
 * or the executable inside it, and falls back to the RETEST_WEBKIT_BUILD environment variable; Retest looks nowhere
 * else. A WebKit target takes a viewport, or a screen with a pixel ratio and a user agent; a mobile layout, a touch screen
 * or a proxy fails the test's setup by name.
 */
export type WebKitTarget = EngineOptions & { readonly browser: 'webkit' }
export type WebTargetConfig = ChromiumTarget | ChromeTarget | EdgeTarget | FirefoxTarget | WebKitTarget

/**
 * An app on an iOS simulator. `appPath` is the app's simulator build, its `.app` bundle, relative to the config's
 * folder. `device` and `runtime` name the simulator's device type and iOS version, such as 'iPhone 17' and '26.0'.
 * Retest has no iOS driver yet: the config accepts the target, and a run refuses every test that needs it before
 * starting anything for that test.
 */
export type NativeLaunchSettings = {
  readonly arguments?: readonly string[] | undefined
  readonly environment?: Readonly<Record<string, string>> | undefined
}

/**
 * Where a native app's diagnostics come from, the same for each of its runs. `logs: 'stdout'`, the default, keeps the
 * app's standard output: Retest launches the app itself with a pipe on that output, through `simctl launch --console`
 * on a simulator and at the app's executable on macOS. `logs: 'none'` leaves the launch to the executor and keeps no
 * app log. `network` names a file of request metadata the app's backend writes, one versioned JSON line per request,
 * relative to the config's folder, and the client name its records give this app: Retest reads only the lines appended
 * while a test runs, and only that client's. Without `network`, the app has no network source. A file and client
 * belong to one app: the records cannot tell two apps, or two simulators that run at once, apart.
 */
export type NativeAppDiagnostics = {
  readonly logs?: 'stdout' | 'none' | undefined
  readonly network?: { readonly path: string; readonly client: 'ios' | 'macos' } | undefined
}

/** What every native target takes besides its platform's own keys. */
export type NativeTargetSettings = NativeLaunchSettings & { readonly diagnostics?: NativeAppDiagnostics | undefined }

export type IosSimulatorTarget = NativeTargetSettings & {
  readonly platform: 'ios-simulator'
  readonly appPath: string
  readonly device: string
  readonly runtime: string
}

/**
 * An app on the Mac Retest runs on. `appPath` is its `.app` bundle, relative to the config's folder. Retest has no
 * macOS driver yet: the config accepts the target, and a run refuses every test that needs it before starting
 * anything for that test.
 */
export type MacosTarget = NativeTargetSettings & { readonly platform: 'macos'; readonly appPath: string }

/** A native app's target: a native app has no address, so it never takes `baseUrl`. */
export type NativeTargetConfig = IosSimulatorTarget | MacosTarget

/** The platforms a native target names. */
export type NativePlatform = NativeTargetConfig['platform']

/**
 * An Electron app. `executablePath` is the Electron binary, inside Electron.app on macOS, and `appPath` the app's
 * folder or its entry file; both are relative to the config's folder. `args` reach the app after its path.
 * `userDataDir`, relative to the config's folder, is where the app keeps its data from one launch to the next, and no
 * other Electron target may name the same folder; without it, each launch gets a new folder in the temporary folder,
 * removed when the app quits. Retest launches the app afresh for each test and quits it when the test ends, and the
 * first window the app opens is the test's page. A secret never goes in `args`: give it through `secrets`.
 */
export type ElectronOptions = {
  readonly executablePath: string
  readonly appPath: string
  readonly args?: readonly string[] | undefined
  readonly userDataDir?: string | undefined
}

/** An Electron app's target. It has no address, so it never takes `baseUrl`, and it emulates no screen. */
export type ElectronTarget = ElectronOptions & { readonly browser: 'electron' }

/**
 * A target: a browser, an Electron app or a native app. The targets of one app are all browsers, all Electron apps,
 * all iOS simulators or all macOS apps, since a test's handle on the app offers what its targets can do.
 */
export type TargetConfig = WebTargetConfig | ElectronTarget | NativeTargetConfig

type WithoutAppSettings = { readonly baseUrl?: undefined; readonly start?: undefined }

/** An app with named targets. Each test that uses it runs once per target. */
export type AppConfig = AppSettings & {
  readonly targets: Readonly<Record<string, TargetConfig & WithoutAppSettings>>
}

/** A native target that stands for an app of its own: it may carry the app's `start`, and never a `baseUrl`. */
type NativeApp = NativeTargetConfig & { readonly baseUrl?: undefined; readonly start?: StartCommand | undefined }

/** An Electron target that stands for an app of its own: it may carry the app's `start`, and never a `baseUrl`. */
type ElectronApp = ElectronTarget & { readonly baseUrl?: undefined; readonly start?: StartCommand | undefined }

/** A secret read from the parent's environment, once, when the run starts. */
export type EnvSecret = { readonly env: string }

// The project's own AbortSignal, from Node's types or the DOM's, so a secret's function can pass it to fetch. Retest's
// declarations need neither, so a project with neither sees only whether the signal was aborted.
type GlobalAbortSignal = typeof globalThis extends { AbortSignal: { prototype: infer Signal } } ? Signal : { readonly aborted: boolean }

/** What a secret's function is called with. `signal` is aborted once Retest stops waiting for the value. */
export type SecretContext = { readonly signal: GlobalAbortSignal }

/**
 * Where a secret's value comes from: an environment variable, or a function the parent calls each time a
 * `fill` uses the secret, for values such as one-time codes that change between reads. The function's
 * `signal` is aborted when the fill's time runs out.
 */
export type SecretSource = EnvSecret | ((context: SecretContext) => string | Promise<string>)

/**
 * A judge for AI checks. `adapter` makes it: a module path relative to the config, such as './judges/visual.ts', a
 * package such as '@rehearsal-labs/retest/evaluation/ai-sdk', or a function. Retest's own process loads it, the first
 * time a check uses the judge, and calls its default export with `credentials`, read the way secrets are read, and
 * `options`, which hold JSON values only. `accepts` lists what the judge takes: `text`, `images` and `frames`.
 */
export type JudgeConfig = {
  readonly adapter: string | EvaluatorFactory
  readonly credentials?: Readonly<Record<string, SecretSource>> | undefined
  readonly options?: { readonly [key: string]: JsonValue } | undefined
  readonly accepts: readonly EvidenceKind[]
}

/**
 * AI checks. `judges` names each judge; `defaultJudge` is the one a check that names none uses, the only judge when
 * there is one. `timeoutMs` is how long a check may take, 30 seconds by default, and never more than its test has
 * left. `limits` bounds calls and what each request carries; see `EvaluationLimits` for each limit and its default.
 */
export type EvaluationConfig = {
  readonly judges: Readonly<Record<string, JudgeConfig>>
  readonly defaultJudge?: string | undefined
  readonly timeoutMs?: number | undefined
  readonly limits?: { readonly [Name in keyof EvaluationLimits]?: number | undefined } | undefined
}

/**
 * What a declared strict policy fails a test for, once its body and checks passed: uncaught errors and unhandled
 * rejections, console errors the page's own code wrote, requests that failed in transport, and responses with a status
 * of 400 or more. Set at least one to true. `allow` lists text that, found in a record's message or address, leaves
 * it uncounted, such as '/favicon.ico'.
 */
export type StrictDiagnostics = {
  readonly runtimeErrors?: boolean | undefined
  readonly consoleErrors?: boolean | undefined
  readonly transportFailures?: boolean | undefined
  readonly httpErrors?: boolean | undefined
  readonly allow?: readonly string[] | undefined
}

/**
 * Console, runtime error and network capture. `capture` is true by default; false records nothing, and every result
 * says so. Console errors and HTTP error responses are recorded and fail nothing unless `strict` names them.
 * `requireComplete` keeps a test from passing when any of its capture is not complete. `limits` bound each attempt; see
 * `DiagnosticLimits` for each limit and its default.
 */
export type DiagnosticsConfig = {
  readonly capture?: boolean | undefined
  readonly strict?: StrictDiagnostics | undefined
  readonly requireComplete?: boolean | undefined
  readonly limits?: { readonly [Name in keyof DiagnosticLimits]?: number | undefined } | undefined
}

/**
 * Video recording of each app session. Off unless asked: a run that records nothing starts no media process and runs as
 * it would without this block.
 *
 * - `record`: record every app of the run whose pixel rules allow recordings. `apps` turns it on or off for one app,
 *   whatever `record` says; an app named true there must allow recordings.
 * - `required`: evidence is required. A run in which a recording asked for is missing or incomplete ends with its own
 *   failure, `evidence_incomplete`, and exit code 2, while every test keeps the outcome it observed. It cannot be true
 *   while nothing is recorded.
 * - `keep`: `all` keeps every recording (the default); `failures` removes the recordings of an attempt that passed once it
 *   has finished.
 * - `fps`: the frames a second asked of the capture and given to the video, 1 to 30, 10 by default.
 * - `nativeWithholding`: withhold plain native secret fields and resume only after verified clearance; false by default.
 *   Secure native fields always keep pixels. Applies to screenshots too, even when recording is off.
 * - `size`: the video's width and height, even numbers from 16 to 4096, 1280 by 720 by default; frames are fitted inside.
 */
export type RecordingConfig = {
  readonly nativeWithholding?: boolean | undefined
  readonly record?: boolean | undefined
  readonly apps?: Readonly<Record<string, boolean>> | undefined
  readonly required?: boolean | undefined
  readonly keep?: 'all' | 'failures' | undefined
  readonly fps?: number | undefined
  readonly size?: { readonly width: number; readonly height: number } | undefined
}

/**
 * What may be captured as pixels, by app: `screenshots` covers every single capture (a failure screenshot, an AI check's
 * screenshot, an agent's frame) and `recordings` every frame of a recording or a live view, each `allowed` (the default)
 * or `never`. The capture policy applies once a run records anything or an app states its rules here.
 */
export type PixelsConfig = Readonly<Record<string, { readonly screenshots?: 'allowed' | 'never' | undefined; readonly recordings?: 'allowed' | 'never' | undefined }>>

/**
 * The default export of `retest.config.ts`.
 *
 * - `apps`: each app is `app({ targets })`, or a target on its own, which may carry the app's settings. A target is
 *   a browser, an Electron app, `electron({ executablePath, appPath })`, or a native app:
 *   `{ platform: 'ios-simulator', ... }` or `{ platform: 'macos', ... }`.
 * - `defaultApp`: the app a test without `apps` uses; the only app, when there is one.
 * - `runs`: app to target name, one entry per combination a test with several multi-target apps runs.
 * - `secrets` and `secretOrigins`: a secret may be typed only on the origins of the test's apps' base URLs,
 *   and on the origins `secretOrigins` lists for it.
 * - `testIds`, `tags` and `states` name what tests may use; each is optional, and without it any name type-checks.
 * - `locks` names the shared state tests may hold with `locks`. Without it, a test may hold none.
 * - `evaluation` declares the judges `test.evaluate` uses. Without it, a run has no AI checks.
 * - `diagnostics` sets console and network capture, a strict policy and its limits. Without it, capture is on and
 *   nothing in it fails a test.
 * - `recording` records each app session as a video, and can require that evidence. Without it, nothing is recorded.
 * - `pixels` says, by app, whether screenshots and recordings may be taken at all.
 */
export type RetestConfig = {
  readonly apps: Readonly<Record<string, AppConfig | (WebTargetConfig & AppSettings) | ElectronApp | NativeApp>>
  readonly defaultApp?: string | undefined
  readonly runs?: readonly Readonly<Record<string, string>>[] | undefined
  readonly secrets?: Readonly<Record<string, SecretSource>> | undefined
  readonly secretOrigins?: Readonly<Record<string, readonly string[]>> | undefined
  readonly testIds?: Readonly<Record<string, string>> | readonly string[] | undefined
  readonly tags?: readonly string[] | undefined
  readonly states?: readonly string[] | undefined
  readonly locks?: readonly string[] | undefined
  readonly timeouts?: { readonly [Name in keyof Timeouts]?: number | undefined } | undefined
  readonly evaluation?: EvaluationConfig | undefined
  readonly diagnostics?: DiagnosticsConfig | undefined
  readonly recording?: RecordingConfig | undefined
  readonly pixels?: PixelsConfig | undefined
}
