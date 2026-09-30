// Paths are POSIX and relative to the run folder, so a run can be moved and still read.

/** One event per line, each line flushed as it is written. */
export const eventsFile = 'events.jsonl'

/** Written only when the run ends, so a missing file means the run did not finish. */
export const resultFile = 'result.json'

/** Where every log goes: the test files', the browsers' and the app servers'. */
export const logsFolder = 'logs'

export const browserLogFile = 'logs/browser.log'

/** Where a test file's child process writes its stdout and stderr. */
export function childLogFile(file: string): string {
  return `logs/${slug(file)}.log`
}

/**
 * Where one of several browsers writes its stderr. `name` says which, such as the first app target that
 * launched it.
 *
 * @example targetBrowserLogFile('web=beta') // 'logs/browser-web-beta-<hash>.log'
 */
export function targetBrowserLogFile(name: string): string {
  return `logs/browser-${slug(name)}.log`
}

/**
 * Where the server an app's `start` command runs writes its stdout and stderr.
 *
 * @example appLogFile('web') // 'logs/app-web-<hash>.log'
 */
export function appLogFile(app: string): string {
  return `logs/app-${slug(app)}.log`
}

/** The folder saved sign-in states go in. It holds session cookies, so the run deletes it when it ends. */
export const statesFolder = 'states'

/**
 * Where a setup's saved sign-in state waits for the tests that need it. Its name comes from the state and the
 * target together, so no two pairs share a file.
 *
 * @example stateFile('signed-in', 'beta') // 'states/signed-in-beta-<hash>.json'
 */
export function stateFile(state: string, target: string): string {
  return `${statesFolder}/${slug(JSON.stringify([state, target]))}.json`
}

const screenshotSlugLength = 40
const safeAttemptId = /^[a-z0-9]{1,40}$/
const appSlugLength = 24

/**
 * Where a test's failure screenshot goes. An attempt id Retest made is safe in a file name as it is;
 * any other is reduced to a slug. A test with several apps takes one screenshot of each, named with the app.
 *
 * @example failureScreenshotFile('examples/task.retest.ts > saves a task', 'k3v9q0x2mb') // 'artifacts/examples-task-retest-ts-sa-<hash>-k3v9q0x2mb-failure.png'
 */
export function failureScreenshotFile(testId: string, attemptId: string, app?: string): string {
  const attempt = safeAttemptId.test(attemptId) ? attemptId : slug(attemptId)
  const named = app === undefined ? '' : `-${slug(app, appSlugLength)}`
  return `artifacts/${slug(testId, screenshotSlugLength)}-${attempt}${named}-failure.png`
}

/**
 * The run folder used when no output folder is given, relative to where Retest runs.
 *
 * @example defaultRunFolder(new Date('2026-09-30T09:15:00Z')) // '.retest/runs/2026-09-30T09-15-00.000Z'
 */
export function defaultRunFolder(startedAt: Date): string {
  return `.retest/runs/${folderTime(startedAt)}`
}

/**
 * Where `doctor` writes the logs of the browsers and servers it starts, relative to where Retest runs.
 *
 * @example doctorFolder(new Date('2026-09-30T09:15:00Z')) // '.retest/doctor/2026-09-30T09-15-00.000Z'
 */
export function doctorFolder(startedAt: Date): string {
  return `.retest/doctor/${folderTime(startedAt)}`
}

function folderTime(date: Date): string {
  return date.toISOString().replaceAll(':', '-')
}

/**
 * A test's stable identity: its file, POSIX and relative to the root directory, and its title.
 *
 * @example testId('examples/task.retest.ts', testTitle('archives a task', ['archive'])) // 'examples/task.retest.ts > archive > archives a task'
 */
export function testId(file: string, title: string): string {
  return `${file} > ${title}`
}

/**
 * A test's full title: the names of its `test.describe` blocks, outermost first, then its own. `--grep` matches it.
 *
 * @example testTitle('archives a task', ['archive']) // 'archive > archives a task'
 */
export function testTitle(name: string, describePath: readonly string[] = []): string {
  return [...describePath, name].join(' > ')
}

const hashLength = 13

/**
 * A file-name-safe form of any text: `[a-z0-9-]`, at most `maxLength` characters, ending in a hash of
 * the whole text so that different texts get different slugs. `maxLength` is at least the 13 the hash takes.
 *
 * @example slug('Saves a task') // 'saves-a-task-' followed by 13 hash characters
 */
export function slug(text: string, maxLength = 60): string {
  if (!Number.isInteger(maxLength) || maxLength < hashLength) {
    throw new RangeError(`A slug needs at least ${hashLength} characters for its hash, received ${maxLength}.`)
  }
  const readable = text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, Math.max(0, maxLength - hashLength - 1))
    .replace(/^-+|-+$/g, '')
  const hash = fnv1a64(text)
  return readable === '' ? hash : `${readable}-${hash}`
}

const fnvOffset = 0xcbf29ce484222325n
const fnvPrime = 0x100000001b3n
const sixtyFourBits = 0xffffffffffffffffn

function fnv1a64(text: string): string {
  let hash = fnvOffset
  for (let index = 0; index < text.length; index++) {
    hash = ((hash ^ BigInt(text.charCodeAt(index))) * fnvPrime) & sixtyFourBits
  }
  return hash.toString(36).padStart(hashLength, '0')
}
