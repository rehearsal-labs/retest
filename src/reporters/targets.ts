import type { Counts } from '../protocol/events.ts'
import type { BrowserInfo, RunResult, TestResult } from '../protocol/result.ts'
import type { RunRecord } from './run-record.ts'
import { variantKey, variantPairs, type Variant } from '../protocol/variant.ts'

/**
 * What a report knows about the targets of a run: the browser each app target ran in, by `app=target`, and for
 * each app the targets its tests used.
 */
export type RunTargets = {
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
  return { browsers: targetBrowsers(record, result), apps }
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
 * A variant as a report line names it: the targets that tell this run of a test from its others, and any
 * target that emulates a device, which is always marked. Undefined when there is nothing to say.
 *
 * @example variantLabel({ web: 'pixel', api: 'default' }, targets) // 'web=pixel (emulated)'
 */
export function variantLabel(variant: Variant | undefined, targets: RunTargets): string | undefined {
  const pairs = variantPairs(variant).flatMap((pair) => {
    const emulated = targets.browsers.get(pair)?.target?.emulation !== undefined
    if (emulated) return [`${pair} (emulated)`]
    return (targets.apps.get(pair.slice(0, pair.indexOf('=')))?.size ?? 0) > 1 ? [pair] : []
  })
  return pairs.length === 0 ? undefined : pairs.join(', ')
}

/**
 * Every target of a variant, each emulated one marked, for a view of one test. Undefined for a test with none.
 *
 * @example describeVariant({ web: 'pixel' }, targets) // 'web=pixel (emulated)'
 */
export function describeVariant(variant: Variant | undefined, targets: Pick<RunTargets, 'browsers'>): string | undefined {
  const pairs = variantPairs(variant).map((pair) => (targets.browsers.get(pair)?.target?.emulation === undefined ? pair : `${pair} (emulated)`))
  return pairs.length === 0 ? undefined : pairs.join(', ')
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
 * A browser as a person reads it: its name and version, and what it emulates.
 *
 * @example describeBrowser(browser) // 'Chrome 140.0.7339.80 as Pixel 9 · emulated'
 */
export function describeBrowser(browser: Pick<BrowserInfo, 'product' | 'version' | 'target'>): string {
  const name = browser.product.includes(browser.version) ? browser.product : `${browser.product} ${browser.version}`
  const { target } = browser
  if (target?.emulation === undefined) return name
  return target.device === undefined ? `${name} · emulated` : `${name} as ${target.device} · emulated`
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
    summary.counts[countName(test)]++
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
    if (browser === undefined) return []
    return [pairs.length === 1 ? describeBrowser(browser) : `${pair.slice(0, pair.indexOf('='))}: ${describeBrowser(browser)}`]
  })
  return described.join(', ')
}

function noCounts(): Counts {
  return { passed: 0, failed: 0, error: 0, notRun: 0, inconclusive: 0 }
}

function countName(test: TestResult): keyof Counts {
  return test.status === 'not_run' ? 'notRun' : test.status
}
