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

/**
 * What every target takes. `headless` defaults to true; `emulate` names a device or describes a screen; `proxy`
 * sends the pages' requests through a proxy.
 */
export type TargetSettings = {
  readonly headless?: boolean | undefined
  readonly emulate?: DeviceName | CustomEmulation | undefined
  readonly proxy?: ProxySettings | undefined
}

/** `executablePath` is relative to the config's folder, and falls back to the RETEST_CHROMIUM environment variable. */
export type ChromiumOptions = TargetSettings & { readonly executablePath?: string | undefined }
/** `channel` defaults to stable. */
export type BrandedOptions = TargetSettings & { readonly channel?: Channel | undefined }

export type ChromiumTarget = ChromiumOptions & { readonly browser: 'chromium' }
export type ChromeTarget = BrandedOptions & { readonly browser: 'chrome' }
export type EdgeTarget = BrandedOptions & { readonly browser: 'edge' }
export type TargetConfig = ChromiumTarget | ChromeTarget | EdgeTarget

type WithoutAppSettings = { readonly baseUrl?: undefined; readonly start?: undefined }

/** An app with named targets. Each test that uses it runs once per target. */
export type AppConfig = AppSettings & {
  readonly targets: Readonly<Record<string, TargetConfig & WithoutAppSettings>>
}

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
 * The default export of `retest.config.ts`.
 *
 * - `apps`: each app is `app({ targets })`, or a target on its own, which may carry the app's settings.
 * - `defaultApp`: the app a test without `apps` uses; the only app, when there is one.
 * - `runs`: app to target name, one entry per combination a test with several multi-target apps runs.
 * - `secrets` and `secretOrigins`: a secret may be typed only on the origins of the test's apps' base URLs,
 *   and on the origins `secretOrigins` lists for it.
 * - `testIds`, `tags` and `states` name what tests may use; each is optional, and without it any name type-checks.
 */
export type RetestConfig = {
  readonly apps: Readonly<Record<string, AppConfig | (TargetConfig & AppSettings)>>
  readonly defaultApp?: string | undefined
  readonly runs?: readonly Readonly<Record<string, string>>[] | undefined
  readonly secrets?: Readonly<Record<string, SecretSource>> | undefined
  readonly secretOrigins?: Readonly<Record<string, readonly string[]>> | undefined
  readonly testIds?: Readonly<Record<string, string>> | readonly string[] | undefined
  readonly tags?: readonly string[] | undefined
  readonly states?: readonly string[] | undefined
  readonly timeouts?: { readonly [Name in keyof Timeouts]?: number | undefined } | undefined
}
