import type { DriverName } from '../browser/contract.ts'
import type { LoadedApp, LoadedChromiumTarget, LoadedTarget } from '../config/loaded.ts'
import type { Failure } from '../protocol/failures.ts'
import type { Variant } from '../protocol/variant.ts'

/** A target and the driver that runs it, or the setup failure that refuses it by name. */
export type TargetDriver = { ok: true; driver: 'chromium'; target: LoadedChromiumTarget } | { ok: false; failure: Failure }

const driverNames: Readonly<Record<DriverName, string>> = {
  chromium: 'Chromium',
  firefox: 'Firefox',
  webkit: 'WebKit',
  'ios-simulator': 'iOS simulator apps',
  macos: 'macOS apps',
}

/**
 * The driver a target needs. Chromium, Chrome and Edge run on Retest's Chromium driver. A Firefox, WebKit, iOS
 * simulator or macOS target is accepted in the config and refused here, naming its app and target, because its
 * driver does not exist yet. No other driver runs it in its place.
 *
 * @example targetDriver('web', { name: 'firefox', browser: 'firefox', headless: true }).ok // false
 */
export function targetDriver(app: string, target: LoadedTarget): TargetDriver {
  if ('platform' in target) return noDriver(app, target.name, target.platform)
  if (target.browser === 'firefox' || target.browser === 'webkit') return noDriver(app, target.name, target.browser)
  return { ok: true, driver: 'chromium', target }
}

/**
 * Why an attempt cannot run because one of its targets has no driver: the refusal of the first such target, in the
 * order the attempt names its apps, or undefined when every target has one. A target the config lacks is left to
 * the run, which fails that attempt on its own terms.
 *
 * @example attemptRefusal({ web: 'chromium', mac: 'macos' }, config.apps)?.message // 'Retest has no driver for macOS apps yet, …'
 */
export function attemptRefusal(targets: Variant, apps: ReadonlyMap<string, LoadedApp>): Failure | undefined {
  for (const [app, name] of Object.entries(targets)) {
    const target = apps.get(app)?.targets.get(name)
    if (target === undefined) continue
    const driver = targetDriver(app, target)
    if (!driver.ok) return driver.failure
  }
  return undefined
}

function noDriver(app: string, target: string, driver: DriverName): TargetDriver {
  const message = `Retest has no driver for ${driverNames[driver]} yet, so it cannot start the target ${target} of the app ${app}.`
  return { ok: false, failure: { class: 'setup_failed', message, details: { app, target, driver } } }
}
