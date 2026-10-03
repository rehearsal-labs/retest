import type { BidiClient } from './bidi-client.ts'
import type { LaunchRoute } from './launch-firefox.ts'
import { existsSync } from 'node:fs'
import { s } from '../../src/protocol/schema.ts'

/** Where Firefox installs on macOS: the browser the proof uses unless `RETEST_FIREFOX` names another. */
export const defaultFirefoxPath = '/Applications/Firefox.app/Contents/MacOS/firefox'

/** What `session.new` says of the browser. Firefox adds its own facts under `moz:` names. */
export type SessionFacts = {
  sessionId: string
  browserName: string
  browserVersion: string
  platformName: string
  platformVersion: string
  processId: number
  profile: string
  headless: boolean
}

const sessionSchema = s.object({
  sessionId: s.string(),
  capabilities: s.object({
    browserName: s.string(),
    browserVersion: s.string(),
    platformName: s.string(),
    'moz:platformVersion': s.string(),
    'moz:processID': s.number({ integer: true }),
    'moz:profile': s.string(),
    'moz:headless': s.boolean(),
  }),
})

/**
 * The Firefox to use: `RETEST_FIREFOX`, or Firefox where macOS installs it.
 *
 * @example firefoxPath() // '/Applications/Firefox.app/Contents/MacOS/firefox'
 */
export function firefoxPath(): string {
  const configured = process.env['RETEST_FIREFOX']
  if (configured) return configured
  if (existsSync(defaultFirefoxPath)) return defaultFirefoxPath
  throw new Error(`No Firefox to use: set RETEST_FIREFOX, or install Firefox at ${defaultFirefoxPath}`)
}

/**
 * How to start Firefox: `RETEST_FIREFOX_ROUTE`, or `spawn`, which makes Firefox a child of this process as Retest
 * starts Chromium. `launch-services` is a workaround for a macOS host that may not let its children read Firefox's
 * data folder; the record explains it and what it costs.
 *
 * @example launchRoute() // 'spawn'
 */
export function launchRoute(): LaunchRoute {
  const configured = process.env['RETEST_FIREFOX_ROUTE']
  if (configured === undefined || configured === '') return 'spawn'
  if (configured === 'spawn' || configured === 'launch-services') return configured
  throw new Error(`RETEST_FIREFOX_ROUTE must be spawn or launch-services, received ${configured}`)
}

/**
 * Starts the connection's WebDriver BiDi session, asking for no particular capability, and reads what Firefox says
 * of itself.
 *
 * @example const facts = await startSession(client, 5000)
 */
export async function startSession(client: BidiClient, timeoutMs: number): Promise<SessionFacts> {
  const { sessionId, capabilities } = await client.request('session.new', { capabilities: {} }, sessionSchema, { timeoutMs })
  return {
    sessionId,
    browserName: capabilities.browserName,
    browserVersion: capabilities.browserVersion,
    platformName: capabilities.platformName,
    platformVersion: capabilities['moz:platformVersion'],
    processId: capabilities['moz:processID'],
    profile: capabilities['moz:profile'],
    headless: capabilities['moz:headless'],
  }
}
