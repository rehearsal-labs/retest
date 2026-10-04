import type { TestContext } from 'node:test'
import type { EventBody } from '../../src/protocol/events.ts'
import type { ExecutorBuild, ExecutorName } from '../../src/native/executors.ts'
import type { PreparedAttempt } from '../../src/runner/preparation.ts'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLIENT_HEADER } from '../../fixtures/cross-platform/service/clients.ts'
import { automationModeProblem } from '../../src/native/macos-app.ts'
import { checkXcode, ensureExecutorBuild, nativePins } from '../../src/native/executors.ts'
import { listSimulatorRuntimes } from '../../src/native/ios-simulator.ts'
import { listProcesses, runCommand, systemTools } from '../../src/native/processes.ts'
import { prepareAttempt } from '../../src/runner/preparation.ts'

// What the native integration tests share: where the executor clones and the fixture apps' builds live on this Mac,
// the check that the real prerequisites are there (a test without them is skipped by name and stays unverified, and a
// prerequisite that cannot be read fails the file instead), the executor build, and the host preparation path run
// against the cross-platform fixture service.

export const proofsCache: string = join(homedir(), 'Library', 'Caches', 'retest-proofs')
export const executorSources: Readonly<Record<ExecutorName, string>> = { webdriveragent: join(proofsCache, 'WebDriverAgent'), mac2: join(proofsCache, 'appium-mac2-driver') }
const adoptFrom: Readonly<Record<ExecutorName, readonly string[]>> = { webdriveragent: [join(proofsCache, 'derived', 'wda-ios')], mac2: [join(proofsCache, 'derived', 'mac2')] }
export const taskPhoneApp: string = join(proofsCache, 'derived', 'taskphone', 'Build', 'Products', 'Debug-iphonesimulator', 'TaskPhone.app')
export const taskDeskApp: string = join(proofsCache, 'derived', 'taskdesk', 'Build', 'Products', 'Debug', 'TaskDesk.app')

/**
 * Why the native tests for a platform cannot run on this machine, or undefined when they can: macOS, the pinned Xcode,
 * the executor's source, the fixture app's build, and the iOS runtime or Automation Mode without a dialog. Rejects when
 * one of them cannot be read, so the file fails rather than passing as skipped.
 */
export async function nativeSkipReason(platform: 'ios-simulator' | 'macos'): Promise<string | undefined> {
  if (process.platform !== 'darwin') return 'needs macOS with Xcode'
  const version = await runCommand(systemTools.xcodebuild, ['-version'], { timeoutMs: 30_000 })
  if (!version.started) return 'Xcode is not installed'
  if (version.timedOut) throw new Error('xcodebuild -version did not answer within 30 s, so Retest could not read which Xcode this Mac has.')
  const xcode = await checkXcode(systemTools, nativePins.toolchain)
  if (xcode !== undefined) return xcode.message
  const executor = platform === 'ios-simulator' ? 'webdriveragent' : 'mac2'
  for (const path of [executorSources[executor], executorSources.webdriveragent, platform === 'ios-simulator' ? taskPhoneApp : taskDeskApp]) {
    const missing = await access(path).then(() => false, (error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true
      throw new Error(`Retest could not read whether ${path} is there: ${error instanceof Error ? error.message : String(error)}`)
    })
    if (missing) return `${path} is missing`
  }
  if (platform === 'ios-simulator') {
    const runtimes = await listSimulatorRuntimes(systemTools, { timeoutMs: 30_000 })
    if (!Array.isArray(runtimes)) throw new Error(`Retest could not read the installed simulator runtimes: ${runtimes.message}`)
    if (!runtimes.some((runtime) => runtime.version === '26.5' && runtime.build === '23F77')) return 'the iOS 26.5 (23F77) simulator runtime is not installed'
    return undefined
  }
  const automation = await automationModeProblem(systemTools)
  if (automation?.details?.['automationMode'] === 'needs_administrator') return automation.message
  if (automation !== undefined) throw new Error(automation.message)
  return undefined
}

