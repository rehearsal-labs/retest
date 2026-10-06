import type { EvidenceRecord } from '../protocol/evaluation.ts'
import type { RetestEvent, TestStatus } from '../protocol/events.ts'
import type { RecordIdentity } from '../protocol/identity.ts'
import type { RecordingRecord } from '../protocol/recording.ts'
import type { RunResult } from '../protocol/result.ts'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, unlinkSync, type BigIntStats, type Dirent } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { formatSessionId } from '../protocol/evidence.ts'
import { errorMessage } from '../protocol/failures.ts'
import { diagnosticsFolder, eventsFile, logsFolder, resultFile, slug, statesFolder } from '../protocol/run-folder.ts'
import { errorCode, isMissingFile } from '../shared/error-code.ts'
import { RunFolderReadError } from './rebuild-result.ts'

// Where a run's media and diagnostics live, how a reader opens them without leaving the run folder, and what is kept.
// Names are made only of what Retest itself made or the config named: the attempt id, a slug of the app's name, the
// kind, a closed purpose and a sequence number. No page text, test title or secret reaches a file name.
//
//   artifacts/<attempt>/<app>/screenshot-<purpose>-<n>.png|jpg
//   artifacts/<attempt>/<app>/thumbnail-screenshot-<purpose>-<n>.png|jpg, thumbnail-recording-<n>.png|jpg
//   artifacts/<attempt>/<app>/recording-<n>.mp4|webm   (recording-<n>.mp4.partial while the media process writes it)
//   artifacts/<attempt>/<app>/frames-<n>/<index>.png|jpg
//   diagnostics/<attempt>.<app>.jsonl
//   report.html

/** What an artifact is. `frames` is one frame of a timestamped sequence kept for an AI check of an interval. */
export type ArtifactKind = 'screenshot' | 'thumbnail' | 'recording' | 'frames' | 'diagnostics' | 'report'

export type ImageFormat = 'png' | 'jpeg'

/** Why a screenshot was taken: when its test failed, or as an AI check's evidence. */
export type ScreenshotPurpose = 'failure' | 'evaluation'

export type RecordingContainer = 'mp4' | 'webm'

/** What a thumbnail was made from: one screenshot, or one recording. */
export type ThumbnailSource = { readonly kind: 'screenshot'; readonly purpose: ScreenshotPurpose; readonly sequence: number } | { readonly kind: 'recording'; readonly sequence: number }

/**
 * Everything `artifactPath` needs. A session's artifacts name the session by its record identity, whose `sessionId`
 * must be the attempt's id and the app's name as `formatSessionId` writes them; `testId` and `observationId` never
 * reach a name. `sequence` numbers one session's artifacts of one family from 1, as `ArtifactSequences` hands them
 * out; a thumbnail takes the family and number of what it was made from. The report is the run's own.
 */
export type ArtifactSpec =
  | { readonly kind: 'screenshot'; readonly identity: RecordIdentity; readonly purpose: ScreenshotPurpose; readonly sequence: number; readonly format: ImageFormat }
  | { readonly kind: 'thumbnail'; readonly identity: RecordIdentity; readonly of: ThumbnailSource; readonly format: ImageFormat }
  | { readonly kind: 'recording'; readonly identity: RecordIdentity; readonly sequence: number; readonly container: RecordingContainer }
  | { readonly kind: 'frames'; readonly identity: RecordIdentity; readonly sequence: number; readonly index: number; readonly format: ImageFormat }
  | { readonly kind: 'diagnostics'; readonly identity: RecordIdentity }
  | { readonly kind: 'report' }

/** The folder every session's media goes in, one folder for each attempt and one for each app inside it. */
export const artifactsFolder = 'artifacts'

/** The run's HTML report, at the top of the run folder, so its references to artifacts are the references themselves. */
export const reportFile = 'report.html'

/** What the media process adds to a recording's path while ffmpeg writes it; the finished video drops it. */
export const partialSuffix = '.partial'

const safeAttemptId = /^[a-z0-9]{1,40}$/
const segmentSlugLength = 24
const purposes: ReadonlySet<string> = new Set<ScreenshotPurpose>(['failure', 'evaluation'])
const formats: ReadonlySet<string> = new Set<ImageFormat>(['png', 'jpeg'])
const containers: ReadonlySet<string> = new Set<RecordingContainer>(['mp4', 'webm'])
const frameIndexDigits = 6

/**
 * Where an artifact goes, relative to the run folder, POSIX. Throws `RangeError` for an identity whose session id is
 * not its attempt's and app's, or for a sequence, index, purpose or format outside what is listed, so a name never
 * holds anything else.
 *
 * @example artifactPath({ kind: 'screenshot', identity, purpose: 'failure', sequence: 1, format: 'png' }) // 'artifacts/k3v9q0x2mb/web-<hash>/screenshot-failure-1.png'
 */
export function artifactPath(spec: ArtifactSpec): string {
  if (spec.kind === 'report') return reportFile
  const owner = ownerSegments(spec.identity)
  const folder = `${artifactsFolder}/${owner.attempt}/${owner.app}`
  switch (spec.kind) {
    case 'diagnostics':
      return `${diagnosticsFolder}/${owner.attempt}.${owner.app}.jsonl`
    case 'screenshot':
      return `${folder}/screenshot-${purpose(spec.purpose)}-${sequence(spec.sequence)}.${extension(spec.format)}`
    case 'thumbnail':
      return `${folder}/thumbnail-${thumbnailOf(spec.of)}.${extension(spec.format)}`
    case 'recording':
      if (!containers.has(spec.container)) throw new RangeError(`A recording's container is mp4 or webm, received ${JSON.stringify(spec.container)}.`)
      return `${folder}/recording-${sequence(spec.sequence)}.${spec.container}`
    case 'frames':
      return `${folder}/frames-${sequence(spec.sequence)}/${frameIndex(spec.index)}.${extension(spec.format)}`
  }
}

/**
 * The path the media process is given as a recording's `output`, relative to the run folder: the recording's path
 * without its extension, which the process adds once it knows the container. Join it to the run folder with
 * `resolveReference`, and create its folder with `createArtifactFolder`.
 *
 * @example recordingOutput(identity, 1) // 'artifacts/k3v9q0x2mb/web-<hash>/recording-1'
 */
export function recordingOutput(identity: RecordIdentity, recordingSequence: number): string {
  const path = artifactPath({ kind: 'recording', identity, sequence: recordingSequence, container: 'mp4' })
  return path.slice(0, -'.mp4'.length)
}

