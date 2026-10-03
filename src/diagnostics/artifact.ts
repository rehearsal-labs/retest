import type { TruncatedText } from '../protocol/failures.ts'
import type { CaptureFinishedLine, CaptureStartedLine, DiagnosticLine, DiagnosticRecord } from '../protocol/diagnostics.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { diagnosticLineSchema } from '../protocol/diagnostics.ts'
import { errorMessage } from '../protocol/failures.ts'
import { parse } from '../protocol/schema.ts'

/**
 * A session's artifact as JSON lines: its start marker, its records in the order they arrived, its end marker.
 *
 * @example artifactText(started, records, finished)
 */
export function artifactText(started: CaptureStartedLine, records: readonly DiagnosticRecord[], finished: CaptureFinishedLine): string {
  return [started, ...records, finished].map((line) => `${JSON.stringify(line)}\n`).join('')
}

/** An artifact as `inspect` reads it: its lines, or why it could not be read. */
export type ArtifactReading = { ok: true; lines: DiagnosticLine[] } | { ok: false; problem: string }

/**
 * Reads a diagnostics artifact from a run folder, every line checked against its schema.
 *
 * @example readArtifact('/work/.retest/runs/latest', 'diagnostics/saves-a-task-k3v9q0x2mb.jsonl')
 */
export function readArtifact(runFolder: string, path: string): ArtifactReading {
  let text: string
  try {
    text = readFileSync(join(runFolder, path), 'utf8')
  } catch (error) {
    return { ok: false, problem: `${path} could not be read: ${errorMessage(error)}` }
  }
  return parseArtifact(text, path)
}

/**
 * The lines of an artifact's text, each checked against its schema.
 *
 * @example parseArtifact(text, 'diagnostics/a.jsonl')
 */
export function parseArtifact(text: string, path: string): ArtifactReading {
  const lines: DiagnosticLine[] = []
  for (const [index, line] of text.split('\n').entries()) {
    if (line === '') continue
    let json: unknown
    try {
      json = JSON.parse(line)
    } catch {
      return { ok: false, problem: `${path} line ${index + 1} is not JSON` }
    }
    const parsed = parse(diagnosticLineSchema, json)
    if (!parsed.ok) return { ok: false, problem: `${path} line ${index + 1} is not a diagnostics line: ${parsed.issues.slice(0, 2).map((issue) => `${issue.path} ${issue.message}`).join('; ')}` }
    lines.push(parsed.value)
  }
  return { ok: true, lines }
}

/**
 * A record with every text that came from the page passed through `rewrite`: messages, addresses, stack frames and
 * status text. Identifiers Retest made itself are left as they are.
 *
 * @example mapRecordText(record, (text) => redactor.redact(text))
 */
export function mapRecordText(record: DiagnosticRecord, rewrite: (text: string) => string): DiagnosticRecord {
  const truncated = (value: TruncatedText): TruncatedText => ({ ...value, text: rewrite(value.text) })
  const place = (url: string | undefined): { url?: string } => (url === undefined ? {} : { url: rewrite(url) })
  switch (record.type) {
    case 'console':
      return { ...record, ...place(record.url), text: truncated(record.text) }
    case 'runtime_error':
      return {
        ...record,
        ...place(record.url),
        message: truncated(record.message),
        stack: record.stack.map((frame) => ({ ...frame, ...place(frame.url), ...(frame.function === undefined ? {} : { function: rewrite(frame.function) }) })),
      }
    case 'network.request':
      return { ...record, url: rewrite(record.url) }
    case 'network.response':
      return record.statusText === undefined ? record : { ...record, statusText: rewrite(record.statusText) }
    case 'network.failed':
      return { ...record, reason: rewrite(record.reason) }
    case 'network.finished':
    case 'network.pending':
      return record
  }
}

// The markers hold only what Retest wrote; each record's page text is rewritten.
function mapLineText(line: DiagnosticLine, rewrite: (text: string) => string): DiagnosticLine {
  if (line.type === 'capture.started' || line.type === 'capture.finished') return line
  return mapRecordText(line, rewrite)
}

/**
 * An artifact's text with every page text redacted again, for a run that learned a value after the artifact was
 * written. A line that cannot be read is left as it is.
 *
 * @example redactArtifactText(text, (text) => redactor.redact(text))
 */
export function redactArtifactText(text: string, redact: (text: string) => string): string {
  return text
    .split('\n')
    .map((line) => {
      if (line === '') return line
      let json: unknown
      try {
        json = JSON.parse(line)
      } catch {
        return line
      }
      const parsed = parse(diagnosticLineSchema, json)
      return parsed.ok ? JSON.stringify(mapLineText(parsed.value, redact)) : line
    })
    .join('\n')
}
