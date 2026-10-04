import type { OwnedBrowser } from '../../browser/contract.ts'
import type { LoadedApp, LoadedConfig, LoadedElectronTarget, LoadedTarget } from '../../config/loaded.ts'
import type { Timeouts } from '../../protocol/timeouts.ts'
import type { AppServerHandle } from '../../runner/app-server.ts'
import type { ResolvedSecrets } from '../../runner/secrets.ts'
import type { CliDependencies } from '../command.ts'
import { join } from 'node:path'
import { checkElectronFiles, readElectronVersion } from '../../browser/electron.ts'
import { judgeVariables, learnJudgeCredentials } from '../../evaluation/judges.ts'
import { meetsMinimum, minimumNodeVersion, probeTransformer } from '../../loader/node.ts'
import { errorMessage } from '../../protocol/failures.ts'
import { appLogFile, targetBrowserLogFile } from '../../protocol/run-folder.ts'
import { withoutCredentials } from '../../protocol/url.ts'
import { variantKey } from '../../protocol/variant.ts'
import { retestCommand } from '../../reporters/commands.ts'
import { describeRunning, describeStarted } from '../../reporters/format.ts'
import { describeBrowser, describeProxy } from '../../reporters/targets.ts'
import { Redactor } from '../../runner/redactor.ts'
import { resolveSecrets } from '../../runner/secrets.ts'
import { targetDriver } from '../../runner/target-drivers.ts'

/** One thing `doctor` checked: what, how it went, and for a problem, how to fix it. */
export type Check = { group: string; subject: string; ok: boolean; text: string; detail?: string; fix?: string }

export type CheckDependencies = Pick<
  CliDependencies,
  'resolveExecutable' | 'launchBrowser' | 'probeReady' | 'startAppServer' | 'env' | 'signal'
>

/** `hiddenVariables` are left out of the environment of every browser and server `doctor` starts. */
export type CheckContext = { dependencies: CheckDependencies; timeouts: Timeouts; logFolder: string; node?: NodeFacts; hiddenVariables?: readonly string[] }

/**
 * The Node that runs `doctor`, which a run's test file processes run on too: its version, and what Node says when it is
 * asked to load TypeScript as a test file's process loads it, undefined when it does. Read from this process unless
 * given.
 */
export type NodeFacts = { version: string; probeTransformer: (env: CheckDependencies['env']) => string | undefined }

type Launched = { ok: true; browser: Pick<OwnedBrowser, 'product' | 'version' | 'executablePath'> } | { ok: false; message: string; logFile: string }
/** An `env` secret as `doctor` reads it, on its own, so that every one is reported. */
type EnvironmentSecret = { name: string; variable: string; resolved: ResolvedSecrets }

/**
 * Checks Node, then every target of every app, then each app's address, then the secrets read from the environment.
 * Node is listed only when it falls short: older than Retest's minimum, or unable to load TypeScript as test files load
 * it. Each browser is launched once and closed; a server `doctor` starts is stopped again, and one
 * that was already running is left alone. The secrets and the judges' credentials are read first, so the log of a
 * server that prints its settings never holds one, and the variables the judges' credentials are read from are left out
 * of the environment each browser and server is given, as a run leaves them out. Every printed field and each
 * browser's output are redacted with those values too.
 *
 * @example const checks = await runChecks(config, { dependencies, timeouts, logFolder })
 */
export async function runChecks(config: LoadedConfig, context: CheckContext): Promise<Check[]> {
  const checks: Check[] = checkNode(context.node ?? { version: process.versions.node, probeTransformer }, context.dependencies.env)
  const launches = new Map<string, Promise<Launched>>()
  const secrets = environmentSecrets(config, context.dependencies.env)
  const redactor = redactorFor(secrets)
  learnJudgeCredentials({ evaluation: config.evaluation, env: context.dependencies.env, redactor })
  const judges = judgeVariables(config.evaluation)
  const hidden = judges.length === 0 ? {} : { hiddenVariables: judges }
  for (const app of config.apps.values()) {
    for (const target of app.targets.values()) {
      if (context.dependencies.signal.aborted) return redactChecks(checks, redactor)
      checks.push(await checkTarget(app, target, { ...context, ...hidden, launches, redactor }))
    }
    if (context.dependencies.signal.aborted) return redactChecks(checks, redactor)
    const server = await checkServer(app, { ...context, ...hidden, redactor })
    if (server !== undefined) checks.push(server)
  }
  checks.push(...checkSecrets(secrets))
  return redactChecks(checks, redactor)
}

