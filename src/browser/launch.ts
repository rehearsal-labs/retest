import type { ProcessExit } from '../shared/process-exit.ts'
import type { CdpDiagnostic } from './cdp/connection.ts'
import type { PipeStreams, Transport } from './cdp/transport.ts'
import type { LaunchOptions, WebRuntime } from './contract.ts'
import type { BrowserVersion } from './browser.ts'
import { appendFileSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Deadline } from '../protocol/deadline.ts'
import { errorMessage } from '../protocol/failures.ts'
import { s } from '../protocol/schema.ts'
import { describeExit } from '../shared/process-exit.ts'
import { ChromiumBrowser } from './browser.ts'
import { CdpConnection } from './cdp/connection.ts'
import { CdpClosedError, CdpDisconnectedError, CdpTimeoutError } from './cdp/errors.ts'
import { PipeTransport } from './cdp/transport.ts'
import { request, sendOptions } from './cdp-results.ts'
import { ChromiumProcess, ProcessLaunchError } from './chromium-process.ts'
import { closeGraceMs, LaunchError } from './contract.ts'
import { checkExecutable } from './executable.ts'
import { createTemporaryProfile, removeStaleProfiles } from './profiles.ts'
import { explainStartFailure } from './start-failure.ts'

const launchTimeoutMs = 30_000
// Chrome states why it stopped in its last lines; more than this is never needed to find them.
const launchOutputLimit = 64 * 1024

const versionSchema = s.object({ product: s.string(), userAgent: s.string(), revision: s.optional(s.string()) })

/**
 * Starts a Chromium browser this run owns, in a process group of its own, with a temporary profile and a
 * private debugging pipe. The profile is named after this process; profiles from earlier launches are retained.
 * Every failure is a `LaunchError` that names the problem. `transport`
 * makes the connection's transport from the pipe; a test passes one that watches or holds messages.
 *
 * @example const browser = await launchBrowser({ executablePath, logFile: 'logs/browser.log', headless: true })
 */
