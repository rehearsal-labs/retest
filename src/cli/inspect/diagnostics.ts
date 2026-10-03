import type {
  ConsoleRecord,
  DiagnosticLine,
  DiagnosticsSummary,
  KindScope,
  NetworkFailedRecord,
  NetworkFinishedRecord,
  NetworkPendingRecord,
  NetworkRequestRecord,
  NetworkResponseRecord,
  RuntimeErrorRecord,
} from '../../protocol/diagnostics.ts'
import type { TestResult } from '../../protocol/result.ts'
import type { TestEvent } from '../../reporters/run-record.ts'
import type { Style } from '../../reporters/style.ts'
import { join } from 'node:path'
import { readArtifact } from '../../diagnostics/artifact.ts'
import { describeConsole, describeNetwork } from '../../diagnostics/report.ts'
import { describeLocator } from '../../protocol/locator.ts'
import { formatDuration, printable } from '../../reporters/format.ts'

/** One session's diagnostics as `inspect` read them: its summary, and its artifact's lines or why they are missing. */
export type SessionDiagnostics = { summary: DiagnosticsSummary; lines?: DiagnosticLine[]; problem?: string }

export type DiagnosticsViewOptions = { style: Style; runFolder: string }

const timeWidth = 9
// A terminal shows this many entries of each kind; the artifact and `--json` keep them all.
const shownEntries = 50
const shownRequests = 100
const textWidth = 200

/**
 * Reads each session's artifact from the run folder, as `inspect` shows and prints them.
 *
 * @example readTestDiagnostics('/work/.retest/runs/latest', test)
 */
export function readTestDiagnostics(runFolder: string, test: TestResult): SessionDiagnostics[] {
  return (test.diagnostics ?? []).map((summary) => {
    if (summary.path === undefined) return { summary }
    const reading = readArtifact(runFolder, summary.path)
    return reading.ok ? { summary, lines: reading.lines } : { summary, problem: reading.problem }
  })
}

/**
 * Each session's diagnostics under a test's timeline: its counts and scope, its console entries and runtime errors,
 * and a table of its requests with method, address, status, duration and failure. Each row is at its time since the
 * test started, on the timeline's clock, and names the action that was running then. A time says when something
 * happened, never that an action caused it.
 *
 * @example stdout.write(renderTestDiagnostics(sessions, events, { style, runFolder }))
 */
export function renderTestDiagnostics(sessions: readonly SessionDiagnostics[], events: readonly TestEvent[], options: DiagnosticsViewOptions): string {
  if (sessions.length === 0) return ''
  const clock = timelineClock(events)
  const lines: string[] = []
  for (const session of sessions) lines.push('', ...sessionLines(session, clock, options))
  return `${lines.join('\n')}\n`
}

/** Places a record's time on the timeline: milliseconds since the test's first event, and the action running then. */
type TimelineClock = { at: (time: string) => number | undefined; during: (elapsed: number) => string | undefined }

// The timeline counts from the test's first event; `test.started` ties the parent's wall clock to that count.
function timelineClock(events: readonly TestEvent[]): TimelineClock {
  const start = events[0]?.elapsedMs ?? 0
  const anchor = events.find((event) => event.type === 'test.started') ?? events[0]
  const actions = events.flatMap((event) =>
    event.type === 'action.completed' || event.type === 'action.failed'
      ? [{ from: event.elapsedMs - event.durationMs - start, to: event.elapsedMs - start, label: `${event.command}${event.locator === undefined ? '' : ` ${describeLocator(event.locator)}`}` }]
      : [],
  )
  return {
    at: (time) => {
      if (anchor === undefined) return undefined
      const offset = Date.parse(time) - Date.parse(anchor.time)
      return Number.isNaN(offset) ? undefined : anchor.elapsedMs - start + offset
    },
    during: (elapsed) => actions.find((action) => elapsed >= action.from && elapsed <= action.to)?.label,
  }
}

function sessionLines(session: SessionDiagnostics, clock: TimelineClock, options: DiagnosticsViewOptions): string[] {
  const { style } = options
  const { summary } = session
  const name = summary.app ?? summary.sessionId
  const lines = [`  ${style.bold('Diagnostics')} ${style.cyan(name)}  ${describeConsole(summary.console)} · ${describeNetwork(summary.network)}`]
  if (summary.path !== undefined) lines.push(`  ${style.dim(`artifact ${join(options.runFolder, summary.path)}`)}`)
  if (summary.scope !== undefined) {
    lines.push(`  ${style.dim(`console covers ${describeScope(summary.scope.console)}`)}`, `  ${style.dim(`network covers ${describeScope(summary.scope.network)}`)}`)
  }
  if (session.problem !== undefined) lines.push(`  ${style.yellow(`not shown: ${session.problem}`)}`)
  const records = session.lines ?? []
  const entries = records.filter((line): line is ConsoleRecord | RuntimeErrorRecord => line.type === 'console' || line.type === 'runtime_error')
  if (entries.length > 0) lines.push('', `  ${style.bold('Console')}`, ...entries.slice(0, shownEntries).map((entry) => consoleLine(entry, clock, style)), ...more(entries.length, shownEntries, style))
  const requests = requestRows(records)
  if (requests.length > 0) lines.push('', `  ${style.bold('Requests')}`, ...requests.slice(0, shownRequests).map((row) => requestLine(row, clock, style)), ...more(requests.length, shownRequests, style))
  return lines
}