// Paths and command lines are display text too: a config can build either with a value from the environment.
function redactChecks(checks: readonly Check[], redactor: Redactor): Check[] {
  return checks.map((check) => ({
    ...check,
    group: redactor.redact(check.group),
    subject: redactor.redact(check.subject),
    text: redactor.redact(check.text),
    ...(check.detail === undefined ? {} : { detail: redactor.redact(check.detail) }),
    ...(check.fix === undefined ? {} : { fix: redactor.redact(check.fix) }),
  }))
}

type TargetContext = CheckContext & { launches: Map<string, Promise<Launched>>; redactor: Redactor }

// A target whose driver does not exist is refused as a run refuses it, and nothing is launched for it.
async function checkTarget(app: LoadedApp, loaded: LoadedTarget, context: TargetContext): Promise<Check> {
  const subject = targetCall(loaded)
  const driver = targetDriver(app.name, loaded)
  if (!driver.ok) return { group: app.name, subject, ok: false, text: driver.failure.message }
  if (driver.driver === 'electron') return checkElectron(app, driver.target, subject)
  const { target } = driver
  const found = context.dependencies.resolveExecutable(target)
  if (!found.ok) return { group: app.name, subject, ok: false, text: found.failure.message }
  // Targets that differ only in emulation launch the same browser, so it is launched once.
  const key = JSON.stringify([found.path, target.headless])
  const launch = { executablePath: found.path, appTarget: variantKey({ [app.name]: target.name }), headless: target.headless }
  const launching = context.launches.get(key) ?? launchOnce(launch, context)
  context.launches.set(key, launching)
  const launched = await launching
  if (!launched.ok) return { group: app.name, subject, ok: false, text: launched.message, fix: `The browser's log is at ${launched.logFile}.` }
  // The proxy is a setting of each page's context, so the launch cannot check it; the line names it.
  const proxy = target.proxy === undefined ? '' : ` · ${describeProxy(target.proxy)}`
  return { group: app.name, subject, ok: true, text: `${describeBrowser(launched.browser)}${proxy}`, detail: launched.browser.executablePath }
}

// An Electron app runs its own code as it starts, so `doctor` checks its files and leaves the start to a run: that the
// binary is a file it may execute, that the app is there, and which Electron release the binary's files state, when they
// state one. A packaged app's files may state none; a run then reads the release from what the app reports.
async function checkElectron(app: LoadedApp, target: LoadedElectronTarget, subject: string): Promise<Check> {
  const check = { group: app.name, subject, detail: target.executablePath }
  try {
    await checkElectronFiles(target.executablePath, target.appPath)
  } catch (error) {
    return { ...check, ok: false, text: errorMessage(error) }
  }
  const release = await readElectronVersion(target.executablePath, '')
  const text = release === undefined
    ? 'an executable and the app found, but the binary\'s files name no Electron release; a run checks what the app reports, and starts it'
    : `Electron ${release} and the app found; a run starts the app`
  return { ...check, ok: true, text }
}

type Launch = { executablePath: string; headless: boolean; appTarget: string }

