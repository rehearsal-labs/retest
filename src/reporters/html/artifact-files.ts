import type { DiagnosticLine } from '../../protocol/diagnostics.ts'
import type { ArtifactRefusal } from '../../store/artifacts.ts'
import type { Markup } from './markup.ts'
import { readSync } from 'node:fs'
import { parseArtifact } from '../../diagnostics/artifact.ts'
import { errorMessage } from '../../protocol/failures.ts'
import { checkArtifact, readArtifactFile } from '../../store/artifacts.ts'
import { artifactLink, html } from './markup.ts'

/**
 * Why a file the records name is not shown: a refusal of the safe read by its name (missing, a link, outside the run
 * folder and the rest), `not_an_image` for a picture whose first bytes are not a PNG or a JPEG, `not_a_video` for a
 * video whose first bytes are not an MP4 or a WebM, or `not_readable` for an artifact whose lines are not what its kind
 * holds. `message` is a sentence a reader can act on.
 */
export type FileProblem = { ok: false; reference: string; reason: ArtifactRefusal | 'not_an_image' | 'not_a_video' | 'not_readable'; message: string }

/** A picture the report can show: its link, its size when its header says it, and its kind. */
export type PictureFile = { ok: true; link: Markup; kind: 'png' | 'jpeg'; width?: number; height?: number } | FileProblem

/** A video the report can show: its link and its container, as its first bytes say. */
export type VideoFile = { ok: true; link: Markup; container: 'mp4' | 'webm' } | FileProblem

/** The exact saved JSON supplied as evaluation diagnostics, with its safe artifact link. */
export type EvaluationDiagnosticsFile = { ok: true; text: string; link: Markup } | FileProblem

/** A session diagnostics artifact's lines, each checked against its schema, with its safe artifact link. */
export type DiagnosticsFile = { ok: true; lines: DiagnosticLine[]; link: Markup } | FileProblem

/**
 * A problem in a few words: the reference its record gave and the refusal by name. The store's sentence about it is
 * shown where the file would have been.
 *
 * @example describeProblem({ ok: false, reference: 'artifacts/a.png', reason: 'missing', message: '…' }) // 'artifacts/a.png (missing)'
 */
export function describeProblem(problem: FileProblem): string {
  return `${problem.reference} (${reasonWords(problem)})`
}

/** @example reasonWords({ reason: 'outside_run_folder' }) // 'outside run folder' */
export function reasonWords(problem: Pick<FileProblem, 'reason'>): string {
  return problem.reason.replaceAll('_', ' ')
}

// Larger than any screenshot, frame or diagnostics artifact a run writes, so a file over these is not one.
const maxPictureBytes = 64 * 1024 * 1024
const maxDiagnosticsBytes = 64 * 1024 * 1024
// A recording is bounded by its run's length, not by a picture's size; this only refuses what no run could write.
const maxVideoBytes = 16 * 1024 * 1024 * 1024

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const webmSignature = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])
// A PNG's signature and its IHDR chunk, which holds the size, end at byte 24; a JPEG says what it is in three, an MP4
// in its first box's type at bytes 4 to 8, a WebM in its EBML signature.
const headerBytes = 24

/**
 * The run folder's files as the report reads them: each by its portable reference, through the store's safe read, once.
 * A picture or a video is checked for what its first bytes say it is, so a link never points at something that is not
 * one; only those bytes are read, from the descriptor the safe read opened, since the browser loads the file itself.
 */
export class ArtifactFiles {
  readonly #directory: string
  readonly #pictures = new Map<string, PictureFile>()
  readonly #diagnostics = new Map<string, DiagnosticsFile>()
  readonly #videos = new Map<string, VideoFile>()

  constructor(directory: string) {
    this.#directory = directory
  }

  /** A screenshot or a frame by its reference. */
  picture(reference: string): PictureFile {
    const known = this.#pictures.get(reference)
    if (known !== undefined) return known
    const read = this.#picture(reference)
    this.#pictures.set(reference, read)
    return read
  }

  /** A recording's video by its reference. */
  video(reference: string): VideoFile {
    const known = this.#videos.get(reference)
    if (known !== undefined) return known
    const read = this.#video(reference)
    this.#videos.set(reference, read)
    return read
  }

  /** A diagnostics artifact by its reference. */
  diagnostics(reference: string): DiagnosticsFile {
    const known = this.#diagnostics.get(reference)
    if (known !== undefined) return known
    const read = this.#readDiagnostics(reference)
    this.#diagnostics.set(reference, read)
    return read
  }

