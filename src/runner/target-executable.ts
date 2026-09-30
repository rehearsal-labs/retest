import type { ExecutableRequest, ResolvedExecutable } from '../browser/executables.ts'
import type { LoadedTarget } from '../config/loaded.ts'
import { resolveExecutable, systemHost } from '../browser/executables.ts'

/**
 * What a config target asks the browser module to find: the path `chromium()` names, or the channel of Chrome or
 * Edge.
 *
 * @example executableRequest({ name: 'beta', browser: 'chrome', channel: 'beta', headless: true }) // { product: 'chrome', channel: 'beta' }
 */
export function executableRequest(target: LoadedTarget): ExecutableRequest {
  if (target.browser !== 'chromium') return { product: target.browser, channel: target.channel }
  return target.executablePath === undefined ? { product: 'chromium' } : { product: 'chromium', executablePath: target.executablePath }
}

/**
 * Finds a target's executable on this machine: the path it names, RETEST_CHROMIUM for `chromium()`, or where
 * Chrome and Edge install.
 *
 * @example await findTargetExecutable(target) // { ok: true, path: '/Applications/Google Chrome Beta.app/...' }
 */
export async function findTargetExecutable(target: LoadedTarget): Promise<ResolvedExecutable> {
  return resolveExecutable(executableRequest(target), systemHost())
}
