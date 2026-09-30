import type { ProcessExit } from '../shared/process-exit.ts'
import type { CdpDiagnostic } from './cdp/connection.ts'
import type { PipeStreams, Transport } from './cdp/transport.ts'
import type { LaunchOptions, OwnedBrowser } from './contract.ts'
import type { BrowserVersion } from './browser.ts'
import { appendFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Deadline } from '../protocol/deadline.ts'
import { errorMessage } from '../protocol/failures.ts'
import { s } from '../protocol/schema.ts'
import { describeExit } from '../shared/process-exit.ts'
import { ChromiumBrowser } from './browser.ts'
import { CdpConnection } from './cdp/connection.ts'
import { CdpClosedError, CdpDisconnectedError, CdpTimeoutError } from './cdp/errors.ts'
import { PipeTransport } from './cdp/transport.ts'
import { request, sendOptions } from './cdp-results.ts'
import { ChromiumProcess } from './chromium-process.ts'
import { closeGraceMs, LaunchError } from './contract.ts'
import { checkExecutable } from './executable.ts'
import { profilePrefix, removeStaleProfiles } from './profiles.ts'

const launchTimeoutMs = 30_000

const versionSchema = s.object({ product: s.string(), userAgent: s.string() })

/**
 * Starts a Chromium browser this run owns, in a process group of its own, with a temporary profile and a
 * private debugging pipe. The profile is named after this process, and profiles that processes no longer
 * running left behind are removed first. Every failure is a `LaunchError` that names the problem. `transport`
 * makes the connection's transport from the pipe; a test passes one that watches or holds messages.
 *
 * @example const browser = await launchBrowser({ executablePath, logFile: 'logs/browser.log', headless: true })
 */
export async function launchBrowser(
  options: LaunchOptions,
  timeoutMs: number = launchTimeoutMs,
  transport: (pipe: PipeStreams) => Transport = (pipe) => new PipeTransport(pipe),
): Promise<OwnedBrowser> {
  const deadline = new Deadline(timeoutMs)
  const executable = await checkExecutable(options.executablePath)
  const staleProfileProblems = await removeStaleProfiles(tmpdir())
  const profile = await mkdtemp(join(tmpdir(), profilePrefix(process.pid))).catch((error: unknown) => {
    throw new LaunchError(`Cannot create a temporary browser profile: ${errorMessage(error)}`, { cause: error })
  })
  const args = chromiumArguments(profile, options.headless)
  const chromium = await ChromiumProcess.start({ executable, args, profile, logFile: options.logFile })
  const log = logWriter(options.logFile)
  for (const problem of staleProfileProblems) log(problem)
  // Every command Retest sends names its own timeout; the launch budget bounds any that would not.
  const connection = new CdpConnection(transport(chromium.pipe), {
    timeoutMs,
    onDiagnostic: (diagnostic) => log(describeDiagnostic(diagnostic)),
  })
  try {
    const version = await handshake(connection, deadline)
    const onListenerError = (error: unknown) => log(`a listener failed: ${errorMessage(error)}`)
    return new ChromiumBrowser({ process: chromium, executablePath: executable, connection, version, onListenerError })
  } catch (error) {
    const ended = error instanceof CdpDisconnectedError || error instanceof CdpClosedError
    // A program that closed its pipe is usually exiting; how it exits is the best explanation there is.
    const exit = ended ? await chromium.waitForExit(Math.min(deadline.remainingMs, closeGraceMs)) : undefined
    connection.close()
    const problems = await chromium.stop(0)
    const message = handshakeFailure(error, { executable, exit, logFile: options.logFile, timeoutMs })
    const cleanup = problems.length === 0 ? '' : ` Cleaning up also failed: ${problems.join(' ')}`
    throw new LaunchError(`${message}${cleanup}`, { cause: error })
  }
}

function chromiumArguments(profile: string, headless: boolean): string[] {
  return [
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
    ...(headless ? ['--headless'] : []),
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    // Keeps a fresh profile out of the login keychain that the person's own Chrome uses.
    ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
    'about:blank',
  ]
}

async function handshake(connection: CdpConnection, deadline: Deadline): Promise<BrowserVersion> {
  const { product, userAgent } = await request(connection, 'Browser.getVersion', undefined, versionSchema, sendOptions(deadline))
  const slash = product.indexOf('/')
  if (slash === -1) return { product, version: 'unknown', userAgent }
  return { product: product.slice(0, slash), version: product.slice(slash + 1), userAgent }
}

type HandshakeContext = { executable: string; exit: ProcessExit | undefined; logFile: string; timeoutMs: number }

function handshakeFailure(error: unknown, { executable, exit, logFile, timeoutMs }: HandshakeContext): string {
  const advice = `Pass the path to a Chromium or Chrome executable. Its output is in ${logFile}.`
  if (error instanceof CdpTimeoutError) return `${executable} did not answer as a browser within ${timeoutMs} ms. ${advice}`
  if (exit !== undefined) return `${executable} exited with ${describeExit(exit)} before it answered as a browser. ${advice}`
  if (error instanceof CdpDisconnectedError || error instanceof CdpClosedError) {
    return `${executable} closed its debugging pipe before it answered as a browser. ${advice}`
  }
  return `${executable} answered, but not as a Chromium browser: ${errorMessage(error)}. ${advice}`
}

function describeDiagnostic(diagnostic: CdpDiagnostic): string {
  switch (diagnostic.kind) {
    case 'malformed-message':
      return `a message from the browser could not be read: ${diagnostic.problem}`
    case 'unmatched-response':
      return `the browser answered command ${diagnostic.id}, which nothing was waiting for`
    case 'unknown-session':
      return `the browser sent ${diagnostic.method} for a session Retest does not know`
    case 'listener-failed':
      return `a listener for ${diagnostic.event} failed: ${errorMessage(diagnostic.error)}`
  }
}

function logWriter(logFile: string): (line: string) => void {
  return (line) => {
    try {
      appendFileSync(logFile, `[retest] ${line}\n`)
    } catch {
      // The log is evidence; failing to add a line to it must not break the connection that reported it.
    }
  }
}
