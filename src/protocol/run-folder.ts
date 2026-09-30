// Paths are POSIX and relative to the run folder, so a run can be moved and still read.

/** One event per line, each line flushed as it is written. */
export const eventsFile = 'events.jsonl'

/** Written only when the run ends, so a missing file means the run did not finish. */
export const resultFile = 'result.json'

export const browserLogFile = 'logs/browser.log'

/** Where a test file's child process writes its stdout and stderr. */
export function childLogFile(file: string): string {
  return `logs/${slug(file)}.log`
}

const screenshotSlugLength = 40
const safeAttemptId = /^[a-z0-9]{1,40}$/

/**
 * Where a test's failure screenshot goes. An attempt id Retest made is safe in a file name as it is;
 * any other is reduced to a slug.
 *
 * @example failureScreenshotFile('examples/task.retest.ts > saves a task', 'k3v9q0x2mb') // 'artifacts/examples-task-retest-ts-sa-<hash>-k3v9q0x2mb-failure.png'
 */
export function failureScreenshotFile(testId: string, attemptId: string): string {
  const attempt = safeAttemptId.test(attemptId) ? attemptId : slug(attemptId)
  return `artifacts/${slug(testId, screenshotSlugLength)}-${attempt}-failure.png`
}

/**
 * The run folder used when no output folder is given, relative to where Retest runs.
 *
 * @example defaultRunFolder(new Date('2026-09-30T09:15:00Z')) // '.retest/runs/2026-09-30T09-15-00.000Z'
 */
export function defaultRunFolder(startedAt: Date): string {
  return `.retest/runs/${startedAt.toISOString().replaceAll(':', '-')}`
}

/**
 * A test's stable identity: its file, POSIX and relative to the root directory, and its name.
 *
 * @example testId('examples/task.retest.ts', 'saves a task') // 'examples/task.retest.ts > saves a task'
 */
export function testId(file: string, name: string): string {
  return `${file} > ${name}`
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
