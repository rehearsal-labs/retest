import type { TestContext } from 'node:test'
import type { BidiDiagnostic } from './bidi-client.ts'
import type { LaunchedFirefox, LaunchRoute } from './launch-firefox.ts'
import type { TaskApp, TaskAppOptions } from '../../fixtures/task-app/server.ts'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before } from 'node:test'
import { startTaskApp } from '../../fixtures/task-app/server.ts'
import { errorMessage } from '../../src/protocol/failures.ts'
import { s } from '../../src/protocol/schema.ts'
import { firefoxPath, launchRoute } from './firefox-session.ts'
import { launchFirefox } from './launch-firefox.ts'

/** The budgets these tests give a launch, one command, and closing Firefox. */
export const launchMs = 20_000
export const commandMs = 10_000
export const closeMs = 5000

export const viewport = { width: 1280, height: 720 }

/**
 * The route these tests launch Firefox by: `RETEST_FIREFOX_ROUTE`, or `spawn` when it is unset, as on any ordinary
 * terminal. On the machine this proof was built on, the app hosting the coding session may not read
 * `~/Library/Application Support/Firefox`, so a Firefox it spawns never starts; the runs there set
 * `RETEST_FIREFOX_ROUTE=launch-services` on the command line. The spawn-route test always uses `spawn`.
 */
export const route: LaunchRoute = launchRoute()

/** A launched Firefox with its session, and what its client could not use. */
export type Session = LaunchedFirefox & { diagnostics: BidiDiagnostic[] }

/** A folder for one test's files, removed after it. */
export async function scratchFolder(t: TestContext): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'retest-firefox-test-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  return folder
}

/**
 * Launches Firefox with a session. After the test it is closed with `browser.close`, and its process group and profile
 * must be gone. A cleanup failure is printed beside the test's own failure, which node's runner would otherwise show alone.
 */
export async function launchSession(t: TestContext): Promise<Session> {
  const folder = await scratchFolder(t)
  const session = await openSession(join(folder, 'firefox.log'))
  t.diagnostic(`Firefox ${session.firefox.pid} started by ${session.firefox.route}; its address came after ${session.firefox.startupMs} ms`)
  t.after(async () => {
    const failure = await closeSession(session)
    if (failure === undefined) return
    t.diagnostic(failure.message)
    throw failure
  })
  return session
}

/** One Firefox and session for every test in a file, closed and checked after the last test. */
export function sharedSession(): () => Session {
  let session: Session | undefined
  let folder: string | undefined
  before(async () => {
    folder = await mkdtemp(join(tmpdir(), 'retest-firefox-test-'))
    session = await openSession(join(folder, 'firefox.log'))
  })
  after(async () => {
    const failure = session === undefined ? undefined : await closeSession(session)
    if (folder !== undefined) await rm(folder, { recursive: true, force: true })
    if (failure !== undefined) throw failure
  })
  return () => {
    assert.ok(session !== undefined, 'the shared Firefox did not launch')
    return session
  }
}

export async function openApp(t: TestContext, options?: TaskAppOptions): Promise<TaskApp> {
  const app = await startTaskApp(options)
  t.after(() => app.close())
  return app
}

/** Waits for `promise`, failing with `message` if it has not settled within `timeoutMs`. */
export function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new assert.AssertionError({ message })), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** Settles with the error a promise rejected with, or fails the test if it resolved. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => assert.fail('expected a rejection'),
    (error: unknown) => error,
  )
}

/**
 * What stopping a Firefox could not do, as one error, or undefined when its process group and profile are gone.
 *
 * @example const failure = await stopFailure(firefox, 0)
 */
export async function stopFailure(firefox: LaunchedFirefox['firefox'], graceMs: number): Promise<Error | undefined> {
  const problems = await firefox.stop(graceMs)
  if (firefox.running) problems.push(`Process group ${firefox.pid} is still there.`)
  if (existsSync(firefox.folder)) problems.push(`${firefox.folder} is still there.`)
  return problems.length === 0 ? undefined : new assert.AssertionError({ message: `Cleaning up Firefox ${firefox.pid} failed: ${problems.join(' ')}` })
}

/**
 * Both failures in one error, the first one first, or whichever there is.
 *
 * @example const failure = bothFailures(bodyFailure, await stopFailure(firefox, 0))
 */
function bothFailures(first: unknown, cleanup: Error | undefined): unknown {
  if (first === undefined) return cleanup
  if (cleanup === undefined) return first
  return new AggregateError([first, cleanup], `${errorMessage(first)} Cleaning up also failed: ${cleanup.message}`)
}

async function openSession(logFile: string): Promise<Session> {
  const diagnostics: BidiDiagnostic[] = []
  const launched = await launchFirefox({
    executablePath: firefoxPath(),
    logFile,
    headless: true,
    route,
    timeoutMs: launchMs,
    commandTimeoutMs: commandMs,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  })
  return { ...launched, diagnostics }
}

// A close that fails is kept, and reported with whatever the cleanup it must not prevent could not do. Firefox gets time
// to go only after it accepted browser.close; with no connection left to send it, it is killed at once.
async function closeSession({ firefox, client }: Session): Promise<Error | undefined> {
  let closeFailure: unknown
  let graceMs = 0
  if (client.closeReason === undefined) {
    await client.request('browser.close', {}, s.object({}), { timeoutMs: closeMs }).then(
      () => {
        graceMs = closeMs
      },
      (error: unknown) => {
        closeFailure = error
      },
    )
  }
  const failure = bothFailures(closeFailure, await stopFailure(firefox, graceMs))
  if (failure === undefined) return undefined
  return failure instanceof Error ? failure : new Error(String(failure))
}
