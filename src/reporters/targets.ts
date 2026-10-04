import type { Counts } from '../protocol/events.ts'
import type { BrowserInfo, NativeInfo, RunResult } from '../protocol/result.ts'
import type { RunRecord } from './run-record.ts'
import { withoutCredentials } from '../protocol/url.ts'
import { variantKey, variantPairs, type Variant } from '../protocol/variant.ts'
import { addToCounts } from '../runner/outcome.ts'
import { printable } from './format.ts'

/**
 * What a report knows about the targets of a run: the browser each app target ran in, by `app=target`, and for
 * each app the targets its tests used.
 */
export type RunTargets = {
  natives?: ReadonlyMap<string, NativeInfo>
  browsers: ReadonlyMap<string, BrowserInfo>
  apps: ReadonlyMap<string, ReadonlySet<string>>
}

/** One target's line in a summary: its variant key, the browser it ran in, and how its tests ended. */
export type TargetSummary = { label: string; browser: string; counts: Counts; durationMs: number }

/**
 * The targets the events and the result name. A result read without its events still lists its browsers.
 *
 * @example runTargets(record, result).browsers.get('web=beta')?.version
 */
export function runTargets(record: RunRecord, result?: RunResult): RunTargets {
  const apps = new Map<string, Set<string>>()
  const results = result?.files.flatMap((file) => file.tests) ?? []
  for (const { variant } of [...record.tests.values(), ...results]) {
    for (const [app, target] of Object.entries(variant ?? {})) apps.set(app, (apps.get(app) ?? new Set()).add(target))
  }
  const natives = new Map<string, NativeInfo>()
  for (const native of [...(result?.natives ?? []), ...record.natives]) natives.set(variantKey({ [native.app]: native.target }), native)
  return { browsers: targetBrowsers(record, result), natives, apps }
}

/**
 * The browser each app target ran in, by `app=target`.
 *
 * @example targetBrowsers(record).get('web=pixel')?.target?.device // 'Pixel 9'
 */
function targetBrowsers(record: RunRecord, result?: RunResult): ReadonlyMap<string, BrowserInfo> {
  const browsers = new Map<string, BrowserInfo>()
  for (const browser of [...(result?.browsers ?? []), ...record.browsers]) {
    const { product, version, executablePath, app, target } = browser
    if (app === undefined || target === undefined) continue
    browsers.set(variantKey({ [app]: target.name }), { product, version, executablePath, app, target })
  }
  return browsers
}

/**
 * A variant as a report line names it: the targets that tell this run of a test from its others, any target that
 * emulates a device, which is always marked, and any Electron app, which is always named. Undefined when there is
 * nothing to say.
 *
 * @example variantLabel({ web: 'pixel', api: 'default' }, targets) // 'web=pixel (emulated)'
 */
export function variantLabel(variant: Variant | undefined, targets: RunTargets): string | undefined {
  const pairs = variantPairs(variant).flatMap((pair) => {
    const marked = markedPair(pair, targets)
    if (marked !== pair) return [marked]
    return (targets.apps.get(pair.slice(0, pair.indexOf('=')))?.size ?? 0) > 1 ? [pair] : []
  })
  return pairs.length === 0 ? undefined : pairs.join(', ')
}

/**
 * Every target of a variant, each emulated one and each Electron app marked, for a view of one test. Undefined for a
 * test with none.
 *
 * @example describeVariant({ web: 'pixel', desktop: 'electron' }, targets) // 'web=pixel (emulated), desktop=electron (Electron)'
 */
export function describeVariant(variant: Variant | undefined, targets: Pick<RunTargets, 'browsers' | 'natives'>): string | undefined {
  const pairs = variantPairs(variant).map((pair) => markedPair(pair, targets))
  return pairs.length === 0 ? undefined : pairs.join(', ')
}

// A target that emulates a screen is marked as emulated, and an Electron app as one, since neither is a plain browser.
function markedPair(pair: string, targets: Pick<RunTargets, 'browsers' | 'natives'>): string {
  const native = targets.natives?.get(pair)
  if (native !== undefined) return `${pair} (${describeNative(native)})`
  const target = targets.browsers.get(pair)?.target
  if (target?.emulation !== undefined) return `${pair} (emulated)`
  return target?.electron === undefined ? pair : `${pair} (Electron)`
}