/** A family of one session's numbered artifacts: screenshots by purpose, recordings, and frame sequences. */
export type SequenceFamily = ScreenshotPurpose | 'recording' | 'frames'

/** Hands out each session's artifact numbers, from 1 for each family, so two writers of one run never share a name. */
export class ArtifactSequences {
  readonly #last = new Map<string, number>()

  /**
   * The next number for one session's artifacts of `family`.
   *
   * @example sequences.next(identity, 'evaluation') // 1, then 2
   */
  next(identity: RecordIdentity, family: SequenceFamily): number {
    ownerSegments(identity)
    const key = JSON.stringify([identity.sessionId, family])
    const next = (this.#last.get(key) ?? 0) + 1
    this.#last.set(key, next)
    return next
  }
}

function ownerSegments(identity: RecordIdentity): { attempt: string; app: string } {
  const { attemptId, app, sessionId } = identity
  if (attemptId === '' || app === '') throw new RangeError('An artifact belongs to a session with an attempt id and an app name.')
  if (sessionId !== formatSessionId(attemptId, app)) {
    throw new RangeError(`The identity names session ${JSON.stringify(sessionId)}, which is not ${JSON.stringify(formatSessionId(attemptId, app))}, the session of attempt ${JSON.stringify(attemptId)} and app ${JSON.stringify(app)}.`)
  }
  return { attempt: safeAttemptId.test(attemptId) ? attemptId : slug(attemptId, segmentSlugLength), app: slug(app, segmentSlugLength) }
}

function purpose(value: ScreenshotPurpose): string {
  if (!purposes.has(value)) throw new RangeError(`A screenshot's purpose is failure or evaluation, received ${JSON.stringify(value)}.`)
  return value
}

function sequence(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`An artifact's sequence number is a whole number from 1, received ${value}.`)
  return String(value)
}

function frameIndex(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`A frame's index is a whole number from 0, received ${value}.`)
  return String(value).padStart(frameIndexDigits, '0')
}

function extension(format: ImageFormat): string {
  if (!formats.has(format)) throw new RangeError(`An image is png or jpeg, received ${JSON.stringify(format)}.`)
  return format === 'png' ? 'png' : 'jpg'
}

function thumbnailOf(source: ThumbnailSource): string {
  if (source.kind === 'recording') return `recording-${sequence(source.sequence)}`
  return `screenshot-${purpose(source.purpose)}-${sequence(source.sequence)}`
}

// References -------------------------------------------------------------------------------------------------------

const referenceSegment = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/
const maxReferenceLength = 1024
const maxSegmentLength = 255

/**
 * Why `reference` is not a portable reference to a file in a run folder, or undefined when it is one: a POSIX path
 * relative to the run folder, at most 1024 characters, whose parts are letters, digits, `.`, `_` and `-`, none empty
 * and none starting with `.`. So no `..`, no absolute path, no backslash, no drive and no control character. Every
 * name `artifactPath` gives is one, and so is every artifact path Retest has written before.
 *
 * @example referenceProblem('../../etc/passwd') // 'a part of it starts with "."'
 */
export function referenceProblem(reference: string): string | undefined {
  if (reference === '') return 'it is empty'
  if (reference.length > maxReferenceLength) return `it is longer than ${maxReferenceLength} characters`
  if (reference.startsWith('/')) return 'it is an absolute path'
  if (reference.includes('\\')) return 'it holds a backslash'
  for (const segment of reference.split('/')) {
    if (segment === '') return 'it holds an empty part'
    if (segment.startsWith('.')) return 'a part of it starts with "."'
    if (segment.length > maxSegmentLength) return `a part of it is longer than ${maxSegmentLength} characters`
    if (!referenceSegment.test(segment)) return 'a part of it holds a character other than letters, digits, ".", "_" and "-"'
  }
  return undefined
}

/** Why Retest refused an artifact, by name. */
export type ArtifactRefusal =
  | 'invalid_reference'
  | 'missing'
  | 'symbolic_link'
  | 'outside_run_folder'
  | 'hard_link'
  | 'not_regular_file'
  | 'too_large'
  | 'changed'
  | 'unreadable'

/** A refusal: the reference, the reason by name, and a sentence a report can show. The message never quotes file contents. */
export type ArtifactRefused = { readonly ok: false; readonly reference: string; readonly reason: ArtifactRefusal; readonly message: string }

/**
 * The portable reference of a file at `path`, relative to `runFolder`, as events and reports record it: the path the
 * media process reports for a finished recording, say. Folders are compared by where they really are, so a folder
 * inside the run folder that is a link to somewhere else gives a refusal, and so does any path outside it.
 *
 * @example portableReference('/work/.retest/runs/r1', '/work/.retest/runs/r1/artifacts/k3v9q0x2mb/web-<hash>/recording-1.mp4')
 */
export function portableReference(runFolder: string, path: string): { readonly ok: true; readonly reference: string } | ArtifactRefused {
  const root = realOrResolved(runFolder)
  const target = join(realOrResolved(dirname(resolve(path))), basename(path))
  const inside = relative(root, target)
  const reference = inside.split(sep).join('/')
  if (inside === '' || isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) {
    return refused(path, 'outside_run_folder', 'The path is not inside the run folder.')
  }
  const problem = referenceProblem(reference)
  return problem === undefined ? { ok: true, reference } : refused(reference, 'invalid_reference', `${describe(reference)} cannot be a reference: ${problem}.`)
}

/**
 * The absolute path a portable reference names in `runFolder`, after checking the reference. It does not look at the
 * disk: read through `readArtifactFile`, and create folders through `createArtifactFolder`, which do.
 *
 * @example resolveReference('/work/.retest/runs/r1', 'artifacts/k3v9q0x2mb/web-<hash>/screenshot-failure-1.png')
 */
export function resolveReference(runFolder: string, reference: string): { readonly ok: true; readonly path: string } | ArtifactRefused {
  const problem = referenceProblem(reference)
  if (problem !== undefined) return refused(reference, 'invalid_reference', `${describe(reference)} is not a reference to a file in the run folder: ${problem}.`)
  return { ok: true, path: join(resolve(runFolder), ...reference.split('/')) }
}

/**
 * Creates the folders an artifact goes in, one at a time, inside `runFolder`, and refuses a part that is a link or a
 * file rather than following it, so a write to the returned path stays in the run folder. A folder that is already
 * there is kept.
 *
 * @example createArtifactFolder(store.directory, recordingOutput(identity, 1))
 */
