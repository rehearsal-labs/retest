import type { LaunchOptions, OwnedBrowser, WebEngine, WebRuntime, WebRuntimeIdentity } from '../browser/contract.ts'
import { LaunchError, webRuntimeIdentity } from '../browser/contract.ts'
import { launchFirefox } from '../browser/firefox/launch.ts'
import { firefoxRoute } from '../browser/firefox/route.ts'
import { launchBrowser } from '../browser/launch.ts'
import { launchWebKit } from '../browser/webkit/browser.ts'
import { isPlainObject } from '../protocol/schema.ts'

// Where agent sessions run: targets the host names, each on one web engine, launched by that engine's own driver. A
// session asks for a target and its engine by name, and an engine is never run in another's place: a target on another
// engine, an engine with no launcher, or a browser that reports another engine than its target's is refused by name.

/**
 * A browser an agent host may start sessions in: its engine, the executable that starts it (for WebKit, the build's
 * folder or the executable inside it), and whether it shows a window, which it does not by default.
 *
 * @example const target: AgentTarget = { engine: 'chromium', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }
 */
export type AgentTarget = { readonly engine: WebEngine; readonly executablePath: string; readonly headless?: boolean }

/** Starts a browser of one engine within `timeoutMs`, throwing a `LaunchError` that names the problem when it cannot. */
export type AgentLauncher = (options: LaunchOptions, timeoutMs: number) => Promise<OwnedBrowser>

/** A launcher for each engine a host starts; an engine left out has the driver's own. */
export type AgentLaunchers = Readonly<Partial<Record<WebEngine, AgentLauncher>>>

/**
 * Each engine's own launcher: Chromium over its DevTools pipe, Firefox over WebDriver BiDi on the route
 * `RETEST_FIREFOX_ROUTE` names (a spawned child by default), and a WebKit build over its inspector pipe, whose
 * environment the driver sets in full, so `hiddenVariables` has nothing to hide from it.
 */
export const driverLaunchers: Readonly<Record<WebEngine, AgentLauncher>> = {
  chromium: (options, timeoutMs) => launchBrowser(options, timeoutMs),
  firefox: (options, timeoutMs) => {
    const route = firefoxRoute(process.env)
    if (!route.ok) return Promise.reject(new LaunchError(route.message))
    return launchFirefox({ ...options, route: route.route }, timeoutMs)
  },
  webkit: (options, timeoutMs) => {
    const redacting = options.redact === undefined ? {} : { redact: options.redact }
    const streaming = options.redactStream === undefined ? {} : { redactStream: options.redactStream }
    return launchWebKit({ buildPath: options.executablePath, buildSource: 'the agent target', logFile: options.logFile, headless: options.headless, ...redacting, ...streaming }, timeoutMs)
  },
}

/**
 * The engine a browser says it runs, when it says: a web runtime states its engine in its identity; a browser that
 * states none is taken as its launcher's.
 *
 * @example statedEngine(firefoxBrowser) // 'firefox'
 */
export function statedEngine(browser: OwnedBrowser): WebEngine | undefined {
  return isWebRuntime(browser) ? browser.identity.engine : undefined
}

/**
 * The identity of the browser a session runs on: the one a web runtime reports, or one read from what the browser
 * reported at launch under the engine its launcher drives.
 *
 * @example runtimeIdentity(browser, 'chromium').engine // 'chromium'
 */
export function runtimeIdentity(browser: OwnedBrowser, engine: WebEngine): WebRuntimeIdentity {
  return isWebRuntime(browser) ? browser.identity : webRuntimeIdentity(browser, engine)
}

/** Whether a browser is a web runtime, which states its identity. */
export function isWebRuntime(browser: OwnedBrowser): browser is WebRuntime {
  return 'identity' in browser && isPlainObject(browser.identity) && browser.identity['kind'] === 'web'
}