// The log is named after the app target, as a run names it.
async function launchOnce({ executablePath, headless, appTarget }: Launch, context: CheckContext & { redactor: Redactor }): Promise<Launched> {
  const { dependencies, timeouts, hiddenVariables, redactor } = context
  const logFile = join(context.logFolder, targetBrowserLogFile(appTarget))
  let browser: OwnedBrowser
  try {
    const redact = redactor.active ? { redact: (text: string) => redactor.redact(text), redactStream: () => redactor.stream() } : {}
    browser = await dependencies.launchBrowser({ executablePath, logFile, headless, ...(hiddenVariables === undefined ? {} : { hiddenVariables }), ...redact }, timeouts.setup)
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
  const { dependencies, timeouts, redactor, hiddenVariables } = context
  if (app.start === undefined) {
    if (app.baseUrl === undefined) return undefined
    const check = { group: app.name, subject: withoutCredentials(app.baseUrl) }
    if (await dependencies.probeReady(app.baseUrl, timeouts.navigation)) return { ...check, ok: true, text: 'answered' }
    return { ...check, ok: false, text: 'did not answer', fix: 'Start the app, or add start to the config so Retest starts it.' }
  }
  const { start } = app
  const ready = withoutCredentials(start.ready)
  const check = { group: app.name, subject: start.command }
  const logFile = join(context.logFolder, appLogFile(app.name))
  let server: AppServerHandle
  try {
    const hidden = hiddenVariables === undefined ? {} : { hiddenVariables }
    server = await dependencies.startAppServer({ name: app.name, start, logFile, redactor, signal: dependencies.signal, ...hidden }, start.timeoutMs ?? timeouts.setup)
  } catch (error) {
    return { ...check, ok: false, text: errorMessage(error).replaceAll(start.ready, ready), fix: 'Check start in the config: its command, and ready, the address that answers once the app is up.' }
  }
  if (server.status === 'reused') return { ...check, ok: true, text: describeRunning(ready) }
  try {
    await server.stop(timeouts.cleanup)
  } catch (error) {
    return { ...check, ok: false, text: `${describeStarted(ready, server.durationMs)}, then did not stop: ${errorMessage(error).replaceAll(start.ready, ready)}` }
  }
  return { ...check, ok: true, text: `${describeStarted(ready, server.durationMs)}, then stopped` }
}

// A function source is called only when a test types its secret, so only environment variables are read.
function environmentSecrets(config: LoadedConfig, env: CheckDependencies['env']): EnvironmentSecret[] {
  return [...config.secrets].flatMap(([name, secret]) => {
    if (!('env' in secret.source)) return []
    return [{ name, variable: secret.source.env, resolved: resolveSecrets({ ...config, secrets: new Map([[name, secret]]) }, env) }]
  })
}

function redactorFor(secrets: readonly EnvironmentSecret[]): Redactor {
  const redactor = new Redactor()
  const values = secrets.flatMap(({ resolved }) => (resolved.ok ? [...resolved.secrets] : []))
  for (const [name, secret] of values) if ('value' in secret) redactor.learn(name, secret.value)
  return redactor
}

// A version below the minimum says so on its own: TypeScript is not tried then.
function checkNode(node: NodeFacts, env: CheckDependencies['env']): Check[] {
  if (!meetsMinimum(node.version)) {
    const fix = `Install Node ${minimumNodeVersion} or later, then run ${retestCommand} doctor again.`
    return [{ group: 'node', subject: `v${node.version}`, ok: false, text: `Retest needs Node ${minimumNodeVersion} or later.`, fix }]
  }
  const problem = node.probeTransformer(env)
  if (problem === undefined) return []
  const text = `Node could not load TypeScript as a test file's process loads it: ${problem}`
  const fix = "Test files load with Node's own TypeScript transformer. Remove what turns it off, such as --no-experimental-strip-types in NODE_OPTIONS."
  return [{ group: 'node', subject: 'TypeScript', ok: false, text, fix }]
}

function checkSecrets(secrets: readonly EnvironmentSecret[]): Check[] {
  return secrets.map(({ name, variable, resolved }) => {
    const check = { group: 'secrets', subject: name }
    return resolved.ok ? { ...check, ok: true, text: `${variable} is set` } : { ...check, ok: false, text: resolved.failure.message }
  })
}

/**
 * A target as the config would write it, after its name when that differs from the browser's or the platform's: the
 * call for Chromium, Chrome, Edge and Electron, its paths left out, and the object for any other.
 *
 * @example targetCall({ name: 'beta', browser: 'chrome', channel: 'beta', headless: true }) // "beta: chrome({ channel: 'beta' })"
 */
function targetCall(target: LoadedTarget): string {
  if ('platform' in target) {
    const device = target.platform === 'ios-simulator' ? `, device: '${target.device}', runtime: '${target.runtime}'` : ''
    const shape = `{ platform: '${target.platform}'${device} }`
    return target.name === target.platform ? shape : `${target.name}: ${shape}`
  }
  if (target.browser === 'firefox' || target.browser === 'webkit') {
    const shape = `{ browser: '${target.browser}' }`
    return target.name === target.browser ? shape : `${target.name}: ${shape}`
  }
  if (target.browser === 'electron') return target.name === target.browser ? 'electron({ ... })' : `${target.name}: electron({ ... })`
  const settings = [
    ...(target.browser !== 'chromium' && target.channel !== 'stable' ? [`channel: '${target.channel}'`] : []),
    ...(target.emulate === undefined ? [] : [typeof target.emulate === 'string' ? `emulate: '${target.emulate}'` : 'emulate: { ... }']),
    ...(target.headless ? [] : ['headless: false']),
  ]
  const call = `${target.browser}(${settings.length === 0 ? '' : `{ ${settings.join(', ')} }`})`
  return target.name === target.browser ? call : `${target.name}: ${call}`
}