export function createArtifactFolder(runFolder: string, reference: string): { readonly ok: true; readonly path: string } | ArtifactRefused {
  const problem = referenceProblem(reference)
  if (problem !== undefined) return refused(reference, 'invalid_reference', `${describe(reference)} is not a reference to a file in the run folder: ${problem}.`)
  const root = realRoot(runFolder, reference)
  if (!root.ok) return root
  const segments = reference.split('/')
  const folders: Link[] = []
  let current = root.path
  for (const [index, segment] of segments.slice(0, -1).entries()) {
    current = join(current, segment)
    const shown = describe(segments.slice(0, index + 1).join('/'))
    try {
      mkdirSync(current)
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') return refused(reference, 'unreadable', `Retest could not create ${shown} in the run folder: ${errorMessage(error)}`)
    }
    const stats = lstatIfPresent(current)
    if (stats === undefined || !stats.ok) return refused(reference, 'unreadable', `Retest could not read ${shown} in the run folder.`)
    if (stats.value.isSymbolicLink()) return linkRefusal(reference, root.path, current, segments.slice(0, index + 1).join('/'))
    if (!stats.value.isDirectory()) return refused(reference, 'not_regular_file', `${shown} in the run folder is a file, not a folder.`)
    folders.push({ path: current, shown, dev: stats.value.dev, ino: stats.value.ino })
  }
  // Each folder was made or read through the ones above it by name, so a folder swapped for a link meanwhile would
  // have sent the rest elsewhere; every one is read again now that the last exists.
  for (const folder of folders) {
    const now = lstatIfPresent(folder.path)
    if (now === undefined || !now.ok || now.value.isSymbolicLink() || now.value.dev !== folder.dev || now.value.ino !== folder.ino) {
      return refused(reference, 'changed', `${folder.shown} was replaced while Retest created the folders for ${describe(reference)}.`)
    }
  }
  return { ok: true, path: join(current, segments.at(-1) ?? '') }
}

// Safe reads -------------------------------------------------------------------------------------------------------

/** How large a file a read accepts, in bytes. The caller states it; there is no default. */
export type ReadLimits = { readonly maxBytes: number }

type Link = { readonly path: string; readonly shown: string; readonly dev: bigint; readonly ino: bigint }

/**
 * A file `checkArtifact` found in the run folder: a regular file with one name, no larger than the limit, reached
 * through folders none of which is a link. `open` opens it and checks again that nothing in its path changed.
 */
export class CheckedArtifact {
  readonly reference: string
  /** Where the file is, under the run folder's real path. */
  readonly path: string
  readonly size: number
  readonly #folders: readonly Link[]
  readonly #file: Link
  readonly #maxBytes: number

  constructor(options: { reference: string; path: string; size: number; folders: readonly Link[]; file: Link; maxBytes: number }) {
    this.reference = options.reference
    this.path = options.path
    this.size = options.size
    this.#folders = options.folders
    this.#file = options.file
    this.#maxBytes = options.maxBytes
  }

  /**
   * Opens the file without following a link in its last part and without waiting on a pipe, then checks that the
   * descriptor holds the very file that was checked, that it still has one name and fits the limit, and that every
   * folder above it, the run folder included, is still the folder that was checked and not a link. A folder swapped
   * for a link between the check and the open, or a file swapped for another, is refused as `changed`.
   */
  open(): { readonly ok: true; readonly file: OpenedArtifact } | ArtifactRefused {
    let descriptor: number
    try {
      descriptor = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } catch (error) {
      const code = errorCode(error)
      if (code === 'ELOOP') return refused(this.reference, 'changed', `${describe(this.reference)} became a symbolic link after it was checked.`)
      if (isMissingFile(error)) return refused(this.reference, 'changed', `${describe(this.reference)} was removed or moved after it was checked.`)
      return refused(this.reference, 'unreadable', `${describe(this.reference)} could not be opened: ${errorMessage(error)}`)
    }
    const problem = this.#descriptorProblem(descriptor) ?? this.verify()
    if (problem !== undefined) {
      closeSync(descriptor)
      return problem
    }
    return { ok: true, file: new OpenedArtifact(this.reference, this.path, this.size, descriptor) }
  }

  /**
   * Checks again that every folder from the run folder down is the folder that was checked, not a link, and that the
   * file's name still leads to the file that was checked. Undefined when nothing changed.
   */
  verify(): ArtifactRefused | undefined {
    for (const folder of this.#folders) {
      const now = lstatIfPresent(folder.path)
      if (now === undefined || !now.ok || now.value.isSymbolicLink() || !now.value.isDirectory() || now.value.dev !== folder.dev || now.value.ino !== folder.ino) {
        return refused(this.reference, 'changed', `${folder.shown} was replaced after ${describe(this.reference)} was checked.`)
      }
    }
    const named = lstatIfPresent(this.path)
    if (named === undefined || !named.ok || named.value.isSymbolicLink() || named.value.dev !== this.#file.dev || named.value.ino !== this.#file.ino) {
      return refused(this.reference, 'changed', `${describe(this.reference)} was replaced after it was checked.`)
    }
    return undefined
  }

