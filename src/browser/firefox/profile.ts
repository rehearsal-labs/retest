import type { OwnedProcessIdentity } from '../../shared/process-ownership.ts'
import type { FirefoxRoute } from './route.ts'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { s, parse } from '../../protocol/schema.ts'
import { readProcessTable, readProcessTableAsync } from './process-table.ts'

/** How the temporary folders of Firefox launches begin: `retest-firefox-<pid of the launching process>-<random>`. */
export const firefoxFolderPrefix = 'retest-firefox-'

/** The name of the record a launch writes into its folder, naming who launched which Firefox. */
export const ownerRecordFile = 'retest-owner.json'

/**
 * The preferences written to the profile's `user.js`. The Remote Agent also applies its own recommended preferences,
 * since `remote.prefs.recommended` is on by default; these name what Retest relies on instead of leaving it to that list.
 */
export const firefoxPreferences: Readonly<Record<string, string | number | boolean>> = {
  // WebDriver BiDi only. Firefox 133 still offers its deprecated CDP endpoint under other values.
  'remote.active-protocols': 1,
  // No update is downloaded or applied, and no restart is asked for, while a test runs.
  'app.update.disabledForTesting': true,
  'browser.shell.checkDefaultBrowser': false,
  // No "what's new" page opens in place of the first page, and no data policy notice is shown.
  'browser.startup.homepage_override.mstone': 'ignore',
  'datareporting.policy.dataSubmissionEnabled': false,
  // No background requests to Mozilla's servers to probe the network.
  'network.captive-portal-service.enabled': false,
  'network.connectivity-service.enabled': false,
  // No offer to save a password a test typed.
  'signon.rememberSignons': false,
  // Every window of the browser behaves as the focused one, so a field Retest focused in one test's window takes the
  // keys typed into it while another test's window was opened later: pages of parallel tests share one Firefox.
  'focusmanager.testmode': true,
  // A download lands in the launch's own folder, removed at close, never in the person's Downloads folder.
  'browser.download.folderList': 2,
  'browser.download.useDownloadDir': true,
  // No page is kept in the back-forward cache, so a move through the history always loads its document again and
  // Firefox tells of it as a navigation.
  'browser.sessionhistory.max_total_viewers': 0,
}

/** Who launched a Firefox: the launching process as `ps` read it when the launch began. */
export type OwnerIdentity = { pid: number; startedAt: string; command: string }

/**
 * Start version 1 is C-locale UTC0; an absent or unknown version cannot confirm ownership.
 * What a launch writes into its folder once it knows the Firefox it started: itself, the Firefox, by the identity
 * `ps` gave it, the route that started it, and its profile. A later launch ends that Firefox only when the launching
 * process is gone and the process still has exactly this identity.
 */
export type OwnerRecord = { version: 1; startTimeVersion?: number; owner: OwnerIdentity; firefox: OwnerIdentity & { route: FirefoxRoute }; profile: string }

const identitySchema = s.object({ pid: s.number({ integer: true, min: 1 }), startedAt: s.string(), command: s.string() })
const recordSchema = s.object({
  version: s.literal(1),
  startTimeVersion: s.optional(s.number({ integer: true, min: 1 })),
  owner: identitySchema,
  firefox: s.object({ pid: s.number({ integer: true, min: 2 }), startedAt: s.string(), command: s.string(), route: s.enum(['spawn', 'launch-services']) }),
  profile: s.string(),
})

let ownIdentity: OwnerIdentity | undefined

/**
 * This process as `ps` reads it, read once: the owner every record of this process names.
 *
 * @example ownerIdentity().pid === process.pid // true
 */
export function ownerIdentity(table: () => readonly OwnedProcessIdentity[] = readProcessTable): OwnerIdentity {
  if (ownIdentity !== undefined) return ownIdentity
  const own = table().find((entry) => entry.pid === process.pid)
  if (own === undefined) throw new Error(`The process table does not list this process, ${process.pid}, so no Firefox it launches could be recorded as its own.`)
  ownIdentity = { pid: own.pid, startedAt: own.startedAt, command: own.command }
  return ownIdentity
}

/** This launcher read without holding the event loop, cached just as ownerIdentity is. */
export async function ownerIdentityAsync(): Promise<OwnerIdentity> {
  if (ownIdentity !== undefined) return ownIdentity
  const table = await readProcessTableAsync()
  return ownerIdentity(() => table)
}

/**
 * Makes a launch's temporary folder, named after this process, and the profile inside it with Retest's preferences.
 * Downloads go to the folder's `downloads`. Returns the folder and the profile; the caller removes the folder.
 */
export async function createFirefoxFolder(root: string): Promise<{ folder: string; profile: string }> {
  const folder = await mkdtemp(join(await realpath(root), `${firefoxFolderPrefix}${process.pid}-`))
  try {
    const profile = join(folder, 'profile')
    const downloads = join(folder, 'downloads')
    await mkdir(profile)
    await mkdir(downloads)
    const preferences = { ...firefoxPreferences, 'browser.download.dir': downloads }
    const lines = Object.entries(preferences).map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`)
    await writeFile(join(profile, 'user.js'), `${lines.join('\n')}\n`, { mode: 0o600 })
    return { folder, profile }
  } catch (error) {
    await rm(folder, { recursive: true, force: true })
    throw error
  }
}

/** Writes the folder's owner record whole: a temporary file renamed into place, so no reader sees half of it. */
export async function writeOwnerRecord(folder: string, record: OwnerRecord): Promise<void> {
  const partial = join(folder, `${ownerRecordFile}.partial`)
  await writeFile(partial, JSON.stringify(record), { mode: 0o600, flag: 'wx' })
  await rename(partial, join(folder, ownerRecordFile))
}

/** The folder's owner record, or undefined when it has none or it cannot be read as one. */
export async function readOwnerRecord(folder: string): Promise<OwnerRecord | undefined> {
  let text: string
  try {
    text = await readFile(join(folder, ownerRecordFile), 'utf8')
  } catch {
    return undefined
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  const parsed = parse(recordSchema, value)
  return parsed.ok ? parsed.value : undefined
}
