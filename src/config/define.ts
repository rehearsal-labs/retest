import type {
  AppConfig,
  AppSettings,
  BrandedOptions,
  BrowserName,
  ChromiumOptions,
  ElectronOptions,
  EnvSecret,
  RetestConfig,
  StartCommand,
} from './types.ts'

// Each function keeps every name its argument holds as a literal type, which the Register types read. None of
// them checks anything at run time: the loader validates the whole config and names the key that is wrong.

/** Marks each key the shape does not have, which a `const` type parameter would otherwise let through. */
type NoExtraKeys<Given, Shape> = { readonly [Key in Exclude<keyof Given, keyof Shape>]: never }

/** Each `secretOrigins` key must name one of the config's own secrets. */
type SecretOriginKeys<Config extends RetestConfig> = {
  readonly secretOrigins?: NoInfer<NoExtraKeys<Config['secretOrigins'], Config['secrets']>> | undefined
}

/**
 * Declares the config. Export it as the default of `retest.config.ts` and register its type once.
 *
 * @example
 * const config = defineConfig({ apps: { web: chromium({ baseUrl: 'http://localhost:3000' }) } })
 * export default config
 * declare module '@rehearsal-labs/retest' { interface Register { config: typeof config } }
 */
export function defineConfig<const Config extends RetestConfig>(
  config: Config & NoExtraKeys<Config, RetestConfig> & SecretOriginKeys<Config>,
): Config {
  return config
}

/**
 * An app with several targets. A test that uses it runs once per target.
 *
 * @example app({ baseUrl: 'http://localhost:3000', targets: { chromium: chromium(), beta: chrome({ channel: 'beta' }) } })
 */
export function app<const App extends AppConfig>(options: App & NoExtraKeys<App, AppConfig>): App {
  return options
}

/**
 * Chromium, or Chrome for Testing, from `executablePath` or the RETEST_CHROMIUM environment variable.
 *
 * @example chromium({ executablePath: '/opt/chromium/chrome', emulate: 'Pixel 9' })
 */
export function chromium<const Options extends ChromiumOptions & AppSettings = {}>(
  options?: Options & NoExtraKeys<Options, ChromiumOptions & AppSettings>,
): Options & { readonly browser: 'chromium' } {
  return tagged(options, 'chromium')
}

/**
 * Google Chrome, found where its channel installs on macOS and Linux.
 *
 * @example chrome({ channel: 'beta' })
 */
export function chrome<const Options extends BrandedOptions & AppSettings = {}>(
  options?: Options & NoExtraKeys<Options, BrandedOptions & AppSettings>,
): Options & { readonly browser: 'chrome' } {
  return tagged(options, 'chrome')
}

/**
 * Microsoft Edge, found where its channel installs on macOS and Linux.
 *
 * @example edge({ channel: 'dev' })
 */
export function edge<const Options extends BrandedOptions & AppSettings = {}>(
  options?: Options & NoExtraKeys<Options, BrandedOptions & AppSettings>,
): Options & { readonly browser: 'edge' } {
  return tagged(options, 'edge')
}

/** What an Electron app on its own may carry of its app's settings: a server to start, and never a base URL. */
type ElectronAppSettings = { readonly start?: StartCommand | undefined }

/**
 * An Electron app, launched afresh for each test from `executablePath`, the Electron binary, with `appPath`, the
 * app's folder or entry file. The first window the app opens is the test's page; it has no address, so it takes no
 * `baseUrl`.
 *
 * @example electron({ executablePath: 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', appPath: 'desktop' })
 */
export function electron<const Options extends ElectronOptions & ElectronAppSettings>(
  options: Options & NoExtraKeys<Options, ElectronOptions & ElectronAppSettings>,
): Options & { readonly browser: 'electron' } {
  return Object.assign({}, options, { browser: 'electron' as const })
}

/**
 * A secret read from the environment of the process that runs Retest, once, when the run starts.
 *
 * @example secrets: { password: env('TEST_PASSWORD') }
 */
export function env<const Name extends string>(name: Name): EnvSecret & { readonly env: Name } {
  return { env: name }
}

function tagged<Options, Browser extends BrowserName>(options: Options | undefined, browser: Browser): Options & { readonly browser: Browser } {
  return Object.assign({}, options, { browser })
}
