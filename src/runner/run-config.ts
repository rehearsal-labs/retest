import type { LoadedApp, LoadedConfig, LoadedSecret, LoadedTarget } from '../config/loaded.ts'
import type { Failure } from '../protocol/failures.ts'
import type { Variant } from '../protocol/variant.ts'
import type { RunApps } from './contract.ts'
import { failure } from '../protocol/failures.ts'
import { singleAppName } from '../protocol/messages.ts'
import { isWebUrl } from '../protocol/url.ts'

/**
 * The apps a run follows, however they were given. Milestone 1's mode is one app, `page`, with one target of the
 * same name, and its tests have no variants. Base URLs from the command line are already in place.
 */
export type RunConfig = {
  readonly apps: ReadonlyMap<string, LoadedApp>
  readonly defaultApp?: string
  readonly runs: readonly Readonly<Variant>[]
  readonly secrets: ReadonlyMap<string, LoadedSecret>
  readonly tags?: readonly string[]
  readonly states?: readonly string[]
  /** False in milestone 1's mode, whose tests have no variant and whose browser is the one given. */
  readonly variants: boolean
}

export type RunConfigResult = { ok: true; config: RunConfig } | { ok: false; failure: Failure }

/** The target of milestone 1's single app: the browser the command line named, with nothing to resolve. */
const singleTargetName = singleAppName

/**
 * The config a run follows. A base URL the command line gives for an app the config lacks, or one that is not
 * an http or https URL, is a usage failure.
 *
 * @example runConfig({ kind: 'browser', browserPath: '/usr/bin/chromium' }).ok // true
 */
export function runConfig(apps: RunApps): RunConfigResult {
  if (apps.kind === 'browser') return { ok: true, config: singleAppConfig(apps.browserPath, apps.baseUrl) }
  const { config, baseUrls = {} } = apps
  const problems: string[] = []
  const overridden = new Map(config.apps)
  for (const [name, baseUrl] of Object.entries(baseUrls)) {
    const app = config.apps.get(name)
    if (app === undefined) problems.push(`--base-url names the app ${JSON.stringify(name)}, which the config does not have.`)
    else if (!isWebUrl(URL.parse(baseUrl))) problems.push(`--base-url for ${name} must be an http or https URL, received ${JSON.stringify(baseUrl)}.`)
    else overridden.set(name, { ...app, baseUrl })
  }
  if (problems.length > 0) return { ok: false, failure: failure('usage', problems.join(' ')) }
  return { ok: true, config: { ...fromLoaded(config), apps: overridden } }
}

/** The config collection checks tests against: the loaded one, or milestone 1's single app. */
export function collectConfig(config: LoadedConfig | undefined): RunConfig {
  return config === undefined ? singleAppConfig() : fromLoaded(config)
}

function fromLoaded(config: LoadedConfig): RunConfig {
  const { apps, defaultApp, runs, secrets, tags, states } = config
  return {
    apps,
    ...(defaultApp === undefined ? {} : { defaultApp }),
    runs,
    secrets,
    ...(tags === undefined ? {} : { tags }),
    ...(states === undefined ? {} : { states }),
    variants: true,
  }
}

function singleAppConfig(browserPath?: string, baseUrl?: string): RunConfig {
  const target: LoadedTarget = {
    name: singleTargetName,
    browser: 'chromium',
    headless: true,
    ...(browserPath === undefined ? {} : { executablePath: browserPath }),
  }
  const app: LoadedApp = { name: singleAppName, ...(baseUrl === undefined ? {} : { baseUrl }), targets: new Map([[target.name, target]]) }
  return { apps: new Map([[app.name, app]]), defaultApp: app.name, runs: [], secrets: new Map(), variants: false }
}
