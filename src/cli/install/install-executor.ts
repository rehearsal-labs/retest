import type { CacheFolders, SourcePin } from '../../browser/builds.ts'
import type { NativeTools } from '../../native/processes.ts'
import type { InstallResult } from './install-archive.ts'
import { join } from 'node:path'
import { describePin, inspectBuild } from '../../browser/builds.ts'
import { ensureExecutorBuild } from '../../native/executors.ts'
import { systemTools } from '../../native/processes.ts'

/** What building one native executor needs. `tools` are the system's unless a test passes stand-ins. */
export type InstallExecutorOptions = {
  readonly pin: SourcePin
  readonly folders: CacheFolders
  /** The user's home folder, under which the runner keeps the executors' source checkouts. */
  readonly home: string
  readonly signal: AbortSignal
  readonly report: (line: string) => void
  readonly tools?: NativeTools | undefined
  readonly timeoutMs?: number | undefined
  readonly now?: (() => Date) | undefined
}

/**
 * The folders a native run builds the executors from (`src/runner/native-pool.ts`): one checkout of each executor's
 * repository, and the earlier derived data a build may take over. `retest install` uses the same, so a build it makes
 * is the one a run finds.
 *
 * @example executorSources('/Users/ada').webdriveragent // '/Users/ada/Library/Caches/retest-proofs/WebDriverAgent'
 */
export function executorSources(home: string): { readonly webdriveragent: string; readonly mac2: string; readonly adoptFrom: { readonly webdriveragent: string; readonly mac2: string } } {
  const root = join(home, 'Library', 'Caches', 'retest-proofs')
  return {
    webdriveragent: join(root, 'WebDriverAgent'),
    mac2: join(root, 'appium-mac2-driver'),
    adoptFrom: { webdriveragent: join(root, 'derived', 'wda-ios'), mac2: join(root, 'derived', 'mac2') },
  }
}

const defaultBuildTimeoutMs = 30 * 60_000

/**
 * Builds one native executor from its pinned commit into the cache, as a native run would on first use, and downloads
 * nothing: the source must already be a clean checkout of the pinned commit, and a missing or different one is
 * refused with the commands that make it. A build already recorded as the pin is left as it is, without running any
 * tool. The build step checks the Xcode build and the licence files, and copies the notices beside the build.
 *
 * @example await installExecutor({ pin, folders, home: process.env.HOME, signal, report: console.log })
 */
export async function installExecutor(options: InstallExecutorOptions): Promise<InstallResult> {
  const { pin, folders } = options
  const before = await inspectBuild(pin, folders)
  if (before.state === 'installed') return { ok: true, action: 'already_installed', inspection: before }
  if (before.state !== 'missing') return { ok: false, message: `${describePin(pin)} is in ${before.folder}, but not as recorded: ${before.problems.join(' ')} Remove ${before.folder} to build it again; a macOS runner built again needs its permissions granted again.`, stopped: false }
  const sources = executorSources(options.home)
  const stamp = (options.now ?? (() => new Date()))().toISOString().replace(/\.\d+Z$/, 'Z').replaceAll(':', '-')
  const logFile = join(folders.executors, 'logs', `${pin.engine}-install-${stamp}.log`)
  options.report(`Building ${describePin(pin)} from ${pin.engine === 'mac2' ? sources.mac2 : sources.webdriveragent} at ${pin.commit}; the log is ${logFile}`)
  const built = await ensureExecutorBuild({
    executor: pin.engine,
    sources: { webdriveragent: sources.webdriveragent, mac2: sources.mac2 },
    adoptFrom: [sources.adoptFrom[pin.engine]],
    cacheRoot: folders.executors,
    logFile,
    timeoutMs: options.timeoutMs ?? defaultBuildTimeoutMs,
    signal: options.signal,
    tools: options.tools ?? systemTools,
  })
  if (!built.ok) return { ok: false, message: built.failure.message, stopped: options.signal.aborted }
  const after = await inspectBuild(pin, folders)
  if (after.state !== 'installed') return { ok: false, message: `${describePin(pin)} was built into ${built.folder}, then did not read as installed: ${after.problems.join(' ')}`, stopped: false }
  return { ok: true, action: 'installed', inspection: after }
}