function consoleLine(entry: ConsoleRecord | RuntimeErrorRecord, clock: TimelineClock, style: Style): string {
  const elapsed = clock.at(entry.time)
  const when = style.dim((elapsed === undefined ? '?' : formatDuration(elapsed)).padStart(timeWidth))
  const level = entry.type === 'runtime_error' ? 'error' : entry.level
  const kind = entry.type === 'runtime_error' ? (entry.kind === 'uncaught' ? 'uncaught' : 'rejection') : entry.consoleType
  const mark = level === 'error' ? style.red(level.padEnd(7)) : level === 'warning' ? style.yellow(level.padEnd(7)) : level.padEnd(7)
  const origin = entry.type === 'console' && entry.origin !== 'page' ? ` ${entry.origin}` : ''
  const text = oneLine(entry.type === 'runtime_error' ? entry.message.text : entry.text.text)
  const place = entry.url === undefined ? '' : `  ${style.dim(`${printable(entry.url)}${entry.line === undefined ? '' : `:${entry.line}`}`)}`
  const during = elapsed === undefined ? undefined : clock.during(elapsed)
  const action = during === undefined ? '' : `  ${style.dim(`during ${during}`)}`
  return `  ${when}  ${mark} ${style.dim(`${entry.id} ${kind}${origin}`)}  ${text}${place}${action}`
}

/** A hop with every record that names it. */
type RequestRow = {
  request: NetworkRequestRecord
  response?: NetworkResponseRecord
  finished?: NetworkFinishedRecord
  failed?: NetworkFailedRecord
  pending?: NetworkPendingRecord
}

function requestRows(lines: readonly DiagnosticLine[]): RequestRow[] {
  const rows = new Map<string, RequestRow>()
  const rowOf = (line: { sessionId: string; requestId: string }): RequestRow | undefined => rows.get(`${line.sessionId} ${line.requestId}`)
  for (const line of lines) {
    if (line.type === 'network.request') {
      rows.set(`${line.sessionId} ${line.requestId}`, { request: line })
      continue
    }
    if (line.type !== 'network.response' && line.type !== 'network.finished' && line.type !== 'network.failed' && line.type !== 'network.pending') continue
    const row = rowOf(line)
    if (row === undefined) continue
    if (line.type === 'network.response') row.response = line
    else if (line.type === 'network.finished') row.finished = line
    else if (line.type === 'network.failed') row.failed = line
    else row.pending = line
  }
  return [...rows.values()]
}

// A response's status is never a failure; a hop that failed in transport has no status, and says why instead. An error
// answer Chrome ended with a failure shows its status, and the failure beside it.
function requestLine(row: RequestRow, clock: TimelineClock, style: Style): string {
  const { request, response, finished, failed, pending } = row
  const elapsed = clock.at(request.time)
  const when = style.dim((elapsed === undefined ? '?' : formatDuration(elapsed)).padStart(timeWidth))
  const answered = response === undefined ? undefined : response.status >= 400 ? style.red(String(response.status)) : String(response.status)
  const status = answered ?? (failed === undefined ? style.yellow('no response') : style.red(failed.canceled === true ? 'cancelled' : 'failed'))
  const redirect = response?.redirectedTo === undefined ? '' : ` → ${response.redirectedTo}`
  const durationMs = finished?.durationMs ?? failed?.durationMs
  const duration = durationMs === undefined ? '' : formatMilliseconds(durationMs)
  const ending = failed !== undefined ? `  ${style.red(failed.reason)}` : pending === undefined ? '' : `  ${style.yellow(describePending(pending))}`
  const worker = response?.serviceWorker === true ? `  ${style.dim('service worker')}` : ''
  const during = elapsed === undefined ? undefined : clock.during(elapsed)
  const action = during === undefined ? '' : `  ${style.dim(`during ${during}`)}`
  return `  ${when}  ${style.dim(request.requestId.padEnd(5))} ${request.method.padEnd(6)} ${status}${redirect}  ${style.dim(duration.padStart(9))}  ${printable(request.url)}${ending}${worker}${action}`
}

// A hop handed outside the scope is not pending: its end is reported where Retest does not listen.
function describePending({ reason, lastState }: NetworkPendingRecord): string {
  return reason === 'out_of_scope' ? `out of scope after it was ${lastState}` : `pending, ${lastState}, ${reason.replaceAll('_', ' ')}`
}

function describeScope(scope: KindScope): string {
  const words = (areas: readonly string[]): string => areas.map((area) => area.replaceAll('_', ' ')).join(', ')
  return `${words(scope.covered) || 'nothing'}; not ${words(scope.notCovered) || 'anything else'}`
}

function oneLine(text: string): string {
  const flat = printable(text.replace(/\s*\n\s*/g, ' ⏎ '))
  return flat.length > textWidth ? `${flat.slice(0, textWidth)}…` : flat
}

function formatMilliseconds(milliseconds: number): string {
  return milliseconds < 10 ? `${milliseconds.toFixed(1)} ms` : formatDuration(milliseconds)
}

function more(total: number, shown: number, style: Style): string[] {
  return total > shown ? [`  ${style.dim(`and ${total - shown} more in the artifact`)}`] : []
}
