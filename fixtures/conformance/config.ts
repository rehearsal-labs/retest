import type { ChromiumOptions, FirefoxTarget, Viewport, WebKitTarget } from '@rehearsal-labs/retest'

// What every conformance config shares. The runner in `tests/conformance/run.ts` names the engine, the browser to
// launch and the task app's address in the environment, so one config file per folder serves Chrome, Firefox and
// WebKit alike. A config with a missing or unknown value fails to load, naming the variable.

/** The engines the conformance cases run on. */
export const engines = ['chrome', 'firefox', 'webkit'] as const

export type Engine = (typeof engines)[number]

/** The variables the conformance configs and tests read, set by the runner for each run. */
export const conformanceVariables: {
  readonly engine: 'RETEST_CONFORMANCE_ENGINE'
  readonly executable: 'RETEST_CONFORMANCE_EXECUTABLE'
  readonly baseUrl: 'RETEST_CONFORMANCE_BASE_URL'
  readonly password: 'RETEST_CONFORMANCE_PASSWORD'
  readonly workflowPassword: 'RETEST_CONFORMANCE_WORKFLOW_PASSWORD'
  readonly serverCommand: 'RETEST_CONFORMANCE_SERVER_COMMAND'
  readonly serverUrl: 'RETEST_CONFORMANCE_SERVER_URL'
} = {
  engine: 'RETEST_CONFORMANCE_ENGINE',
  executable: 'RETEST_CONFORMANCE_EXECUTABLE',
  baseUrl: 'RETEST_CONFORMANCE_BASE_URL',
  password: 'RETEST_CONFORMANCE_PASSWORD',
  workflowPassword: 'RETEST_CONFORMANCE_WORKFLOW_PASSWORD',
  serverCommand: 'RETEST_CONFORMANCE_SERVER_COMMAND',
  serverUrl: 'RETEST_CONFORMANCE_SERVER_URL',
}

type ChromiumTarget = ChromiumOptions & { readonly browser: 'chromium' }

/** A target on one of the three engines, as an app's own target or one of its `targets`. */
export type ConformanceTarget = ChromiumTarget | FirefoxTarget | WebKitTarget

/** The value of a variable the runner sets, or an error that names it. */
export function requiredVariable(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is not set. The conformance runner in tests/conformance/run.ts sets it.`)
  return value
}

/** The engine this run is for. */
export function conformanceEngine(): Engine {
  const value = requiredVariable(conformanceVariables.engine)
  const engine = engines.find((each) => each === value)
  if (engine === undefined) throw new Error(`${conformanceVariables.engine} must be chrome, firefox or webkit, received ${value}`)
  return engine
}

/** The task app's origin, such as `http://127.0.0.1:53124`. */
export function conformanceBaseUrl(): string {
  return requiredVariable(conformanceVariables.baseUrl)
}

/**
 * The target of this run's engine, from the executable the runner names: Chrome on the Chromium driver, Firefox, and
 * WebKit from its build's folder or the executable inside it. Without one, Firefox and WebKit leave the driver to find
 * its own.
 *
 * @example conformanceTarget({ viewport: { width: 600, height: 800 } })
 */
export function conformanceTarget(settings: { readonly viewport?: Viewport } = {}): ConformanceTarget {
  const engine = conformanceEngine()
  const given = process.env[conformanceVariables.executable]
  const executablePath = given === undefined || given === '' ? undefined : given
  if (engine === 'chrome') {
    if (executablePath === undefined) throw new Error(`${conformanceVariables.executable} must name the Chrome executable for a run on chrome.`)
    return { browser: 'chromium', executablePath, viewport: settings.viewport }
  }
  if (engine === 'firefox') return { browser: 'firefox', executablePath, viewport: settings.viewport }
  return { browser: 'webkit', executablePath, viewport: settings.viewport }
}
