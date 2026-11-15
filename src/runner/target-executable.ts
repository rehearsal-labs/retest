import type { ExecutableRequest, ResolvedExecutable } from '../browser/executables.ts'
import type { LoadedChromiumTarget, LoadedTarget } from '../config/loaded.ts'
import { installedBuild } from '../browser/builds.ts'
import { resolveExecutable, systemHost } from '../browser/executables.ts'

/**
 * Whether a run of the target starts Chrome's headless shell: a headless `chromium()` target does unless it says
 * `headlessShell: false` or names an `executablePath`, which runs what it names unless the target says
 * `headlessShell: true`. A shown run never does, since the shell cannot show a window.
 *
 * @example runsHeadlessShell({ name: 'chromium', browser: 'chromium', headless: true }) // true
 */
export function runsHeadlessShell(target: LoadedTarget): boolean {
  if ('platform' in target || target.browser !== 'chromium' || !target.headless) return false
  return target.headlessShell ?? target.executablePath === undefined
}

/**
 * What a config target asks the browser module to find: the headless shell for a headless `chromium()` target, Chrome
 * for Testing for a shown one or one with `headlessShell: false`, the path a target names, or the channel of Chrome or
 * Edge.
 *
 * @example executableRequest({ name: 'beta', browser: 'chrome', channel: 'beta', headless: true }) // { product: 'chrome', channel: 'beta' }
 */
export function executableRequest(target: LoadedChromiumTarget): ExecutableRequest {
  if (target.browser !== 'chromium') return { product: target.browser, channel: target.channel }
  const product = runsHeadlessShell(target) ? 'headless-shell' : 'chromium'
  return target.executablePath === undefined ? { product } : { product, executablePath: target.executablePath }
}

/**
 * Finds a target's executable on this machine: the path it names, RETEST_HEADLESS_SHELL or RETEST_CHROMIUM, the pinned
 * build in Retest's cache, or where Chrome and Edge install. A build from the cache runs only once its files read as its
 * pin and record say; a damaged one fails setup by name.
 *
 * @example await findTargetExecutable(target) // { ok: true, path: '/home/ada/.cache/retest/browsers/headless-shell-…/chrome-headless-shell', cached: 'headless-shell' }
 */
export async function findTargetExecutable(target: LoadedChromiumTarget): Promise<ResolvedExecutable> {
  const found = resolveExecutable(executableRequest(target), systemHost())
  if (!found.ok || found.cached === undefined) return found
  const build = await installedBuild(found.cached, process.env)
  if (build.state === 'installed') return { ok: true, path: build.executablePath, cached: found.cached }
  const message = build.state === 'damaged' ? build.message : `The pinned build at ${found.path} was gone when Retest checked it: run npx retest install chromium.`
  return { ok: false, failure: { class: 'setup_failed', message }, tried: [found.path] }
}
