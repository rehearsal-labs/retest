import type { DriverName } from '../browser/contract.ts'
import type { LoadedApp, LoadedChromiumTarget, LoadedElectronTarget, LoadedFirefoxTarget, LoadedNativeTarget, LoadedTarget, LoadedWebKitTarget } from '../config/loaded.ts'
import type { Failure } from '../protocol/failures.ts'
import type { Variant } from '../protocol/variant.ts'

/**
 * A target and the driver that runs it, or the setup failure that refuses it by name. `electron` is the Chromium
 * driver on an Electron app's own debugging pipe: the app launches afresh for each test, and its first window is the
 * page.
 */
export type WebTargetDriver =
  | { ok: true; driver: 'chromium'; target: LoadedChromiumTarget }
  | { ok: true; driver: 'electron'; target: LoadedElectronTarget }
  | { ok: true; driver: 'firefox'; target: LoadedFirefoxTarget }
  | { ok: true; driver: 'webkit'; target: LoadedWebKitTarget }
  | { ok: false; failure: Failure }

export type TargetDriver = WebTargetDriver | { ok: true; driver: 'ios-simulator' | 'macos'; target: LoadedNativeTarget }

const driverNames: Readonly<Record<DriverName, string>> = {
  chromium: 'Chromium',
  firefox: 'Firefox',
  webkit: 'WebKit',
  'ios-simulator': 'iOS simulator apps',
  macos: 'macOS apps',
}

/**
 * The driver a target needs. Chromium, Chrome and Edge run on Retest's Chromium driver, and an Electron app on the
 * same driver over the app's own debugging pipe. Firefox runs on Retest's Firefox driver over WebDriver BiDi, and WebKit
 * on Retest's WebKit driver over the inspector pipe. An iOS simulator or macOS target is accepted in the config and
 * refused here, naming its app and target, when its driver is not given. No other driver runs it in its place, and no
 * browser stands in for an Electron app.
 *
 * @example targetDriver('web', { name: 'mac', platform: 'macos', appPath: '/Applications/Tasks.app' }).ok // false
 */
export function targetDriver(app: string, target: LoadedTarget): WebTargetDriver
export function targetDriver(app: string, target: LoadedTarget, options: { native: true }): TargetDriver
export function targetDriver(app: string, target: LoadedTarget, options?: { native: true }): TargetDriver {
  if ('platform' in target) return options?.native === true ? { ok: true, driver: target.platform, target } : noDriver(app, target.name, target.platform)
  if (target.browser === 'firefox') return { ok: true, driver: 'firefox', target }
  if (target.browser === 'webkit') return { ok: true, driver: 'webkit', target }
  if (target.browser === 'electron') return { ok: true, driver: 'electron', target }
  return { ok: true, driver: 'chromium', target }
}

/**
 * Why an attempt cannot run, decided before anything starts for it, or undefined when it can: a target with no
 * driver; a second app of the test on a native runtime another of its apps already takes, the desktop or one simulator
 * device type and runtime; or, for a setup, a target whose state cannot be saved, an Electron or native app. The first
 * refusal wins, in the order the attempt names its apps. A target the config lacks is left to the run, which fails that
 * attempt on its own terms.
 *
 * @example attemptRefusal({ desk: 'macos', notes: 'macos' }, config.apps)?.class // 'unsupported'
 */
export function attemptRefusal(targets: Variant, apps: ReadonlyMap<string, LoadedApp>, test: { setup?: boolean } = {}): Failure | undefined {
  // The native runtime each app needs, by the key the native pool holds it under: one desktop, and one simulator per
  // device type and runtime.
  const runtimes = new Map<string, string>()
  for (const [app, name] of Object.entries(targets)) {
    const target = apps.get(app)?.targets.get(name)
    if (target === undefined) continue
    const driver = targetDriver(app, target, { native: true })
    if (!driver.ok) return driver.failure
    if (test.setup === true) {
      const refused = setupRefusal(app, target)
      if (refused !== undefined) return refused
    }
    if (!('platform' in target)) continue
    const key = target.platform === 'macos' ? 'macos' : `${target.device} (${target.runtime})`
    const first = runtimes.get(key)
    if (first !== undefined) return sharedRuntime(first, app, target)
    runtimes.set(key, app)
  }
  return undefined
}

// One test drives one app per native runtime: the desktop's runner and a simulator each serve one app session at a
// time, and sharing one between the apps of a test is not built.
function sharedRuntime(first: string, app: string, target: LoadedNativeTarget): Failure {
  const where = target.platform === 'macos' ? "this Mac's desktop" : `one ${target.device ?? 'iPhone'} simulator on iOS ${target.runtime ?? ''}`.trimEnd()
  const fix = target.platform === 'macos' ? 'Use one macOS app in a test.' : 'Give each app its own device type or runtime.'
  const message = `Not run: the apps ${first} and ${app} of this test both run on ${where}, and Retest drives one app there per test. ${fix}`
  return { class: 'unsupported', message, details: { apps: `${first}, ${app}`, target: target.name } }
}

// A setup saves the state of its app's browser storage. An Electron app keeps its own storage and a native app has none,
// so a setup on either is refused before its body runs; the page's own refusal stays behind it.
function setupRefusal(app: string, target: LoadedTarget): Failure | undefined {
  const isElectron = 'browser' in target && target.browser === 'electron'
  if (!isElectron && !('platform' in target)) return undefined
  const reason = isElectron ? `the Electron app ${app} keeps its own storage. Set userDataDir to keep the app's data from one launch to the next` : `the native app ${app} has no browser storage`
  return { class: 'unsupported', message: `Not run: a setup saves a sign-in state from its app's browser storage, and ${reason}.`, details: { app, target: target.name } }
}

function noDriver(app: string, target: string, driver: DriverName): WebTargetDriver {
  const message = `Retest has no driver for ${driverNames[driver]} yet, so it cannot start the target ${target} of the app ${app}.`
  return { ok: false, failure: { class: 'setup_failed', message, details: { app, target, driver } } }
}