/**
 * The part of a variant a command must name to pick it out: each app that ran on more than one target.
 * Undefined when none did.
 *
 * @example namingTargets({ web: 'beta', api: 'default' }, targets) // { web: 'beta' }
 */
export function namingTargets(variant: Variant | undefined, targets: RunTargets): Variant | undefined {
  const named = Object.entries(variant ?? {}).filter(([app]) => (targets.apps.get(app)?.size ?? 0) > 1)
  return named.length === 0 ? undefined : Object.fromEntries(named)
}

/**
 * A browser as a person reads it: its name and version, what it emulates, and for an Electron app the Chromium it
 * embeds.
 *
 * @example describeBrowser(browser) // 'Chrome 140.0.7339.80 as Pixel 9 · emulated'
 * @example describeBrowser(app) // 'Electron 44.5.1 · Chromium 152.0.7977.130'
 */
export function describeBrowser(browser: Pick<BrowserInfo, 'product' | 'version' | 'target'>): string {
  const name = browser.product.includes(browser.version) ? browser.product : `${browser.product} ${browser.version}`
  const { target } = browser
  if (target?.electron !== undefined) return `${name} · Chromium ${target.electron.chromium}`
  if (target?.emulation === undefined) return name
  return target.device === undefined ? `${name} · emulated` : `${name} as ${target.device} · emulated`
}

/**
 * The proxy a target's pages go through, and its bypass rules. A user name or password never shows, even in a
 * server address that carries one.
 *
 * @example describeProxy({ server: 'http://127.0.0.1:8080', bypass: ['<-loopback>'] }) // 'proxy http://127.0.0.1:8080 · bypass <-loopback>'
 */
export function describeProxy(proxy: { readonly server: string; readonly bypass?: readonly string[] | undefined }): string {
  const bypass = proxy.bypass ?? []
  const rules = bypass.length === 0 ? '' : ` · bypass ${bypass.map(printable).join(', ')}`
  return `proxy ${printable(withoutCredentials(proxy.server))}${rules}`
}

/**
 * One summary per variant, in the order they first ran. Tests with no variant are left out.
 *
 * @example targetSummaries(result, targets).length // 3
 */
export function targetSummaries(result: RunResult, targets: RunTargets): TargetSummary[] {
  const summaries = new Map<string, TargetSummary>()
  for (const test of result.files.flatMap((file) => file.tests)) {
    if (test.variant === undefined || Object.keys(test.variant).length === 0) continue
    const key = variantKey(test.variant)
    const summary = summaries.get(key) ?? { label: key, browser: variantBrowser(test.variant, targets), counts: noCounts(), durationMs: 0 }
    addToCounts(summary.counts, test.status)
    summary.durationMs += test.durationMs
    summaries.set(key, summary)
  }
  return [...summaries.values()]
}

/**
 * How a summary says the tests ran on several targets, or nothing when they ran on one.
 *
 * @example acrossTargets(3) // ' across 3 targets'
 */
export function acrossTargets(count: number): string {
  return count > 1 ? ` across ${count} targets` : ''
}

function variantBrowser(variant: Variant, targets: RunTargets): string {
  const pairs = variantPairs(variant)
  const described = pairs.flatMap((pair) => {
    const browser = targets.browsers.get(pair)
    const native = targets.natives?.get(pair)
    if (native !== undefined) return [pairs.length === 1 ? describeNative(native) : `${pair.slice(0, pair.indexOf('='))}: ${describeNative(native)}`]
    if (browser === undefined) return []
    return [pairs.length === 1 ? describeBrowser(browser) : `${pair.slice(0, pair.indexOf('='))}: ${describeBrowser(browser)}`]
  })
  return described.join(', ')
}

function noCounts(): Counts {
  return { passed: 0, failed: 0, error: 0, notRun: 0, inconclusive: 0 }
}


/** The app and operating system the native executor exercised. */
export function describeNative(native: Pick<NativeInfo, 'product' | 'identity'>): string {
  return `${native.product} on ${native.identity.platform === 'macos' ? 'macOS' : `iOS Simulator ${native.identity.os.version}`}`
}
