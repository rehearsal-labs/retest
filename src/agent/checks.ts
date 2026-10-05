import type { OwnedPage } from '../browser/contract.ts'
import type { Failure } from '../protocol/failures.ts'
import type { HostCheck, HostCheckActual, HostCheckRecord, TextQuery } from '../protocol/host-check.ts'
import type { Requirement, RunJudges } from '../runner/fingerprint.ts'
import { elapsedMs, monotonicClock } from '../protocol/deadline.ts'
import { failure } from '../protocol/failures.ts'
import { hostCheckProblems, hostCheckRecord } from '../protocol/host-check.ts'
import { Requirements } from '../runner/fingerprint.ts'
import { decideHostCheck } from '../runner/run-host-checks.ts'

// A host's required check, run by an agent session against its own page through the runner's own host check, with the
// identity the runner gives the same check in a test attempt. The identity is the requirement's version, the check's id and the SHA-256 of what decides
// the check, through the runner's own `Requirements`, so it is the same in every session and every attempt, and the
// same as a test's: which session ran it, and when, is recorded beside it and never inside it.

/** A required check's identity: the requirement version, the check's id, its kind and the SHA-256 of its content. */
export type CheckIdentity = { readonly version: string; readonly id: string; readonly kind: 'page'; readonly sha256: string }

/** A check's identity, or why it has none. */
export type IdentifiedCheck = { readonly ok: true; readonly identity: CheckIdentity } | { readonly ok: false; readonly failure: Failure }

/**
 * What a check saw and decided: passed, or failed with the failure that says why, which for a page that could not be
 * read is the loss, never the application's fault. `actual` is the last look's page, redacted.
 */
export type CheckOutcome = {
  readonly status: 'passed' | 'failed'
  readonly failure?: Failure
  readonly actual: HostCheckActual
  readonly attempts: number
  readonly timeoutMs: number
  readonly durationMs: number
}

// No AI check runs in an agent session, so no judge enters a check's content.
const noJudges: RunJudges = { byName: new Map(), defaultJudge: undefined }

/**
 * A required check's identity as the runner computes it for a test held to `requirement`: the check needs an id, may
 * name no other app than the session's, may hold no value of a secret, and under a frozen requirement must be one of
 * its checks with the same content. Every string is redacted before it is hashed, as the runner does.
 *
 * @example checkIdentity({ kind: 'text', id: 'made-by', text: 'Made by owner-a' }, { version: 'v1' }, 'member', redactor)
 */
export function checkIdentity(check: HostCheck, requirement: Requirement, app: string, secrets: { redact(text: string): string; holdsValue(text: string, exact: boolean): boolean }): IdentifiedCheck {
  const shape = hostCheckProblems({ [app]: [check] })
  if (shape.length > 0) return refused(`The check is not one Retest can run: ${shape.join('; ')}.`)
  const { id } = check
  if (id === undefined) return refused('A required check needs an id, which names it within its requirement and keeps it the same check in every session.')
  if (check.app !== undefined && check.app !== app) return refused(`The check ${JSON.stringify(id)} reads the page of ${JSON.stringify(check.app)}, and this session is ${JSON.stringify(app)}. Run it on that app's session.`)
  if (checkTexts(check).some((text) => secrets.holdsValue(text, false))) return refused(`The check ${JSON.stringify(id)} holds the value of a secret, and Retest never fingerprints a secret. Take the value out of the check.`)
  const requirements = new Requirements(requirement, (text) => secrets.redact(text))
  if (requirements.shapeProblem !== undefined) return { ok: false, failure: requirements.shapeProblem }
  const record = requirements.forTest([{ check, app }], [], noJudges)
  const [identified] = record?.checks ?? []
  if (record === undefined || identified === undefined || identified.kind !== 'page') return refused(`Retest could not identify the check ${JSON.stringify(id)}.`)
  const frozen = requirement.checks
  if (frozen !== undefined) {
    const held = Object.hasOwn(frozen, id) ? frozen[id] : undefined
    const named = `the requirement ${JSON.stringify(record.version)}`
    if (held === undefined) return refused(`${JSON.stringify(id)} is not in ${named}. A new check needs a new version.`)
    if (held !== identified.sha256) return refused(`${JSON.stringify(id)} changed since ${named} froze it: its content hashes to ${identified.sha256}, the requirement holds ${held}. A changed check needs a new version.`)
  }
  return { ok: true, identity: { version: record.version, id: identified.id, kind: 'page', sha256: identified.sha256 } }
}

/**
 * Runs a check against a page with the runner's own host check, `decideHostCheck`, so a check decides one way in a test
 * and in a session: it looks again until the check passes or `timeoutMs` runs out, waits for any document the page is
 * opening, reads the page only, and stops on a page that cannot be read or a browser that has gone. `stopped` settles
 * when the session stops, and `stopReason` says why from then on, undefined before.
 *
 * @example await runPageCheck(page, check, { app: 'member', timeoutMs: 5000, redact, connected, stopped, stopReason })
 */
export async function runPageCheck(page: OwnedPage, check: HostCheck, options: { app: string; timeoutMs: number; redact: (text: string) => string; connected: () => boolean; stopped: Promise<unknown>; stopReason: () => Failure | undefined }): Promise<CheckOutcome> {
  const { app, timeoutMs, redact, connected, stopped, stopReason } = options
  const startedAt = monotonicClock()
  const read = { readPage: (queries: readonly TextQuery[], readMs: number) => page.readPage(queries, readMs), connected }
  const decided = await decideHostCheck({ check, app, page: read, timeoutMs, stopped, interruption: stopReason, redact })
  if (decided.kind === 'stopped') return { status: 'failed', failure: decided.failure, actual: {}, attempts: 0, timeoutMs, durationMs: elapsedMs(startedAt) }
  const failed = decided.failure === undefined ? {} : { failure: decided.failure }
  return { status: decided.status, ...failed, actual: redactedActual(decided.actual, redact), attempts: decided.attempts, timeoutMs: decided.timeoutMs, durationMs: decided.durationMs }
}

/**
 * A check as an agent's result records it, its text redacted.
 *
 * @example recordedCheck({ kind: 'text', id: 'made-by', text: 'Made by owner-a' }, redact).kind // 'text'
 */
export function recordedCheck(check: HostCheck, redact: (text: string) => string): HostCheckRecord {
  const record = hostCheckRecord(check)
  const name = record.name === undefined ? {} : { name: redact(record.name) }
  if (record.kind === 'text') return { ...record, ...name, text: redact(record.text) }
  return { ...record, ...name, origin: redact(record.origin) }
}

function checkTexts(check: HostCheck): string[] {
  const name = check.name === undefined ? [] : [check.name]
  if (check.kind === 'text') return [check.text, ...name]
  const path = check.path === undefined ? [] : [typeof check.path === 'string' ? check.path : check.path.source]
  return [check.origin, ...path, ...name]
}

function refused(message: string): IdentifiedCheck {
  return { ok: false, failure: failure('usage', message) }
}

// What the last look saw, with the page's address and title redacted, since an agent's answer leaves the host.
function redactedActual(actual: HostCheckActual, redact: (text: string) => string): HostCheckActual {
  const url = actual.url === undefined ? {} : { url: redact(actual.url) }
  const title = actual.title === undefined ? {} : { title: redact(actual.title) }
  return { ...actual, ...url, ...title }
}
