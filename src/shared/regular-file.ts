import type { BigIntStats, Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import type { Deadline } from '../protocol/deadline.ts'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { errorMessage } from '../protocol/failures.ts'
import { errorCode, isMissingFile } from './error-code.ts'

// Reading a file at a path anything could have put something else at: a record in a cache, a file a record names. Only
// a regular file is read. A link is never followed, and a FIFO, socket or device is named without being opened, so
// nothing can make the reader wait forever or read something other than the file it was pointed at.

/** A regular file opened for reading, or why it was not: nothing there, not a file, unreadable, or swapped meanwhile. */
export type OpenedFile =
  | { readonly kind: 'opened'; readonly handle: FileHandle; readonly size: number; readonly identity: FileIdentity }
  | { readonly kind: 'missing' }
  | { readonly kind: 'not_file'; readonly what: string }
  | { readonly kind: 'unreadable'; readonly problem: string }
  | { readonly kind: 'replaced' }

/**
 * Points in a reading where a test puts something else at the path: after the `lstat` that found a regular file, and
 * after the file was opened. Each is told which attempt this is.
 */
export type ReadHooks = { readonly afterCheck?: (attempt: number) => Promise<void>; readonly afterOpen?: (attempt: number) => Promise<void> }
export type FileReadControl = { readonly deadline?: Deadline; readonly signal?: AbortSignal }
export type HashReadOptions = ReadHooks & FileReadControl & { readonly maximumBytes?: number }

/** A caller's cancellation and monotonic budget are checked before and after every descriptor read. */
function readingStopped(options: FileReadControl): string | undefined {
  if (options.signal?.aborted === true || options.deadline?.signal?.aborted === true) return 'reading was stopped'
  return options.deadline?.reached === true ? 'the reading deadline was reached' : undefined
}

/**
 * Opens a file only once an `lstat` shows a regular file. Something put in its place after the `lstat` is neither
 * followed (`O_NOFOLLOW`, a link then reads as replaced) nor waited on (`O_NONBLOCK`), and the opened file must be the
 * one the `lstat` saw. The caller closes the handle.
 *
 * @example const opened = await openRegularFile('/…/build.json'); if (opened.kind === 'opened') await opened.handle.close()
 */
export async function openRegularFile(path: string, hooks: ReadHooks = {}, attempt = 1): Promise<OpenedFile> {
  let stats: BigIntStats
  try {
    stats = await lstat(path, { bigint: true })
  } catch (error) {
    return isMissingFile(error) ? { kind: 'missing' } : { kind: 'unreadable', problem: errorMessage(error) }
  }
  if (!stats.isFile()) return { kind: 'not_file', what: entryKind(stats) }
  await hooks.afterCheck?.(attempt)
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (isMissingFile(error)) return { kind: 'missing' }
    return errorCode(error) === 'ELOOP' ? { kind: 'replaced' } : { kind: 'unreadable', problem: errorMessage(error) }
  }
  let opened: BigIntStats
  try {
    opened = await handle.stat({ bigint: true })
  } catch (error) {
    await handle.close()
    return { kind: 'unreadable', problem: errorMessage(error) }
  }
  if (opened.isFile() && opened.ino === stats.ino && opened.dev === stats.dev) {
    if (opened.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      await handle.close()
      return { kind: 'unreadable', problem: 'the file size exceeds the supported integer range' }
    }
    return { kind: 'opened', handle, size: Number(opened.size), identity: { device: opened.dev.toString(), inode: opened.ino.toString() } }
  }
  await handle.close()
  return { kind: 'replaced' }
}

/**
 * Why a file was not opened, as one clause after `subject`, with no full stop.
 *
 * @example describeRefusal({ kind: 'not_file', what: 'a FIFO' }, 'it') // 'it is a FIFO, not a file'
 */
export function describeRefusal(refusal: Exclude<OpenedFile, { readonly kind: 'opened' | 'missing' }>, subject: string): string {
  if (refusal.kind === 'not_file') return `${subject} is ${refusal.what}, not a file`
  if (refusal.kind === 'replaced') return `${subject} was replaced while Retest read it`
  return `${subject} cannot be read: ${refusal.problem}`
}

/**
 * What an entry that is not a regular file is, in words.
 *
 * @example entryKind(await lstat('/tmp/pipe')) // 'a FIFO'
 */
export function entryKind(stats: Stats | BigIntStats): string {
  if (stats.isFile()) return 'a file'
  if (stats.isSymbolicLink()) return 'a link'
  if (stats.isDirectory()) return 'a folder'
  if (stats.isFIFO()) return 'a FIFO'
  if (stats.isSocket()) return 'a socket'
  if (stats.isBlockDevice() || stats.isCharacterDevice()) return 'a device'
  return 'neither a file, a folder nor a link'
}

/** A file's bytes as `readFileSha256` read them: their SHA-256, nothing at the path, or something that is not a file. */
export type FileIdentity = { readonly device: string; readonly inode: string }
export type FileReading = { readonly kind: 'file'; readonly sha256: string; readonly identity: FileIdentity } | { readonly kind: 'missing' } | { readonly kind: 'other'; readonly problem: string }

/** Refuses a pathname that no longer names the regular file whose descriptor was hashed. */
export async function checkFileIdentity(path: string, identity: FileIdentity): Promise<string | undefined> {
  try {
    const stats = await lstat(path, { bigint: true })
    return stats.isFile() && stats.dev.toString() === identity.device && stats.ino.toString() === identity.inode ? undefined : `${path} was replaced after Retest hashed it; its file identity no longer matches.`
  } catch (error) {
    return `${path} cannot be checked after hashing: ${errorMessage(error)}.`
  }
}

