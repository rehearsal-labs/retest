import type { OwnedBrowser } from '../../browser/contract.ts'
import type { LoadedApp, LoadedConfig, LoadedTarget } from '../../config/loaded.ts'
import type { Timeouts } from '../../protocol/timeouts.ts'
import type { AppServerHandle } from '../../runner/app-server.ts'
import type { ResolvedSecrets } from '../../runner/secrets.ts'
import type { CliDependencies } from '../command.ts'
import { join } from 'node:path'
import { errorMessage } from '../../protocol/failures.ts'
import { appLogFile, targetBrowserLogFile } from '../../protocol/run-folder.ts'
import { variantKey } from '../../protocol/variant.ts'
import { describeRunning, describeStarted } from '../../reporters/format.ts'
import { describeBrowser } from '../../reporters/targets.ts'
import { Redactor } from '../../runner/redactor.ts'
import { resolveSecrets } from '../../runner/secrets.ts'

/** One thing `doctor` checked: what, how it went, and for a problem, how to fix it. */
export type Check = { group: string; subject: string; ok: boolean; text: string; detail?: string; fix?: string }

export type CheckDependencies = Pick<
  CliDependencies,
  'resolveExecutable' | 'launchBrowser' | 'probeReady' | 'startAppServer' | 'env' | 'signal'
>

export type CheckContext = { dependencies: CheckDependencies; timeouts: Timeouts; logFolder: string }

type Launched = { ok: true; browser: Pick<OwnedBrowser, 'product' | 'version' | 'executablePath'> } | { ok: false; message: string; logFile: string }
/** An `env` secret as `doctor` reads it, on its own, so that every one is reported. */
type EnvironmentSecret = { name: string; variable: string; resolved: ResolvedSecrets }

/**
 * Checks every target of every app, then each app's address, then the secrets read from the environment. Each
 * browser is launched once and closed; a server `doctor` starts is stopped again, and one that was already
 * running is left alone. The secrets are read first, so the log of a server that prints its settings never
 * holds one.
 *
 * @example const checks = await runChecks(config, { dependencies, timeouts, logFolder })
 */
export async function runChecks(config: LoadedConfig, context: CheckContext): Promise<Check[]> {
  const checks: Check[] = []
  const launches = new Map<string, Promise<Launched>>()
  const secrets = environmentSecrets(config, context.dependencies.env)
  const redactor = redactorFor(secrets)
  for (const app of config.apps.values()) {
    for (const target of app.targets.values()) {
      if (context.dependencies.signal.aborted) return checks
      checks.push(await checkTarget(app, target, { ...context, launches }))
    }
    if (context.dependencies.signal.aborted) return checks
    const server = await checkServer(app, { ...context, redactor })
    if (server !== undefined) checks.push(server)
  }
  checks.push(...checkSecrets(secrets))
  return checks
}

type TargetContext = CheckContext & { launches: Map<string, Promise<Launched>> }

async function checkTarget(app: LoadedApp, target: LoadedTarget, context: TargetContext): Promise<Check> {
  const subject = targetCall(target)
  const found = context.dependencies.resolveExecutable(target)
  if (!found.ok) return { group: app.name, subject, ok: false, text: found.failure.message }
  // Targets that differ only in emulation launch the same browser, so it is launched once.
  const key = JSON.stringify([found.path, target.headless])
  const launch = { executablePath: found.path, appTarget: variantKey({ [app.name]: target.name }), headless: target.headless }
  const launching = context.launches.get(key) ?? launchOnce(launch, context)
  context.launches.set(key, launching)
  const launched = await launching
  if (!launched.ok) return { group: app.name, subject, ok: false, text: launched.message, fix: `The browser's log is at ${launched.logFile}.` }
  return { group: app.name, subject, ok: true, text: describeBrowser(launched.browser), detail: launched.browser.executablePath }
}

type Launch = { executablePath: string; headless: boolean; appTarget: string }

