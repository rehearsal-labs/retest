import { s, type Schema } from './schema.ts'

const failureClasses = [
  'check_failed',
  'host_check_failed',
  'not_found',
  'ambiguous',
  'not_actionable',
  'timeout',
  'session_lost',
  'outcome_unknown',
  'setup_failed',
  'cleanup_failed',
  'collection_failed',
  'test_error',
  'no_assertions',
  'not_awaited',
  'concurrent_commands',
  'unsupported',
  'usage',
  'interrupted',
  'reporting_failed',
  'evaluation_failed',
  'evaluation_inconclusive',
  'evaluation_error',
  'evidence_incomplete',
] as const

export type FailureClass = (typeof failureClasses)[number]

/** A position in a test file. `file` is POSIX and relative to the run's root directory. */
export type SourceLocation = { file: string; line: number; column: number }

/** Text cut to a limit. `length` is the length before cutting. */
export type TruncatedText = { text: string; truncated: boolean; length: number }

export type FailureDetail = string | number | boolean | null | TruncatedText

export type Failure = {
  class: FailureClass
  message: string
  location?: SourceLocation
  details?: Record<string, FailureDetail>
}

export const sourceLocationSchema: Schema<SourceLocation> = s.object({
  file: s.string(),
  line: s.number({ integer: true, min: 1 }),
  column: s.number({ integer: true, min: 1 }),
})

export const truncatedTextSchema: Schema<TruncatedText> = s.object({
  text: s.string(),
  truncated: s.boolean(),
  length: s.number({ integer: true, min: 0 }),
})

export const failureSchema: Schema<Failure> = s.object({
  class: s.enum(failureClasses),
  message: s.string(),
  location: s.optional(sourceLocationSchema),
  details: s.optional(s.record(s.union([s.string(), s.number(), s.boolean(), s.literal(null), truncatedTextSchema]))),
})

/** A failure with a location, when there is one to add. */
export function failure(kind: FailureClass, message: string, location?: SourceLocation): Failure {
  return location === undefined ? { class: kind, message } : { class: kind, message, location }
}

/** Keeps a failure's own location and falls back to the given one. */
export function withLocation(original: Failure, location: SourceLocation | undefined): Failure {
  return original.location !== undefined || location === undefined ? original : { ...original, location }
}

/**
 * Keeps the first failure and lists the ones after it in `details.also`, so a later failure never
 * replaces an earlier one. Repeats of the first are dropped.
 *
 * @example withAlso(checkFailed, [timedOut]).details?.also // 'timeout: The test ran longer than its 3000 ms budget.'
 */
export function withAlso(first: Failure, others: readonly Failure[]): Failure {
  const extra = others.filter((other) => other.class !== first.class || other.message !== first.message)
  if (extra.length === 0) return first
  const also = extra.map((other) => `${other.class}: ${other.message}`).join('\n')
  return { ...first, details: { ...first.details, also } }
}

/** The message of anything thrown. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Cuts text to at most `limit` UTF-16 code units, never inside a surrogate pair.
 *
 * @example truncateText('Release checklist', 7) // { text: 'Release', truncated: true, length: 17 }
 */
export function truncateText(value: string, limit = 4096): TruncatedText {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError(`The limit must be a whole number from 0, received ${limit}.`)
  }
  if (value.length <= limit) return { text: value, truncated: false, length: value.length }
  const end = isHighSurrogate(value.charCodeAt(limit - 1)) ? limit - 1 : limit
  return { text: value.slice(0, end), truncated: true, length: value.length }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}
