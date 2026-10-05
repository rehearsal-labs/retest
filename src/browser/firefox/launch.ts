import type { BidiDiagnostic } from './bidi-client.ts'
import type { LaunchOptions } from '../contract.ts'
import type { FirefoxRoute } from './route.ts'
import { constants } from 'node:fs'
import { access, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { Deadline } from '../../protocol/deadline.ts'
import { errorMessage } from '../../protocol/failures.ts'
import { s } from '../../protocol/schema.ts'
import { errorCode } from '../../shared/error-code.ts'
import { ProcessLaunchError } from '../chromium-process.ts'
import { LaunchError } from '../contract.ts'
import { logWriter } from '../launch.ts'
import { BidiClient } from './bidi-client.ts'
import { FirefoxBrowser } from './browser.ts'
import { sweepOrphanedFirefoxes } from './orphans.ts'
import { FirefoxProcess } from './process.ts'
import { createFirefoxFolder } from './profile.ts'

/**
 * How to launch Firefox: what every browser launch takes, the route that starts it, `spawn` unless said, and the folder
 * its own folder is made in and swept, the system's temporary folder unless a test names one of its own.
 */
export type FirefoxLaunchOptions = LaunchOptions & { route?: FirefoxRoute; folderRoot?: string }

const launchTimeoutMs = 30_000

/**
 * What `session.new` says of the browser. Firefox adds its own facts under `moz:` names; `moz:buildID` is the build
 * the version comes from, and `userAgent` is absent from some releases.
 */
export type SessionFacts = {
  sessionId: string
  browserName: string
  browserVersion: string
  buildId: string | undefined
  platformName: string
  processId: number
  profile: string
  headless: boolean
  userAgent: string | undefined
}

const sessionSchema = s.object({
  sessionId: s.string(),
  capabilities: s.object({
    browserName: s.string(),
    browserVersion: s.string(),
    platformName: s.string(),
    userAgent: s.optional(s.string()),
    'moz:buildID': s.optional(s.string()),
    'moz:processID': s.number({ integer: true }),
    'moz:profile': s.string(),
    'moz:headless': s.boolean(),
  }),
})

/**
 * Starts a Firefox this run owns: the leader of a process group of its own, with a fresh profile in a temporary folder
 * named after this process, removed when it closes, and its one WebDriver BiDi session, whose `session.new` must name
 * the process and the profile this launch made, so the process it will later end is the browser it drives. First it
 * ends the Firefoxes, and removes the folders, that launchers which are gone recorded and left. Prompts the page opens
 * stay open, as they do on Chromium, so a command meets them rather than an answer Retest never gave. Every failure is
 * a `LaunchError` naming the problem, and leaves nothing of this launch behind. `socket` opens the WebDriver BiDi
 * connection, Node's own WebSocket unless a test passes one that can hold a message back.
 *
 * @example const browser = await launchFirefox({ executablePath, logFile: 'logs/browser.log', headless: true })
 */
export async function launchFirefox(options: FirefoxLaunchOptions, timeoutMs: number = launchTimeoutMs, socket?: (url: string) => WebSocket): Promise<FirefoxBrowser> {
  const deadline = new Deadline(timeoutMs)
  const route = options.route ?? 'spawn'
  const executable = await checkFirefox(options.executablePath)
  const write = logWriter(options.logFile)
  const log = options.redact === undefined ? write : (line: string) => write(options.redact?.(line) ?? line)
  const root = options.folderRoot ?? tmpdir()
  const sweep = await sweepOrphanedFirefoxes(root)
  for (const pid of sweep.ended) log(`ended Firefox ${pid}, which a launcher that is gone left running`)
  for (const folder of sweep.removed) log(`removed ${folder}, which a launcher that is gone left`)
  for (const line of [...sweep.kept, ...sweep.problems]) log(line)
  const { folder, profile } = await createFirefoxFolder(root).catch((error: unknown) => {
    throw new LaunchError(`Cannot create a temporary Firefox profile: ${errorMessage(error)}`, { cause: error })
  })
  const hidden = options.hiddenVariables === undefined ? {} : { hiddenVariables: options.hiddenVariables }
  const redacting = options.redact === undefined ? {} : { redact: options.redact }
  const streaming = options.redactStream === undefined ? {} : { redactStream: options.redactStream }
  let firefox: FirefoxProcess
  try {
    firefox = await FirefoxProcess.start({ executable, route, headless: options.headless, folder, profile, logFile: options.logFile, deadline, ...hidden, ...redacting, ...streaming })
  } catch (error) {
    await rm(folder, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
    throw error instanceof LaunchError ? error : new LaunchError(`Cannot start Firefox: ${errorMessage(error)}`, { cause: error })
  }
  log(`started Firefox ${firefox.pid} by the ${route} route`)
  let client: BidiClient | undefined
  try {
    const address = await firefox.waitForAddress(deadline)
    client = await BidiClient.connect(`${address}/session`, {
      timeoutMs,
      connectTimeoutMs: deadline.commandTimeoutMs,
      onDiagnostic: (diagnostic) => log(describeDiagnostic(diagnostic)),
      ...(socket === undefined ? {} : { socket }),
    })
    const facts = await startSession(client, deadline)
    if (facts.processId !== firefox.pid) throw new LaunchError(`The Firefox at ${address} names process ${facts.processId}, not the launched ${firefox.pid}, so ending ${firefox.pid} would not end the browser it drives.`)
    if (facts.profile !== profile) throw new LaunchError(`The Firefox at ${address} uses the profile ${facts.profile}, not ${profile}.`)
    log(`Firefox ${facts.browserVersion}${facts.buildId === undefined ? '' : ` build ${facts.buildId}`} answered at ${address}`)
    return await FirefoxBrowser.open({ process: firefox, client, executablePath: executable, facts, onListenerError: (error) => log(`a listener failed: ${errorMessage(error)}`) }, deadline)
  } catch (error) {
    client?.close()
    const problems = await firefox.stop(0)
    const message = error instanceof LaunchError ? error.message : `${executable} did not answer as Firefox within ${timeoutMs} ms: ${errorMessage(error)}`
    const advice = route === 'spawn' ? await spawnAdvice() : ''
    const cleanup = problems.length === 0 ? '' : ` Cleaning up also failed: ${problems.join(' ')}`
    throw new ProcessLaunchError(`${message}${advice} Its output is in ${options.logFile}.${cleanup}`, firefox.gone(), { cause: error, failureClass: problems.length > 0 ? 'cleanup_failed' : 'setup_failed' }, firefox.outputSettled)
  }
}

/**
 * Starts the connection's WebDriver BiDi session. User prompts are left as the page opened them, so a command meets
 * the prompt, as on Chromium, instead of one Retest answered.
 *
 * @example const facts = await startSession(client, deadline)
 */
export async function startSession(client: BidiClient, deadline: Deadline): Promise<SessionFacts> {
  const capabilities = { alwaysMatch: { unhandledPromptBehavior: { default: 'ignore' } } }
  const { sessionId, capabilities: given } = await client.request('session.new', { capabilities }, sessionSchema, { timeoutMs: deadline.commandTimeoutMs })
  return {
    sessionId,
    browserName: given.browserName,
    browserVersion: given.browserVersion,
    buildId: given['moz:buildID'],
    platformName: given.platformName,
    processId: given['moz:processID'],
    profile: given['moz:profile'],
    headless: given['moz:headless'],
    userAgent: given.userAgent,
  }
}

/** Checks that a path names a file this process may run, and returns it as an absolute path. */
async function checkFirefox(path: string): Promise<string> {
  const absolute = resolve(path)
  const stats = await stat(absolute).catch((error: unknown) => {
    const code = errorCode(error)
    const message = code === 'ENOENT' || code === 'ENOTDIR' ? `No Firefox at ${absolute}.` : `Cannot read ${absolute}: ${errorMessage(error)}`
    throw new LaunchError(`${message} Pass the firefox executable, such as /Applications/Firefox.app/Contents/MacOS/firefox.`, { cause: error })
  })
  if (stats.isDirectory()) throw new LaunchError(`${absolute} is a folder. Pass the firefox executable inside it, such as ${absolute.endsWith('.app') ? `${absolute}/Contents/MacOS/firefox` : '/Applications/Firefox.app/Contents/MacOS/firefox'}.`)
  if (!stats.isFile()) throw new LaunchError(`${absolute} is not a file. Pass the firefox executable.`)
  await access(absolute, constants.X_OK).catch((error: unknown) => {
    throw new LaunchError(`${absolute} is not executable. Allow it to run, or pass another Firefox.`, { cause: error })
  })
  return absolute
}

// On macOS a Firefox started as this process's child reads its profile list in the user's Firefox data folder before
// anything else, and macOS asks whether this process's host app may read it. A host that may not gets a Firefox that
// never starts; the likely cause is a profile dialog headless mode never shows.
async function spawnAdvice(): Promise<string> {
  if (process.platform !== 'darwin') return ''
  const home = process.env['HOME']
  if (home === undefined) return ''
  const refused = await readdir(`${home}/Library/Application Support/Firefox`).then(() => false, (error: unknown) => errorCode(error) === 'EPERM')
  if (!refused) return ''
  return ` macOS does not let this process read ${home}/Library/Application Support/Firefox, which a spawned Firefox reads before anything else. Run Retest from an app that may read it, such as a terminal allowed to access data from other apps, or set RETEST_FIREFOX_ROUTE=launch-services.`
}

function describeDiagnostic(diagnostic: BidiDiagnostic): string {
  switch (diagnostic.kind) {
    case 'malformed-message':
      return `a message from Firefox could not be read: ${diagnostic.problem}`
    case 'unmatched-response':
      return `Firefox answered command ${diagnostic.id ?? 'with no id'}, which nothing was waiting for`
    case 'listener-failed':
      return `a listener for ${diagnostic.event} failed: ${errorMessage(diagnostic.error)}`
  }
}