  /** Removes an entry only while its opened parent folder still has the checked identity. */
  remove(): ArtifactRefused | undefined {
    const parent = this.#folders.at(-1)
    if (parent === undefined) return refused(this.reference, 'changed', 'The artifact parent folder was not recorded.')
    let descriptor: number
    try {
      descriptor = openSync(parent.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    } catch (error) {
      return refused(this.reference, 'changed', `${parent.shown} changed before removal: ${errorMessage(error)}`)
    }
    try {
      const opened = fstatSync(descriptor, { bigint: true })
      if (!opened.isDirectory() || opened.dev !== parent.dev || opened.ino !== parent.ino) return refused(this.reference, 'changed', `${parent.shown} was replaced before removal.`)
      const problem = this.verify()
      if (problem !== undefined) return problem
      // Keep the descriptor open through the final call and recheck the names before entering the directory.
      for (const folder of this.#folders) {
        const now = lstatIfPresent(folder.path)
        if (now === undefined || !now.ok || !now.value.isDirectory() || now.value.isSymbolicLink() || now.value.dev !== folder.dev || now.value.ino !== folder.ino) return refused(this.reference, 'changed', `${folder.shown} was replaced before removal.`)
      }
      const current = fstatSync(descriptor, { bigint: true })
      if (current.dev !== parent.dev || current.ino !== parent.ino) return refused(this.reference, 'changed', `${parent.shown} changed before removal.`)
      if (process.platform === 'linux') return unlink(join(`/proc/self/fd/${descriptor}`, basename(this.path)), this.reference)
      // Node has no unlinkat/fchdir API on macOS. chdir is synchronous: once "." matches the open descriptor,
      // a relative unlink uses that directory's vnode even if its old pathname is renamed or replaced. No awaited
      // work, recorder or reporter runs while the process directory is changed, and it is restored before return.
      const previous = process.cwd()
      try {
        process.chdir(parent.path)
        const anchored = lstatSync('.', { bigint: true })
        if (!anchored.isDirectory() || anchored.dev !== opened.dev || anchored.ino !== opened.ino) return refused(this.reference, 'changed', `${parent.shown} was replaced before removal.`)
        const entry = basename(this.path)
        const named = lstatSync(entry, { bigint: true })
        if (!named.isFile() || named.dev !== this.#file.dev || named.ino !== this.#file.ino || named.nlink !== 1n) return refused(this.reference, 'changed', `${describe(this.reference)} was replaced before removal.`)
        return unlink(entry, this.reference)
      } finally {
        process.chdir(previous)
      }
    } catch (error) {
      return refused(this.reference, 'unreadable', `Retest could not remove ${describe(this.reference)}: ${errorMessage(error)}`)
    } finally {
      closeSync(descriptor)
    }
  }

  #descriptorProblem(descriptor: number): ArtifactRefused | undefined {
    let stats: BigIntStats
    try {
      stats = fstatSync(descriptor, { bigint: true })
    } catch (error) {
      return refused(this.reference, 'unreadable', `${describe(this.reference)} could not be read: ${errorMessage(error)}`)
    }
    if (!stats.isFile()) return refused(this.reference, 'changed', `${describe(this.reference)} is no longer a regular file.`)
    if (stats.dev !== this.#file.dev || stats.ino !== this.#file.ino) return refused(this.reference, 'changed', `Another file took the place of ${describe(this.reference)} after it was checked.`)
    if (stats.nlink > 1n) return hardLinkRefusal(this.reference, stats.nlink)
    if (stats.size > BigInt(this.#maxBytes)) return tooLarge(this.reference, stats.size, this.#maxBytes)
    return undefined
  }
}

/** A file in the run folder, open for reading. The caller closes it; `read` reads it whole. */
export class OpenedArtifact {
  readonly reference: string
  readonly path: string
  readonly size: number
  /** The open descriptor, for a caller that streams the file, as with `createReadStream(path, { fd })`. */
  readonly descriptor: number
  #closed = false

  constructor(reference: string, path: string, size: number, descriptor: number) {
    this.reference = reference
    this.path = path
    this.size = size
    this.descriptor = descriptor
  }

  /** Reads the whole file. A file that grew or shrank since it was checked is refused as `changed`. */
  read(): { readonly ok: true; readonly bytes: Buffer } | ArtifactRefused {
    const bytes = Buffer.alloc(this.size)
    let offset = 0
    try {
      while (offset < this.size) {
        const read = readSync(this.descriptor, bytes, offset, this.size - offset, offset)
        if (read === 0) return refused(this.reference, 'changed', `${describe(this.reference)} became shorter while it was read.`)
        offset += read
      }
      if (readSync(this.descriptor, Buffer.alloc(1), 0, 1, this.size) > 0) return refused(this.reference, 'changed', `${describe(this.reference)} grew while it was read.`)
    } catch (error) {
      return refused(this.reference, 'unreadable', `${describe(this.reference)} could not be read: ${errorMessage(error)}`)
    }
    return { ok: true, bytes }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    closeSync(this.descriptor)
  }
}

/**
 * Looks for the file a reference names in `runFolder` without following any link: every part below the run folder is
 * read with `lstat`, so a symbolic link anywhere is refused, by `outside_run_folder` when it leads out of the run folder
 * and `symbolic_link` when it stays inside. A file with more than one name is refused as `hard_link`, since its other
 * name may be anywhere; anything but a regular file is refused as `not_regular_file`; a file over `maxBytes` as
 * `too_large`. Nothing is opened.
 *
 * @example const checked = checkArtifact(runFolder, evidence.path, { maxBytes: 64 * 1024 * 1024 })
 */
export function checkArtifact(runFolder: string, reference: string, limits: ReadLimits): { readonly ok: true; readonly artifact: CheckedArtifact } | ArtifactRefused {
  const { maxBytes } = limits
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError(`maxBytes is a whole number of bytes from 0, received ${maxBytes}.`)
  const problem = referenceProblem(reference)
  if (problem !== undefined) return refused(reference, 'invalid_reference', `${describe(reference)} is not a reference to a file in the run folder: ${problem}.`)
  const root = realRoot(runFolder, reference)
  if (!root.ok) return root
  const rootStats = lstatIfPresent(root.path)
  if (rootStats === undefined || !rootStats.ok || !rootStats.value.isDirectory()) return refused(reference, 'missing', 'The run folder is not a folder.')
  const folders: Link[] = [{ path: root.path, shown: 'The run folder', dev: rootStats.value.dev, ino: rootStats.value.ino }]
  const segments = reference.split('/')
  let current = root.path
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment)
    const shown = segments.slice(0, index + 1).join('/')
    const stats = lstatIfPresent(current)
    if (stats === undefined) return refused(reference, 'missing', `${describe(reference)} is not in the run folder.`)
    if (!stats.ok) return refused(reference, 'unreadable', `${describe(shown)} could not be read: ${stats.problem}`)
    if (stats.value.isSymbolicLink()) return linkRefusal(reference, root.path, current, shown)
    if (index < segments.length - 1) {
      if (!stats.value.isDirectory()) return refused(reference, 'missing', `${describe(reference)} is not in the run folder: ${describe(shown)} is not a folder.`)
      folders.push({ path: current, shown: describe(shown), dev: stats.value.dev, ino: stats.value.ino })
      continue
    }
    if (!stats.value.isFile()) return refused(reference, 'not_regular_file', `${describe(reference)} is ${fileType(stats.value)}, not a regular file.`)
    if (stats.value.nlink > 1n) return hardLinkRefusal(reference, stats.value.nlink)
    if (stats.value.size > BigInt(maxBytes)) return tooLarge(reference, stats.value.size, maxBytes)
    const file: Link = { path: current, shown: describe(shown), dev: stats.value.dev, ino: stats.value.ino }
    return { ok: true, artifact: new CheckedArtifact({ reference, path: current, size: Number(stats.value.size), folders, file, maxBytes }) }
  }
  return refused(reference, 'invalid_reference', `${describe(reference)} names no file.`)
}

/**
 * Reads a whole artifact from a run folder: `checkArtifact`, then `open`, then `read`, then close. Every refusal is
 * named; nothing outside the run folder is ever read.
 *
 * @example readArtifactFile('/work/.retest/runs/r1', 'artifacts/k3v9q0x2mb/web-<hash>/screenshot-failure-1.png', { maxBytes: 64 * 1024 * 1024 })
 */
export function readArtifactFile(runFolder: string, reference: string, limits: ReadLimits): { readonly ok: true; readonly reference: string; readonly path: string; readonly bytes: Buffer } | ArtifactRefused {
  const checked = checkArtifact(runFolder, reference, limits)
  if (!checked.ok) return checked
  const opened = checked.artifact.open()
  if (!opened.ok) return opened
  try {
    const read = opened.file.read()
    return read.ok ? { ok: true, reference, path: opened.file.path, bytes: read.bytes } : read
  } finally {
    opened.file.close()
  }
}

// Listing ----------------------------------------------------------------------------------------------------------

/**
 * A file a record names. `namedBy` is the record: an event type, or `result.json`. The identity keys are the record's,
 * when it has them. `evidenceOf: 'evaluation'` marks a file an AI check's evidence names, which retention never
 * removes. `of` is the reference of what a thumbnail was made from.
 */
export type ArtifactReference = {
  readonly path: string
  readonly kind: ArtifactKind
  readonly namedBy: string
  readonly testId?: string
  readonly attemptId?: string
  readonly app?: string
  readonly sessionId?: string
  readonly evidenceOf?: 'evaluation'
  readonly of?: string
}

/** References of a recording, with its original identity; a removed video is no longer required to exist. */
export function recordingArtifactReferences(recording: RecordingRecord, namedBy: string): ArtifactReference[] {
  const identity = { testId: recording.testId, attemptId: recording.attemptId, app: recording.app, sessionId: recording.sessionId }
  const paths = [...(recording.path === undefined || recording.removed !== undefined ? [] : [recording.path]), ...(recording.partialPath === undefined ? [] : [recording.partialPath])]
  return paths.map(path => ({ path, kind: 'recording', namedBy, ...identity }))
}

/**
 * The artifacts the events of a run name: failure screenshots (`evidence.captured`), diagnostics artifacts
 * (`diagnostics.finished`) and the screenshots AI checks sent their judges (`evaluation.finished`). Event types this
 * reader does not know name nothing here, so an event type added later must be added to this function. Recordings name
 * videos and partial files; retention removes references unless a later removal failure preserves the file.
 *
 * @example eventArtifactReferences(readRunFolder(folder).events)
 */
export function eventArtifactReferences(events: readonly RetestEvent[]): ArtifactReference[] {
  const removed = new Set<string>()
  for (const event of events) {
    if (event.type === 'artifact.removed') removed.add(event.path)
    else if (event.type === 'artifact.removal_failed') removed.delete(event.path)
  }
  const references: ArtifactReference[] = []
  for (const event of events) {
    if (event.type === 'evidence.captured') {
      references.push({ path: event.path, kind: 'screenshot', namedBy: event.type, ...owner({ testId: event.testId, attemptId: event.attemptId, app: event.session, sessionId: event.sessionId }) })
    } else if (event.type === 'diagnostics.finished' && event.diagnostics.path !== undefined) {
      references.push({ path: event.diagnostics.path, kind: 'diagnostics', namedBy: event.type, ...owner({ testId: event.testId, attemptId: event.attemptId, app: event.session, sessionId: event.sessionId }) })
    } else if (event.type === 'recording.finished') {
      references.push(...recordingArtifactReferences(event.recording, event.type))
    } else if (event.type === 'evaluation.finished') {
      for (const record of event.evaluation.evidence) {
        references.push(...evaluationArtifactReferences(record, event.type, record.testId ?? event.testId))
      }
    }
  }
  return references.filter(reference => !removed.has(reference.path))
}

/**
 * The artifacts `result.json` names: each test's screenshots, diagnostics, AI check evidence and retained recordings.
 *
 * @example resultArtifactReferences(readRunFolder(folder).result)
 */
export function resultArtifactReferences(result: RunResult): ArtifactReference[] {
  const references: ArtifactReference[] = []
  const namedBy = resultFile
  for (const test of result.files.flatMap((file) => file.tests)) {
    for (const recording of test.recordings ?? []) references.push(...recordingArtifactReferences(recording, namedBy))
    for (const evidence of test.evidence) {
      references.push({ path: evidence.path, kind: 'screenshot', namedBy, ...owner({ testId: test.testId, attemptId: evidence.attemptId ?? test.attemptId, app: evidence.app, sessionId: evidence.sessionId }) })
    }
    for (const diagnostics of test.diagnostics ?? []) {
      if (diagnostics.path === undefined) continue
      references.push({ path: diagnostics.path, kind: 'diagnostics', namedBy, ...owner({ testId: test.testId, attemptId: test.attemptId, app: diagnostics.app, sessionId: diagnostics.sessionId }) })
    }
    for (const record of (test.evaluations ?? []).flatMap((evaluation) => evaluation.evidence)) {
      references.push(...evaluationArtifactReferences(record, namedBy, test.testId))
    }
  }
  return references
}

function evaluationArtifactReferences(record: EvidenceRecord, namedBy: string, testId: string | undefined): ArtifactReference[] {
  if (record.kind === 'text') return []
  const paths = [...(record.path === undefined ? [] : [record.path]), ...(record.kind === 'frames' ? (record.frames ?? []).map((frame) => frame.path) : [])]
  return [...new Set(paths)].map((path) => ({ path, kind: record.kind === 'frames' ? 'frames' : record.kind === 'diagnostics' ? 'diagnostics' : 'screenshot', namedBy, evidenceOf: 'evaluation', ...owner({ testId, attemptId: record.attemptId, app: record.app, sessionId: record.sessionId }) }))
}

/** A file in the run folder and its size in bytes. */
export type InventoryFile = { readonly reference: string; readonly size: number }

/**
 * What a run folder holds against what its records name. `present`: named, and a regular file a safe read accepts.
 * `missing`: named, but not there or not readable as an artifact, with the reason. `unreferenced`: a regular file no
 * record names, `partial` when its name ends in `.partial`. `refused`: entries the listing did not follow or count,
 * such as links and pipes. `truncated` is true when the folder held more entries than the listing reads. The
 * run's own files are left out: `events.jsonl`, `result.json`, `report.html`, `logs/` and `states/`.
 */
export type ArtifactInventory = {
  readonly present: readonly (InventoryFile & { readonly namedBy: readonly string[] })[]
  readonly missing: readonly { readonly reference: string; readonly reason: ArtifactRefusal; readonly message: string; readonly namedBy: readonly string[] }[]
  readonly unreferenced: readonly (InventoryFile & { readonly partial: boolean })[]
  readonly refused: readonly { readonly reference: string; readonly reason: ArtifactRefusal; readonly message: string }[]
  readonly truncated: boolean
}

const runOwnFiles: ReadonlySet<string> = new Set([eventsFile, resultFile, `${resultFile}${partialSuffix}`, reportFile])
const runOwnFolders: ReadonlySet<string> = new Set([logsFolder, statesFolder])
const defaultMaxEntries = 100_000
const maxDepth = 16

/**
 * Lists what `runFolder` holds against `references`, never following a link. Throws `RunFolderReadError` when the
 * run folder itself cannot be read.
 *
 * @example inventoryArtifacts(folder, [...eventArtifactReferences(run.events), ...resultArtifactReferences(run.result)])
 */
export function inventoryArtifacts(runFolder: string, references: readonly ArtifactReference[], options: { readonly maxEntries?: number } = {}): ArtifactInventory {
  let root: string
  try {
    root = realpathSync.native(runFolder)
  } catch (error) {
    throw new RunFolderReadError(`The run folder ${runFolder} could not be read: ${errorMessage(error)}`, { cause: error })
  }
  const walked = walk(root, options.maxEntries ?? defaultMaxEntries)
  const named = new Map<string, string[]>()
  for (const reference of references) named.set(reference.path, [...new Set([...(named.get(reference.path) ?? []), reference.namedBy])])
  const present: (InventoryFile & { namedBy: readonly string[] })[] = []
  const missing: { reference: string; reason: ArtifactRefusal; message: string; namedBy: readonly string[] }[] = []
  for (const [reference, namedBy] of named) {
    const checked = checkArtifact(root, reference, { maxBytes: Number.MAX_SAFE_INTEGER })
    if (checked.ok) present.push({ reference, size: checked.artifact.size, namedBy })
    else missing.push({ reference, reason: checked.reason, message: checked.message, namedBy })
  }
  const unreferenced = walked.files.filter((file) => !named.has(file.reference)).map((file) => ({ ...file, partial: file.reference.endsWith(partialSuffix) }))
  const refusedEntries = walked.refused.filter((entry) => !named.has(entry.reference))
  return { present, missing, unreferenced, refused: refusedEntries, truncated: walked.truncated }
}

type Walked = { files: InventoryFile[]; refused: { reference: string; reason: ArtifactRefusal; message: string }[]; truncated: boolean }

function walk(root: string, maxEntries: number): Walked {
  const walked: Walked = { files: [], refused: [], truncated: false }
  let entries = 0
  const visit = (folder: string, prefix: string, depth: number): void => {
    let listed: Dirent[]
    try {
      listed = readdirSync(folder, { withFileTypes: true })
    } catch (error) {
      walked.refused.push({ reference: prefix, reason: 'unreadable', message: `${describe(prefix)} could not be listed: ${errorMessage(error)}` })
      return
    }
    for (const entry of listed.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      if (entries >= maxEntries) {
        walked.truncated = true
        return
      }
      entries += 1
      const reference = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const path = join(folder, entry.name)
      // A link under one of the run's own names is still a link, and is listed as one.
      if (prefix === '' && ((entry.isFile() && runOwnFiles.has(entry.name)) || (entry.isDirectory() && runOwnFolders.has(entry.name)))) continue
      if (entry.isSymbolicLink()) {
        walked.refused.push(linkRefusal(reference, root, path, reference))
      } else if (entry.isDirectory()) {
        if (depth >= maxDepth) walked.truncated = true
        else visit(path, reference, depth + 1)
      } else if (entry.isFile()) {
        walked.files.push(...fileEntry(walked, reference, path))
      } else {
        walked.refused.push(refused(reference, 'not_regular_file', `${describe(reference)} is not a regular file.`))
      }
    }
  }
  visit(root, '', 0)
  return walked
}

// A file with another name somewhere is listed as refused, never as an unreferenced file of the run.
function fileEntry(walked: Walked, reference: string, path: string): InventoryFile[] {
  const stats = lstatIfPresent(path)
  if (stats === undefined) return []
  if (!stats.ok) {
    walked.refused.push(refused(reference, 'unreadable', `${describe(reference)} could not be read: ${stats.problem}`))
    return []
  }
  if (stats.value.nlink > 1n) {
    walked.refused.push(hardLinkRefusal(reference, stats.value.nlink))
    return []
  }
  return [{ reference, size: Number(stats.value.size) }]
}

// Retention --------------------------------------------------------------------------------------------------------

/**
 * What a run keeps. `recordings: 'all'` keeps every recording; `'failures'` keeps only the recordings of attempts that
 * did not pass, and removes those of an attempt that passed once it has finished. Everything else is kept, whatever the
 * rules say, except the `.partial` files lost recordings leave, which go when the run ends unless a record names one.
 */
export type RetentionRules = { readonly recordings: 'all' | 'failures' }

export const defaultRetentionRules: RetentionRules = Object.freeze({ recordings: 'all' })

/**
 * When retention may run. `attempt_finished`: once an attempt's `test.finished` is written and every recording of it
 * has ended or been lost; `status` is that attempt's. `run_finished`: once the media process has closed and every
 * test has finished, before `run.finished` and `result.json` are written. Retention runs at no other moment.
 */
export type RetentionMoment = { readonly kind: 'attempt_finished'; readonly attemptId: string; readonly status: TestStatus } | { readonly kind: 'run_finished' }

/**
 * Why retention removes a file: the recording of an attempt that passed when only failures are kept; a thumbnail of a
 * file it removed; a `.partial` a lost recording left that no record names.
 */
export type RetentionReason = 'passed_attempt_recording' | 'thumbnail_of_removed' | 'lost_recording_partial'

/** Who an artifact belongs to, as its record named it. */
export type ArtifactOwner = { readonly testId?: string; readonly attemptId?: string; readonly app?: string; readonly sessionId?: string }

export type PlannedRemoval = { readonly reference: string; readonly kind: ArtifactKind | 'partial'; readonly reason: RetentionReason; readonly owner: ArtifactOwner }

/** What retention would remove at a moment, and what it considered and kept, with why. */
export type RetentionPlan = {
  readonly moment: RetentionMoment
  readonly removals: readonly PlannedRemoval[]
  readonly kept: readonly { readonly reference: string; readonly why: string }[]
}

/**
 * Decides what to remove at one moment. It only ever removes, inside `artifacts/`: recordings of the finished attempt
 * when it passed and the rules keep only failures, the thumbnails made from them, and, when the run finishes,
 * `.partial` files no record names. A recording an AI check's evidence names, or that another attempt's record or a
 * record of another kind names, is kept. Screenshots, frames, diagnostics, the report, logs and the run's own files
 * are never removed. A file the listing did not find present is not planned.
 *
 * @example planRetention({ moment: { kind: 'attempt_finished', attemptId, status: 'passed' }, rules, references, inventory })
 */
export function planRetention(input: { readonly moment: RetentionMoment; readonly rules: RetentionRules; readonly references: readonly ArtifactReference[]; readonly inventory: ArtifactInventory }): RetentionPlan {
  const { moment, rules, references, inventory } = input
  const present = new Set(inventory.present.map((file) => file.reference))
  if (moment.kind === 'run_finished') {
    const removals: PlannedRemoval[] = inventory.unreferenced
      .filter((file) => file.partial && insideArtifacts(file.reference))
      .map((file) => ({ reference: file.reference, kind: 'partial', reason: 'lost_recording_partial', owner: {} }))
    return { moment, removals, kept: [] }
  }
  if (rules.recordings !== 'failures' || moment.status !== 'passed') return { moment, removals: [], kept: [] }
  const byPath = new Map<string, ArtifactReference[]>()
  for (const reference of references) byPath.set(reference.path, [...(byPath.get(reference.path) ?? []), reference])
  const removals: PlannedRemoval[] = []
  const kept: { reference: string; why: string }[] = []
  const candidates = [...byPath].filter(([, named]) => named.some((reference) => reference.kind === 'recording' && reference.attemptId === moment.attemptId))
  for (const [path, named] of candidates) {
    const why = keepReason(path, named, moment.attemptId, present)
    if (why !== undefined) kept.push({ reference: path, why })
    else removals.push({ reference: path, kind: 'recording', reason: 'passed_attempt_recording', owner: ownerOf(named) })
  }
  const removed = new Set(removals.map((removal) => removal.reference))
  for (const [path, named] of byPath) {
    const thumbnail = named.find((reference) => reference.kind === 'thumbnail' && reference.of !== undefined && removed.has(reference.of))
    if (thumbnail === undefined) continue
    const other = named.find((reference) => reference.kind !== 'thumbnail' || reference.evidenceOf !== undefined || reference.attemptId !== moment.attemptId || reference.of === undefined || !removed.has(reference.of))
    if (other !== undefined) kept.push({ reference: path, why: other.kind === 'thumbnail' ? `${other.namedBy} names it as a thumbnail of attempt ${other.attemptId ?? 'unknown'} or a retained recording` : `${other.namedBy} also names it` })
    else if (!insideArtifacts(path) || !present.has(path)) kept.push({ reference: path, why: present.has(path) ? 'it is not inside artifacts/' : 'it is not present' })
    else removals.push({ reference: path, kind: 'thumbnail', reason: 'thumbnail_of_removed', owner: ownerOf(named) })
  }
  return { moment, removals, kept }
}

function keepReason(path: string, named: readonly ArtifactReference[], attemptId: string, present: ReadonlySet<string>): string | undefined {
  const evaluation = named.find((reference) => reference.evidenceOf === 'evaluation')
  if (evaluation !== undefined) return `an AI check's evidence names it (${evaluation.namedBy})`
  const other = named.find((reference) => reference.kind !== 'recording' || reference.attemptId !== attemptId)
  if (other !== undefined) return `${other.namedBy} names it as ${other.kind === 'recording' ? `a recording of attempt ${other.attemptId ?? 'unknown'}` : `a ${other.kind}`}`
  if (!insideArtifacts(path)) return 'it is not inside artifacts/'
  if (!present.has(path)) return 'it is not present'
  return undefined
}

function insideArtifacts(reference: string): boolean {
  return reference.startsWith(`${artifactsFolder}/`) && referenceProblem(reference) === undefined
}

/**
 * Completion of one removal, written after unlink succeeds. The request is persisted before the file goes.
 * `session` names the app, as on every event about an app.
 */
export type ArtifactRemovedRecord = {
  readonly type: 'artifact.removed'
  readonly path: string
  readonly kind: ArtifactKind | 'partial'
  readonly reason: RetentionReason
  readonly moment: RetentionMoment['kind']
  readonly bytes: number
  readonly testId?: string
  readonly attemptId?: string
  readonly session?: string
  readonly sessionId?: string
}

/**
 * A persisted request to remove a file. A later completion records whether it was removed or refused.
 */
export type ArtifactRemovalRequestedRecord = Omit<ArtifactRemovedRecord, 'type'> & { readonly type: 'artifact.removal_requested' }

export type ArtifactRemovalFailedRecord = Omit<ArtifactRemovedRecord, 'type' | 'bytes'> & { readonly type: 'artifact.removal_failed'; readonly message: string }

/**
 * Synchronous request and completion recording. `removing` returns true only after persisting the request.
 * False or a throw keeps the file. `removed` confirms unlink; `failed` records a refused unlink.
 */
export type RetentionRecorder = { readonly removing: (record: ArtifactRemovalRequestedRecord) => boolean; readonly removed: (record: ArtifactRemovedRecord) => void; readonly failed: (record: ArtifactRemovalFailedRecord) => void }

export type RetentionOutcome = {
  readonly removed: readonly ArtifactRemovedRecord[]
  readonly refused: readonly { readonly reference: string; readonly reason: ArtifactRefusal | 'not_removable' | 'unrecorded'; readonly message: string }[]
}

/**
 * Removes what a plan names, one file at a time, inside the run folder only. Each file is checked as a safe read
 * checks it (no link anywhere in its path, a regular file with one name), its removal is recorded, it is checked again,
 * and only then unlinked. Anything outside `artifacts/`, anything that fails a check, and anything whose record could
 * not be written is kept and listed in `refused`.
 *
 * @example applyRetention(store.directory, plan, { removing: (record) => log.emitPersisted(record), removed: (record) => { log.emit(record) }, failed: (record) => { log.emit(record) } })
 */
export function applyRetention(runFolder: string, plan: RetentionPlan, recorder: RetentionRecorder): RetentionOutcome {
  const removed: ArtifactRemovedRecord[] = []
  const refusedRemovals: { reference: string; reason: ArtifactRefusal | 'not_removable' | 'unrecorded'; message: string }[] = []
  for (const removal of plan.removals) {
    const { reference } = removal
    if (!insideArtifacts(reference) || (removal.kind === 'partial') !== reference.endsWith(partialSuffix)) {
      refusedRemovals.push({ reference, reason: 'not_removable', message: `${describe(reference)} is not a file retention may remove.` })
      continue
    }
    const checked = checkArtifact(runFolder, reference, { maxBytes: Number.MAX_SAFE_INTEGER })
    if (!checked.ok) {
      refusedRemovals.push({ reference, reason: checked.reason, message: checked.message })
      continue
    }
    const record = removedRecord(removal, plan.moment.kind, checked.artifact.size)
    try {
      if (recorder.removing({ ...record, type: 'artifact.removal_requested' }) !== true) {
        refusedRemovals.push({ reference, reason: 'unrecorded', message: `Retest kept ${describe(reference)}: its removal request was not persisted.` })
        continue
      }
    } catch (error) {
      refusedRemovals.push({ reference, reason: 'unrecorded', message: `Retest kept ${describe(reference)}: its removal could not be recorded: ${errorMessage(error)}` })
      continue
    }
    const problem = checked.artifact.remove()
    if (problem !== undefined) {
      const { type: _type, bytes: _bytes, ...kept } = record
      recorder.failed({ ...kept, type: 'artifact.removal_failed', message: problem.message })
      refusedRemovals.push({ reference, reason: problem.reason, message: problem.message })
      continue
    }
    recorder.removed(record)
    removed.push(record)
  }
  return { removed, refused: refusedRemovals }
}

function unlink(path: string, reference: string): ArtifactRefused | undefined {
  try {
    unlinkSync(path)
    return undefined
  } catch (error) {
    return refused(reference, 'unreadable', `Retest could not remove ${describe(reference)}: ${errorMessage(error)}`)
  }
}

function removedRecord(removal: PlannedRemoval, moment: RetentionMoment['kind'], bytes: number): ArtifactRemovedRecord {
  const { testId, attemptId, app, sessionId } = removal.owner
  return {
    type: 'artifact.removed',
    path: removal.reference,
    kind: removal.kind,
    reason: removal.reason,
    moment,
    bytes,
    ...(testId === undefined ? {} : { testId }),
    ...(attemptId === undefined ? {} : { attemptId }),
    ...(app === undefined ? {} : { session: app }),
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}

function ownerOf(named: readonly ArtifactReference[]): ArtifactOwner {
  const [first] = named
  if (first === undefined) return {}
  return owner({ testId: first.testId, attemptId: first.attemptId, app: first.app, sessionId: first.sessionId })
}

// Only the keys a record has; none is made up.
function owner(keys: { testId: string | undefined; attemptId: string | undefined; app: string | undefined; sessionId: string | undefined }): ArtifactOwner {
  return {
    ...(keys.testId === undefined ? {} : { testId: keys.testId }),
    ...(keys.attemptId === undefined ? {} : { attemptId: keys.attemptId }),
    ...(keys.app === undefined ? {} : { app: keys.app }),
    ...(keys.sessionId === undefined ? {} : { sessionId: keys.sessionId }),
  }
}

// Helpers ----------------------------------------------------------------------------------------------------------

type Lstat = { ok: true; value: BigIntStats } | { ok: false; problem: string }

// Nothing at the path is undefined; any other problem is named.
function lstatIfPresent(path: string): Lstat | undefined {
  try {
    return { ok: true, value: lstatSync(path, { bigint: true }) }
  } catch (error) {
    return isMissingFile(error) ? undefined : { ok: false, problem: errorMessage(error) }
  }
}

function realRoot(runFolder: string, reference: string): { ok: true; path: string } | ArtifactRefused {
  try {
    return { ok: true, path: realpathSync.native(runFolder) }
  } catch (error) {
    return refused(reference, isMissingFile(error) ? 'missing' : 'unreadable', `The run folder could not be read: ${errorMessage(error)}`)
  }
}

// The real path of the deepest part of `path` that exists, with the parts that do not yet exist joined after it, so
// a folder about to be made compares with a run folder whose own path passes through a link, as /tmp does on macOS.
function realOrResolved(path: string): string {
  const missing: string[] = []
  let current = resolve(path)
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      missing.push(basename(current))
      current = parent
    }
  }
}

// A link is never followed; where it leads is only read to say whether it leaves the run folder. Its target is not
// quoted, since it can name any file on the machine.
function linkRefusal(reference: string, root: string, path: string, shown: string): ArtifactRefused {
  let target: string | undefined
  try {
    target = resolve(dirname(path), readlinkSync(path))
  } catch {
    target = undefined
  }
  const inside = target !== undefined && (target === root || target.startsWith(`${root}${sep}`))
  if (inside) return refused(reference, 'symbolic_link', `${describe(shown)} is a symbolic link; Retest does not follow links in a run folder.`)
  return refused(reference, 'outside_run_folder', `${describe(shown)} is a symbolic link that leads outside the run folder; Retest does not follow it.`)
}

function hardLinkRefusal(reference: string, names: bigint): ArtifactRefused {
  return refused(reference, 'hard_link', `${describe(reference)} has ${names} names, and another of them may be outside the run folder; Retest reads only a file with one name.`)
}

function tooLarge(reference: string, size: bigint, maxBytes: number): ArtifactRefused {
  return refused(reference, 'too_large', `${describe(reference)} is ${size} bytes, over the limit of ${maxBytes}.`)
}

function fileType(stats: BigIntStats): string {
  if (stats.isDirectory()) return 'a folder'
  if (stats.isFIFO()) return 'a pipe'
  if (stats.isSocket()) return 'a socket'
  if (stats.isCharacterDevice() || stats.isBlockDevice()) return 'a device'
  return 'not a file'
}

function refused(reference: string, reason: ArtifactRefusal, message: string): ArtifactRefused {
  return { ok: false, reference, reason, message }
}

// A reference as a message quotes it: in JSON quotes, and cut short, since a hostile record can make it anything.
function describe(reference: string): string {
  const shown = reference.length > 120 ? `${reference.slice(0, 120)}…` : reference
  return JSON.stringify(shown)
}