/** How many times a file swapped for another between its check and its open is read again before it is judged. */
const openAttempts = 3

// Opens as `openRegularFile` does, again while the file is swapped meanwhile, as a writer that renames a new copy into
// place does, up to `openAttempts` times.
async function openSettled(path: string, hooks: ReadHooks): Promise<{ readonly opened: OpenedFile; readonly attempt: number }> {
  for (let attempt = 1; ; attempt += 1) {
    const opened = await openRegularFile(path, hooks, attempt)
    if (opened.kind !== 'replaced' || attempt >= openAttempts) return { opened, attempt }
  }
}

/**
 * The SHA-256 of a regular file's bytes, or why there is none, opened as `openRegularFile` opens it, and read again
 * when it was swapped for another meanwhile. A problem is a sentence that names the path.
 *
 * @example await readFileSha256('/…/Electron.app/Contents/MacOS/Electron') // { kind: 'file', sha256: 'ca7e…' }
 */
export async function readFileSha256(path: string, options: HashReadOptions = {}): Promise<FileReading> {
  const stopped = readingStopped(options)
  if (stopped !== undefined) return { kind: 'other', problem: `${path} cannot be hashed: ${stopped}.` }
  const { opened, attempt } = await openSettled(path, options)
  if (opened.kind === 'missing') return { kind: 'missing' }
  if (opened.kind !== 'opened') return { kind: 'other', problem: `${describeRefusal(opened, path)}.` }
  const { handle } = opened
  try {
    const maximumBytes = options.maximumBytes ?? Number.MAX_SAFE_INTEGER
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new RangeError('A hash byte limit must be a nonnegative safe integer.')
    if (!Number.isSafeInteger(opened.size) || opened.size > maximumBytes) return { kind: 'other', problem: `${path} is ${opened.size} bytes, more than the maximum ${maximumBytes} bytes allowed for hashing.` }
    await options.afterOpen?.(attempt)
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let filled = 0
    for (;;) {
      const before = readingStopped(options)
      if (before !== undefined) return { kind: 'other', problem: `${path} cannot be hashed: ${before}.` }
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - filled + 1), null)
      const after = readingStopped(options)
      if (after !== undefined) return { kind: 'other', problem: `${path} cannot be hashed: ${after}.` }
      filled += bytesRead
      const size = (await handle.stat()).size
      if (filled > opened.size || size > opened.size) return { kind: 'other', problem: `${path} grew past its opening size of ${opened.size} bytes while Retest hashed it.` }
      if (size !== opened.size || (bytesRead === 0 && filled !== opened.size)) return { kind: 'other', problem: `${path} changed size while Retest hashed it.` }
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    const after = readingStopped(options)
    if (after !== undefined) return { kind: 'other', problem: `${path} cannot be hashed: ${after}.` }
    return { kind: 'file', sha256: hash.digest('hex'), identity: opened.identity }
  } catch (error) {
    return { kind: 'other', problem: `${path} cannot be read: ${errorMessage(error)}.` }
  } finally {
    await handle.close()
  }
}

/** No record Retest writes beside a build, or as a lock's ticket, comes near this; a file past it is refused unread. */
export const maximumRecordBytes: number = 1024 * 1024

/** A record's text, nothing at its path, or why it was not read, as a clause about "it" with no full stop. */
export type RecordText = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'missing' } | { readonly kind: 'unreadable'; readonly problem: string }

/**
 * The text of a small record file, opened as `openRegularFile` opens it, read again when it was swapped for another
 * meanwhile, and refused when it is larger than a record Retest writes: at most one byte past that is ever read, from
 * the file that was checked, so one that grows while it is read is refused too. A problem reads after "cannot be
 * read:", as in "Its build.json cannot be read: it is a FIFO, not a file."
 *
 * @example (await readRecordText('/…/build.json')).kind // 'text'
 */
export async function readRecordText(path: string, hooks: ReadHooks & FileReadControl = {}): Promise<RecordText> {
  const stopped = readingStopped(hooks)
  if (stopped !== undefined) return { kind: 'unreadable', problem: stopped }
  const { opened, attempt } = await openSettled(path, hooks)
  if (opened.kind === 'missing') return { kind: 'missing' }
  if (opened.kind === 'unreadable') return { kind: 'unreadable', problem: opened.problem }
  if (opened.kind !== 'opened') return { kind: 'unreadable', problem: describeRefusal(opened, 'it') }
  try {
    if (opened.size > maximumRecordBytes) return { kind: 'unreadable', problem: `it is ${opened.size} bytes, more than the ${maximumRecordBytes} a record Retest writes may take` }
    await hooks.afterOpen?.(attempt)
    const buffer = Buffer.alloc(maximumRecordBytes + 1)
    let filled = 0
    while (filled < buffer.length) {
      const before = readingStopped(hooks)
      if (before !== undefined) return { kind: 'unreadable', problem: before }
      const { bytesRead } = await opened.handle.read(buffer, filled, buffer.length - filled, null)
      const after = readingStopped(hooks)
      if (after !== undefined) return { kind: 'unreadable', problem: after }
      if (bytesRead === 0) break
      filled += bytesRead
    }
    if (filled > maximumRecordBytes) return { kind: 'unreadable', problem: `it grew past the ${maximumRecordBytes} bytes a record Retest writes may take while Retest read it` }
    return { kind: 'text', text: buffer.subarray(0, filled).toString('utf8') }
  } catch (error) {
    return { kind: 'unreadable', problem: errorMessage(error) }
  } finally {
    await opened.handle.close()
  }
}