/** The executor build for the tested set, built once into Retest's cache or found there. */
export async function executorBuild(executor: ExecutorName, logFolder: string): Promise<ExecutorBuild> {
  const ensured = await ensureExecutorBuild({ executor, sources: executorSources, adoptFrom: adoptFrom[executor], logFile: join(logFolder, `${executor}-build.log`), timeoutMs: 30 * 60_000, tools: systemTools })
  if (!ensured.ok) throw new Error(ensured.failure.message)
  return ensured.build
}

/** A folder for logs that is removed after the test. */
export async function logFolder(t: TestContext, name: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), `retest-native-${name}-`))
  t.after(() => rm(folder, { recursive: true, force: true }))
  return folder
}

/** The processes whose command line holds `text`. */
export async function processesWith(text: string): Promise<{ readonly pid: number; readonly command: string }[]> {
  return (await listProcesses(systemTools, 10_000)).filter((entry) => entry.command.includes(text))
}

/**
 * The addresses something listens on at `port`, as lsof names them, such as `127.0.0.1:51815` or `*:9100`.
 *
 * @example await listeningAddresses(51815) // ['127.0.0.1:51815']
 */
export async function listeningAddresses(port: number): Promise<string[]> {
  const result = await runCommand('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { timeoutMs: 10_000 })
  return result.stdout.split('\n').slice(1).flatMap((line) => {
    const name = /(\S+:\d+) \(LISTEN\)/.exec(line)?.[1]
    return name === undefined ? [] : [name]
  })
}

/**
 * The addresses one process listens on, as lsof names them.
 *
 * @example await listeningOf(4242) // ['127.0.0.1:51815']
 */
export async function listeningOf(pid: number): Promise<string[]> {
  const result = await runCommand('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], { timeoutMs: 10_000 })
  return result.stdout.split('\n').slice(1).flatMap((line) => {
    const name = /(\S+:\d+) \(LISTEN\)/.exec(line)?.[1]
    return name === undefined ? [] : [name]
  })
}

/** The Mac's main screen in points, as AppKit gives it, with its origin at the top left as the window server's. */
export async function mainScreen(): Promise<{ x: number; y: number; width: number; height: number }> {
  const script = "ObjC.import('AppKit'); const frame = $.NSScreen.mainScreen.frame; JSON.stringify([frame.size.width, frame.size.height])"
  const result = await runCommand('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeoutMs: 10_000 })
  const parsed: unknown = JSON.parse(result.stdout)
  if (!Array.isArray(parsed) || typeof parsed[0] !== 'number' || typeof parsed[1] !== 'number') throw new Error('the main screen could not be read')
  return { x: 0, y: 0, width: parsed[0], height: parsed[1] }
}

/** Waits for `promise` at most `timeoutMs`, and fails with `message` when it has not settled by then. */
export async function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  try {
    return await Promise.race([promise, late])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Runs Retest's host preparation path for one attempt, as the runner does before the attempt's first action: a
 * preparation that resets the fixture service through its reset route, and a cleanup that resets it again. The events
 * it would emit are kept for the test.
 */
export async function prepareFixtureService(serviceUrl: string, app: string): Promise<{ readonly prepared: PreparedAttempt; readonly events: EventBody[] }> {
  const events: EventBody[] = []
  const reset = async (): Promise<void> => {
    const response = await fetch(new URL('/admin/reset', serviceUrl), { method: 'POST', headers: { [CLIENT_HEADER]: 'test' }, signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error(`the reset route answered ${response.status}`)
  }
  const prepared = await prepareAttempt({
    preparations: [{ key: 'native-lifecycle', apps: [app], preparation: {
      prepare: async () => {
        await reset()
        return { status: 'prepared', recipe: 'cross-platform service reset', metadata: { route: '/admin/reset' } }
      },
      cleanup: reset,
    } }],
    scope: { testId: 'native-lifecycle', attemptId: 'native-attempt', file: 'tests/integration/native-lifecycle.retest.ts' },
    timeouts: { setup: 10_000, cleanup: 10_000 },
    stopped: new Promise(() => undefined),
    interruption: () => undefined,
    emit: (body) => events.push(body),
    redact: (text) => text,
  })
  return { prepared, events }
}