// The log is named after the app target, as a run names it.
async function launchOnce({ executablePath, headless, appTarget }: Launch, context: CheckContext): Promise<Launched> {
  const { dependencies, timeouts } = context
  const logFile = join(context.logFolder, targetBrowserLogFile(appTarget))
  let browser: OwnedBrowser
  try {
    browser = await dependencies.launchBrowser({ executablePath, logFile, headless }, timeouts.setup)
  } catch (error) {
    return { ok: false, message: errorMessage(error), logFile }
  }
  try {
    await browser.close(timeouts.cleanup)
  } catch (error) {
    return { ok: false, message: `${describeBrowser(browser)} started, then did not close: ${errorMessage(error)}`, logFile }
  }
  return { ok: true, browser: { product: browser.product, version: browser.version, executablePath: browser.executablePath } }
}

type ServerContext = CheckContext & { redactor: Redactor }

async function checkServer(app: LoadedApp, context: ServerContext): Promise<Check | undefined> {
  const { dependencies, timeouts, redactor } = context
  if (app.start === undefined) {
    if (app.baseUrl === undefined) return undefined
    const check = { group: app.name, subject: app.baseUrl }
    if (await dependencies.probeReady(app.baseUrl, timeouts.navigation)) return { ...check, ok: true, text: 'answered' }
    return { ...check, ok: false, text: 'did not answer', fix: 'Start the app, or add start to the config so Retest starts it.' }
  }
  const { start } = app
  const check = { group: app.name, subject: start.command }
  const logFile = join(context.logFolder, appLogFile(app.name))
  let server: AppServerHandle
  try {
    server = await dependencies.startAppServer({ name: app.name, start, logFile, redactor, signal: dependencies.signal }, start.timeoutMs ?? timeouts.setup)
  } catch (error) {
    return { ...check, ok: false, text: errorMessage(error), fix: 'Check start in the config: its command, and ready, the address that answers once the app is up.' }
  }
  if (server.status === 'reused') return { ...check, ok: true, text: describeRunning(start.ready) }
  try {
    await server.stop(timeouts.cleanup)
  } catch (error) {
    return { ...check, ok: false, text: `${describeStarted(start.ready, server.durationMs)}, then did not stop: ${errorMessage(error)}` }
  }
  return { ...check, ok: true, text: `${describeStarted(start.ready, server.durationMs)}, then stopped` }
}

// A function source is called only when a test types its secret, so only environment variables are read.
function environmentSecrets(config: LoadedConfig, env: CheckDependencies['env']): EnvironmentSecret[] {
  return [...config.secrets].flatMap(([name, secret]) => {
    if (!('env' in secret.source)) return []
    return [{ name, variable: secret.source.env, resolved: resolveSecrets(new Map([[name, secret]]), env) }]
  })
}

function redactorFor(secrets: readonly EnvironmentSecret[]): Redactor {
  const redactor = new Redactor()
  const values = secrets.flatMap(({ resolved }) => (resolved.ok ? [...resolved.secrets] : []))
  for (const [name, secret] of values) if ('value' in secret) redactor.learn(name, secret.value)
  return redactor
}

function checkSecrets(secrets: readonly EnvironmentSecret[]): Check[] {
  return secrets.map(({ name, variable, resolved }) => {
    const check = { group: 'secrets', subject: name }
    return resolved.ok ? { ...check, ok: true, text: `${variable} is set` } : { ...check, ok: false, text: resolved.failure.message }
  })
}

/**
 * A target as the config's call would write it, after its name when that differs from the browser's.
 *
 * @example targetCall({ name: 'beta', browser: 'chrome', channel: 'beta', headless: true }) // "beta: chrome({ channel: 'beta' })"
 */
function targetCall(target: LoadedTarget): string {
  const settings = [
    ...(target.browser !== 'chromium' && target.channel !== 'stable' ? [`channel: '${target.channel}'`] : []),
    ...(target.emulate === undefined ? [] : [typeof target.emulate === 'string' ? `emulate: '${target.emulate}'` : 'emulate: { ... }']),
    ...(target.headless ? [] : ['headless: false']),
  ]
  const call = `${target.browser}(${settings.length === 0 ? '' : `{ ${settings.join(', ')} }`})`
  return target.name === target.browser ? call : `${target.name}: ${call}`
}