export async function launchBrowser(
  options: LaunchOptions,
  timeoutMs: number = launchTimeoutMs,
  transport: (pipe: PipeStreams) => Transport = (pipe) => new PipeTransport(pipe),
): Promise<WebRuntime> {
  const deadline = new Deadline(timeoutMs)
  const executable = await checkExecutable(options.executablePath)
  const staleProfileProblems = await removeStaleProfiles(tmpdir())
  const profile = await createTemporaryProfile(tmpdir()).catch((error: unknown) => {
    throw new LaunchError(`Cannot create a temporary browser profile: ${errorMessage(error)}`, { cause: error })
  })
  const args = chromiumArguments(profile, options.headless)
  const outputStart = await logLength(options.logFile)
  const hidden = options.hiddenVariables === undefined ? {} : { hiddenVariables: options.hiddenVariables }
  const redacting = options.redact === undefined ? {} : { redact: options.redact }
  const streaming = options.redactStream === undefined ? {} : { redactStream: options.redactStream }
  const chromium = await ChromiumProcess.start({ executable, args, profile, logFile: options.logFile, ...hidden, ...redacting, ...streaming })
  let connection: CdpConnection | undefined
  try {
    const write = logWriter(options.logFile)
    const log = options.redact === undefined ? write : (line: string) => write(options.redact?.(line) ?? line)
    for (const problem of staleProfileProblems) log(problem)
    // Every command Retest sends names its own timeout; the launch budget bounds any that would not.
    connection = new CdpConnection(transport(chromium.pipe), {
      timeoutMs,
      onDiagnostic: (diagnostic) => log(describeDiagnostic(diagnostic)),
    })
    const version = await handshake(connection, deadline)
    const onListenerError = (error: unknown) => log(`a listener failed: ${errorMessage(error)}`)
    return new ChromiumBrowser({ process: chromium, executablePath: executable, connection, version, onListenerError })
  } catch (error) {
    const ended = error instanceof CdpDisconnectedError || error instanceof CdpClosedError
    // A program that closed its pipe is usually exiting; how it exits is the best explanation there is.
    const exit = ended ? await chromium.waitForExit(Math.min(deadline.remainingMs, closeGraceMs)) : undefined
    const problems: string[] = []
    try { connection?.close() } catch (closeError) { problems.push(`Could not close the browser's debugging pipe: ${errorMessage(closeError)}`) }
    problems.push(...await chromium.stop(0))
    const output = await launchOutput(options.logFile, outputStart)
    const message = handshakeFailure(error, { executable, exit, logFile: options.logFile, timeoutMs, output })
    const cleanup = problems.length === 0 ? '' : ` Cleaning up also failed: ${problems.join(' ')}`
    throw new ProcessLaunchError(`${message}${cleanup}`, chromium.gone(), { cause: error, failureClass: problems.length > 0 ? 'cleanup_failed' : 'setup_failed' }, chromium.outputSettled)
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

/**
 * Asks the browser what it is, and splits its product into a name and a version.
 *
 * @example await handshake(connection, deadline) // { product: 'Chrome', version: '152.0.7977.130', userAgent }
 */
export async function handshake(connection: CdpConnection, deadline: Deadline): Promise<BrowserVersion> {
  const { product, userAgent, revision } = await request(connection, 'Browser.getVersion', undefined, versionSchema, sendOptions(deadline))
  // The source revision the browser was built from, when it says one.
  const built = revision === undefined || revision === '' ? {} : { revision }
  const slash = product.indexOf('/')
  if (slash === -1) return { product, version: 'unknown', userAgent, ...built }
  return { product: product.slice(0, slash), version: product.slice(slash + 1), userAgent, ...built }
}

type HandshakeContext = { executable: string; exit: ProcessExit | undefined; logFile: string; timeoutMs: number; output: string }

function handshakeFailure(error: unknown, { executable, exit, logFile, timeoutMs, output }: HandshakeContext): string {
  const advice = `${explainStartFailure(output) ?? 'Pass the path to a Chromium or Chrome executable.'} Its output is in ${logFile}.`
  if (error instanceof CdpTimeoutError) return `${executable} did not answer as a browser within ${timeoutMs} ms. ${advice}`
  if (exit !== undefined) return `${executable} exited with ${describeExit(exit)} before it answered as a browser. ${advice}`
  if (error instanceof CdpDisconnectedError || error instanceof CdpClosedError) {
    return `${executable} closed its debugging pipe before it answered as a browser. ${advice}`
  }
  return `${executable} answered, but not as a Chromium browser: ${errorMessage(error)}. ${advice}`
}

/** Where a launch's output begins in a log that may already hold another's. */
export async function logLength(logFile: string): Promise<number> {
  try {
    return (await stat(logFile)).size
  } catch {
    // A log that is not there yet starts empty; one that cannot be read fails when the browser opens it.
    return 0
  }
}

/**
 * What the program printed during a launch, from `from`, up to its last 64 KiB. A log that cannot be read explains
 * nothing, and the failure still points to it.
 */
export async function launchOutput(logFile: string, from: number): Promise<string> {
  try {
    const handle = await open(logFile, 'r')
    try {
      const { size } = await handle.stat()
      const start = Math.max(from, size - launchOutputLimit)
      const length = Math.max(0, size - start)
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(length), 0, length, start)
      return buffer.toString('utf8', 0, bytesRead)
    } finally {
      await handle.close()
    }
  } catch {
    return ''
  }
}

/** A connection's diagnostic as a line of the browser log. */
export function describeDiagnostic(diagnostic: CdpDiagnostic): string {
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

/** Adds Retest's own lines to a browser log, each marked `[retest]`; a line that cannot be added is dropped. */
export function logWriter(logFile: string): (line: string) => void {
  return (line) => {
    try {
      appendFileSync(logFile, `[retest] ${line}\n`)
    } catch {
      // The log is evidence; failing to add a line to it must not break the connection that reported it.
    }
  }
}
