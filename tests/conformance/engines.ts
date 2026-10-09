import type { Engine } from '../../fixtures/conformance/config.ts'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { errorCode } from '../../src/shared/error-code.ts'
import { repositoryRoot } from '../integration/cli-harness.ts'
import { browserPath } from '../support/test-browser.ts'

// Which engines this machine runs the conformance cases on. Chrome always, from RETEST_TEST_BROWSER or Google Chrome
// where macOS installs it. On macOS, Firefox from RETEST_TEST_FIREFOX or where macOS installs it, as the Firefox
// driver's tests find it, and WebKit from RETEST_TEST_WEBKIT or the pinned WebKit build 2359. 0.1.0 supports
// Firefox and WebKit on macOS only, so elsewhere they are not run, and say why. On macOS a missing browser fails the
// gate, unless RETEST_CONFORMANCE_OPT_OUT names its engine; such an engine is reported as not verified, by name, and
// never counted as passing.

export { engines, type Engine } from '../../fixtures/conformance/config.ts'

/** How each engine is named in reports. */
export const engineNames: Readonly<Record<Engine, string>> = { chrome: 'Chrome', firefox: 'Firefox', webkit: 'WebKit' }

/** The name the run gives each engine's target, as its failures write it: a target on its own is named after its browser. */
export const targetNames: Readonly<Record<Engine, string>> = { chrome: 'chromium', firefox: 'firefox', webkit: 'webkit' }

/** The variable that opts engines out of a run by name, such as `firefox,webkit`. */
export const optOutVariable = 'RETEST_CONFORMANCE_OPT_OUT'

/**
 * An engine the machine has, with the executable the configs are given, what each run's environment needs to start
 * it, and anything about how it was started that a reader of the results must know; or the reason it is not
 * available, which is `excused` when a variable opted it out by name or 0.1.0 does not support it on this platform,
 * and otherwise fails the gate. WebKit's executable may be the build's folder, which its driver takes as it takes
 * the executable inside.
 */
export type EngineSetup =
  | { readonly available: true; readonly executable?: string; readonly environment: Readonly<Record<string, string>>; readonly notes: readonly string[] }
  | { readonly available: false; readonly reason: string; readonly excused: boolean }

const executableVariables: Readonly<Record<Exclude<Engine, 'chrome'>, string>> = { firefox: 'RETEST_TEST_FIREFOX', webkit: 'RETEST_TEST_WEBKIT' }

// Where each browser is when no variable names it: Firefox where macOS installs it, and the pinned WebKit build 2359,
// in Playwright's cache.
const knownLocations: Readonly<Record<Exclude<Engine, 'chrome'>, string>> = {
  firefox: '/Applications/Firefox.app/Contents/MacOS/firefox',
  webkit: join(homedir(), 'Library/Caches/ms-playwright/webkit-2359'),
}

/**
 * The engines RETEST_CONFORMANCE_OPT_OUT names, or the failure that says which name it does not take.
 *
 * @example optedOut({ RETEST_CONFORMANCE_OPT_OUT: 'webkit' }) // { ok: true, engines: ['webkit'] }
 */
export function optedOut(env: NodeJS.ProcessEnv = process.env): { ok: true; engines: readonly Engine[] } | { ok: false; message: string } {
  const named = (env[optOutVariable] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
  // Chrome is the engine every other is compared with, so it is never opted out.
  const known = named.flatMap((name): Engine[] => (name === 'firefox' || name === 'webkit' ? [name] : []))
  const unknown = named.filter((name) => !known.some((engine) => engine === name))
  if (unknown.length > 0) return { ok: false, message: `${optOutVariable} names ${unknown.join(', ')}: it takes firefox or webkit, and Chrome always runs.` }
  return { ok: true, engines: known }
}

/** Whether the machine can run the cases on `engine`, before any run tries. */
export function engineSetup(engine: Engine): EngineSetup {
  const optOut = optedOut()
  if (!optOut.ok) return { available: false, reason: optOut.message, excused: false }
  if (optOut.engines.includes(engine)) return { available: false, reason: `Not verified: ${optOutVariable} opts ${engineNames[engine]} out of this run.`, excused: true }
  if (engine === 'chrome') {
    try {
      return { available: true, executable: browserPath(), environment: {}, notes: [] }
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error), excused: false }
    }
  }
  if (process.platform !== 'darwin') return { available: false, reason: `${engineNames[engine]} is supported on macOS only in 0.1.0, and this is ${process.platform}.`, excused: true }
  const missing = (reason: string): EngineSetup => ({ available: false, reason: `${reason} Set ${optOutVariable}=${engine} to leave it unverified by name.`, excused: false })
  const driver = join(repositoryRoot, 'src/browser', engine)
  if (!existsSync(driver) || !readdirSync(driver).some((name) => name.endsWith('.ts'))) return missing(`No ${engineNames[engine]} driver: src/browser/${engine}/ holds no driver.`)
  const variable = executableVariables[engine]
  const named = process.env[variable]
  if (named !== undefined && named !== '' && !existsSync(named)) return missing(`${variable} names ${named}, which is not there.`)
  const known = knownLocations[engine]
  if ((named === undefined || named === '') && !existsSync(known)) return missing(`No ${engineNames[engine]} at ${known}, and ${variable} names none.`)
  const executable = named !== undefined && named !== '' ? named : known
  const started = engine === 'firefox' ? firefoxStart() : { environment: {}, notes: [] }
  return { available: true, executable, ...started }
}

/**
 * How the runs start Firefox: as RETEST_FIREFOX_ROUTE says when it is set, and otherwise by the driver's default, spawn,
 * unless this process may not read Firefox's data folder on macOS. A Firefox spawned by a host app without that grant
 * never starts, as Firefox's first real runs found, so the runs then take the Launch Services route, as the Firefox
 * driver's own tests do, and the results say so.
 */
function firefoxStart(): { environment: Readonly<Record<string, string>>; notes: readonly string[] } {
  const configured = process.env['RETEST_FIREFOX_ROUTE']
  if (configured !== undefined && configured !== '') return { environment: {}, notes: [`RETEST_FIREFOX_ROUTE was ${configured}.`] }
  if (firefoxDataReadable()) return { environment: {}, notes: [] }
  return {
    environment: { RETEST_FIREFOX_ROUTE: 'launch-services' },
    notes: ['This process may not read ~/Library/Application Support/Firefox, so the runs started Firefox through Launch Services rather than as a child process.'],
  }
}

function firefoxDataReadable(): boolean {
  if (process.platform !== 'darwin') return true
  try {
    readdirSync(join(homedir(), 'Library', 'Application Support', 'Firefox'))
    return true
  } catch (error) {
    return errorCode(error) !== 'EPERM'
  }
}