  /** The exact bounded JSON text sent to a judge, separate from a session's JSONL capture. */
  evaluationDiagnostics(reference: string): EvaluationDiagnosticsFile {
    if (!reference.startsWith('artifacts/') && !reference.startsWith('diagnostics/')) return { ok: false, reference, reason: 'invalid_reference', message: 'The reference is not an approved diagnostics artifact path.' }
    const read = readArtifactFile(this.#directory, reference, { maxBytes: maxDiagnosticsBytes })
    if (!read.ok) return { ok: false, reference, reason: read.reason, message: read.message }
    const text = read.bytes.toString('utf8')
    try { JSON.parse(text) } catch { return { ok: false, reference, reason: 'not_readable', message: 'The diagnostics evidence is not JSON.' } }
    const link = artifactLink(reference)
    if (link === undefined) return { ok: false, reference, reason: 'invalid_reference', message: 'The reference is not inside the run folder.' }
    return { ok: true, text, link }
  }

  #picture(reference: string): PictureFile {
    const header = this.#header(reference, maxPictureBytes)
    if (!header.ok) return header
    const { link, bytes, length } = header
    if (length >= 24 && bytes.subarray(0, 8).equals(pngSignature) && bytes.toString('latin1', 12, 16) === 'IHDR') {
      return { ok: true, link, kind: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    }
    if (length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ok: true, link, kind: 'jpeg' }
    return { ok: false, reference, reason: 'not_an_image', message: 'The file is not a PNG or JPEG image.' }
  }

  #video(reference: string): VideoFile {
    const header = this.#header(reference, maxVideoBytes)
    if (!header.ok) return header
    const { link, bytes, length } = header
    if (length >= 8 && bytes.toString('latin1', 4, 8) === 'ftyp') return { ok: true, link, container: 'mp4' }
    if (length >= 4 && bytes.subarray(0, 4).equals(webmSignature)) return { ok: true, link, container: 'webm' }
    return { ok: false, reference, reason: 'not_a_video', message: 'The file is not an MP4 or WebM video.' }
  }

  // The first bytes of a file, through the safe read, and its link; the browser loads the file itself.
  #header(reference: string, maxBytes: number): { ok: true; link: Markup; bytes: Buffer; length: number } | FileProblem {
    const checked = checkArtifact(this.#directory, reference, { maxBytes })
    if (!checked.ok) return { ok: false, reference, reason: checked.reason, message: checked.message }
    const link = artifactLink(reference)
    if (link === undefined) return { ok: false, reference, reason: 'invalid_reference', message: 'The reference is not a path inside the run folder.' }
    const opened = checked.artifact.open()
    if (!opened.ok) return { ok: false, reference, reason: opened.reason, message: opened.message }
    const bytes = Buffer.alloc(headerBytes)
    try {
      return { ok: true, link, bytes, length: readSync(opened.file.descriptor, bytes, 0, headerBytes, 0) }
    } catch (error) {
      return { ok: false, reference, reason: 'unreadable', message: `The file could not be read: ${errorMessage(error)}` }
    } finally {
      opened.file.close()
    }
  }

  #readDiagnostics(reference: string): DiagnosticsFile {
    if (!reference.startsWith('diagnostics/')) return { ok: false, reference, reason: 'invalid_reference', message: 'The reference is not an approved diagnostics artifact path.' }
    const read = readArtifactFile(this.#directory, reference, { maxBytes: maxDiagnosticsBytes })
    if (!read.ok) return { ok: false, reference, reason: read.reason, message: read.message }
    const parsed = parseArtifact(read.bytes.toString('utf8'), reference)
    const link = artifactLink(reference)
    if (link === undefined) return { ok: false, reference, reason: 'invalid_reference', message: 'The reference is not a path inside the run folder.' }
    return parsed.ok ? { ok: true, lines: parsed.lines, link } : { ok: false, reference, reason: 'not_readable', message: `${parsed.problem}.` }
  }
}

/**
 * The frame that stands where a file would have been: what it is, the reference its record gave, and the refusal by
 * name, marked so a reader of the file can find each one; then the store's sentence about it.
 *
 * @example missingFileView('Failure screenshot of web', problem)
 */
export function missingFileView(subject: string, problem: FileProblem): Markup {
  return html`<div class="gap" data-reference="${problem.reference}" data-refusal="${problem.reason}"><strong>${subject} cannot be shown</strong> (${reasonWords(problem)}) <code class="words">${problem.reference}</code> <span class="words">${problem.message}</span></div>`
}
