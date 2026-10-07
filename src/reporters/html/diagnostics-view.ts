import type {
  ConsoleCapture,
  ConsoleRecord,
  DiagnosticLine,
  DiagnosticsSummary,
  KindScope,
  NetworkCapture,
  NetworkFailedRecord,
  NetworkFinishedRecord,
  NetworkPendingRecord,
  NetworkRequestRecord,
  NetworkResponseRecord,
  RuntimeErrorRecord,
} from '../../protocol/diagnostics.ts'
import type { TestEvent } from '../run-record.ts'
import type { ArtifactFiles } from './artifact-files.ts'
import type { DiagnosticsFile } from './artifact-files.ts'
import type { Markup } from './markup.ts'
import { describeConsole, describeNetwork } from '../../diagnostics/report.ts'
import { describeLocator } from '../../protocol/locator.ts'
import { formatDuration } from '../format.ts'
import { missingFileView } from './artifact-files.ts'
import { html } from './markup.ts'

// The report shows this many records of each kind for a session; the artifact, linked beside them, keeps them all.
const shownEntries = 200
const shownRequests = 300
// A record's text is cut to the run's limit when it is written; the report shows this much of what was kept.
const shownText = 2000

/**
 * Each session's console and network capture under a test: what each kind holds and its state, what it covers, the
 * artifact, then its console entries and runtime errors, and its requests with method, status, time and how each
 * ended. A kind that is partial says what it lost above its records; one that is unavailable or turned off says so
 * where its records would be. Each row is at its time since the test's first event, and names the action running
 * then; a time says when something happened, never that the action caused it. Every text came from the page.
 *
 * @example diagnosticsView(test.diagnostics ?? [], record.events, files)
 */
export function diagnosticsView(summaries: readonly DiagnosticsSummary[], events: readonly TestEvent[], files: ArtifactFiles): Markup | undefined {
  if (summaries.length === 0) return undefined
  const clock = timelineClock(events)
  return html`${summaries.map((summary) => sessionView(summary, clock, files))}`
}

/** Places a record's time on the test's timeline, and names the action running then. */
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

function sessionView(summary: DiagnosticsSummary, clock: TimelineClock, files: ArtifactFiles): Markup {
  const name = summary.app ?? summary.sessionId
  const consoleName = summary.scope?.source === 'owned_app' ? 'app log' : 'console'
  const heading = html`<h4>${name}: ${describeConsole(summary.console, consoleName)} · ${describeNetwork(summary.network)}</h4>`
  const scope = summary.scope === undefined ? undefined : html`<p class="muted small words">${consoleName} covers ${describeScope(summary.scope.console)}; network covers ${describeScope(summary.scope.network)}${summary.scope.reason === undefined ? '' : `. ${summary.scope.reason}`}</p>`
  const file = summary.path === undefined ? undefined : files.diagnostics(summary.path)
  const artifact = artifactLine(summary, file)
  const lines = file?.ok === true ? file.lines : []
  const unreadable = file?.ok === false ? missingFileView('The records', file) : undefined
  const readable = file?.ok === true
  return html`<section class="part">${heading}${scope}${artifact}${unreadable}${consoleView(summary.console, consoleName, lines, readable, clock)}${networkView(summary.network, lines, readable, clock)}</section>`
}

function artifactLine(summary: DiagnosticsSummary, file: DiagnosticsFile | undefined): Markup {
  if (summary.path === undefined) return html`<p class="muted small">No artifact was written for this session.</p>`
  const href = file?.ok === true ? file.link : undefined
  const link = href === undefined ? html`<code class="words">${summary.path}</code>` : html`<a href="${href}"><code class="words">${summary.path}</code></a>`
  return html`<p class="small">Artifact ${link}</p>`
}

function consoleView(capture: ConsoleCapture, name: string, lines: readonly DiagnosticLine[], readable: boolean, clock: TimelineClock): Markup | undefined {
  const missing = captureGap(capture, name)
  if (missing !== undefined) return missing
  const entries = lines.filter((line): line is ConsoleRecord | RuntimeErrorRecord => line.type === 'console' || line.type === 'runtime_error')
  const lost = partialNote(capture, name)
  if (!readable) return lost
  if (entries.length === 0) return html`${lost}<p class="muted small">The page wrote nothing to the ${name} and threw no uncaught error.</p>`
  const rows = entries.slice(0, shownEntries).map((entry) => consoleRow(entry, clock))
  return html`${lost}<div class="table-wrap"><table><caption class="muted small">${name}</caption><thead><tr><th scope="col">Time</th><th scope="col">Level</th><th scope="col">Kind</th><th scope="col">Text</th><th scope="col">Where</th></tr></thead><tbody>${rows}</tbody></table></div>${more(entries.length, shownEntries)}`
}

function consoleRow(entry: ConsoleRecord | RuntimeErrorRecord, clock: TimelineClock): Markup {
  const elapsed = clock.at(entry.time)
  const level = entry.type === 'runtime_error' ? 'error' : entry.level
  const kind = entry.type === 'runtime_error' ? (entry.kind === 'uncaught' ? 'uncaught' : 'rejection') : `${entry.consoleType}${entry.origin === 'page' ? '' : `, ${entry.origin}`}`
  const levelClass = level === 'error' ? 'status-failed' : level === 'warning' ? 'status-error' : 'muted'
  const text = entry.type === 'runtime_error' ? entry.message : entry.text
  const shown = text.text.length > shownText ? `${text.text.slice(0, shownText)}…` : text.text
  const cut = text.truncated || text.text.length > shownText ? html`<div class="muted small">shows ${Math.min(text.text.length, shownText)} of ${text.length} characters</div>` : undefined
  const place = entry.url === undefined ? '' : `${entry.url}${entry.line === undefined ? '' : `:${entry.line}`}`
  const during = elapsed === undefined ? undefined : clock.during(elapsed)
  const action = during === undefined ? undefined : html`<div class="muted small words">during ${during}</div>`
  return html`<tr><td class="time">${elapsed === undefined ? '?' : formatDuration(elapsed)}</td><td class="${levelClass}">${level}</td><td class="muted">${entry.id} ${kind}</td><td><pre class="words">${shown}</pre>${cut}${action}</td><td class="words muted">${place}</td></tr>`
}

/** A hop with every record that names it. */
type RequestRow = {
  request: NetworkRequestRecord
  response?: NetworkResponseRecord
  finished?: NetworkFinishedRecord
  failed?: NetworkFailedRecord
  pending?: NetworkPendingRecord
}

function networkView(capture: NetworkCapture, lines: readonly DiagnosticLine[], readable: boolean, clock: TimelineClock): Markup | undefined {
  const missing = captureGap(capture, 'network')
  if (missing !== undefined) return missing
  const lost = partialNote(capture, 'network')
  if (!readable) return lost
  const requests = requestRows(lines)
  if (requests.length === 0) return html`${lost}<p class="muted small">The page made no requests in the capture's scope.</p>`
  const rows = requests.slice(0, shownRequests).map((request) => requestRow(request, clock))
  return html`${lost}<div class="table-wrap"><table><caption class="muted small">network</caption><thead><tr><th scope="col">Time</th><th scope="col">Id</th><th scope="col">Method</th><th scope="col">Status</th><th scope="col">Took</th><th scope="col">Address</th></tr></thead><tbody>${rows}</tbody></table></div>${more(requests.length, shownRequests)}`
}

function requestRows(lines: readonly DiagnosticLine[]): RequestRow[] {
  const rows = new Map<string, RequestRow>()
  for (const line of lines) {
    if (line.type === 'network.request') {
      rows.set(`${line.sessionId} ${line.requestId}`, { request: line })
      continue
    }
    if (line.type !== 'network.response' && line.type !== 'network.finished' && line.type !== 'network.failed' && line.type !== 'network.pending') continue
    const row = rows.get(`${line.sessionId} ${line.requestId}`)
    if (row === undefined) continue
    if (line.type === 'network.response') row.response = line
    else if (line.type === 'network.finished') row.finished = line
    else if (line.type === 'network.failed') row.failed = line
    else row.pending = line
  }
  return [...rows.values()]
}

// A response's status is never a failure; a hop that failed in transport has no status and says why instead. An error
// answer that also ended with a failure shows both.
function requestRow(row: RequestRow, clock: TimelineClock): Markup {
  const { request, response, finished, failed, pending } = row
  const elapsed = clock.at(request.time)
  const status = response === undefined
    ? failed === undefined ? html`<span class="status-error">no response</span>` : html`<span class="status-failed">${failed.canceled === true ? 'cancelled' : 'failed'}</span>`
    : html`<span class="${response.status >= 400 ? 'status-failed' : ''}">${response.status}</span>`
  const durationMs = finished?.durationMs ?? failed?.durationMs
  const endings = [
    ...(response?.redirectedTo === undefined ? [] : [`redirected to ${response.redirectedTo}`]),
    ...(failed === undefined ? [] : [failed.blocked === undefined ? failed.reason : `${failed.reason}, blocked: ${failed.blocked}`]),
    ...(pending === undefined ? [] : [describePending(pending)]),
    ...(response?.serviceWorker === true ? ['answered by a service worker'] : []),
  ]
  const during = elapsed === undefined ? undefined : clock.during(elapsed)
  const under = [...endings, ...(during === undefined ? [] : [`during ${during}`])].map((line) => html`<div class="muted small words">${line}</div>`)
  return html`<tr><td class="time">${elapsed === undefined ? '?' : formatDuration(elapsed)}</td><td class="muted">${request.requestId}</td><td>${request.method}</td><td>${status}</td><td class="number">${durationMs === undefined ? '' : formatMilliseconds(durationMs)}</td><td><span class="words">${request.url}</span>${under}</td></tr>`
}

// A hop handed outside the scope is not pending: its end is reported where Retest does not listen.
function describePending({ reason, lastState }: NetworkPendingRecord): string {
  return reason === 'out_of_scope' ? `out of scope after it was ${lastState}` : `pending, ${lastState}, ${reason.replaceAll('_', ' ')}`
}

// Where a kind's records would be, a kind with none to show says why: it captured nothing, or the run turned it off.
function captureGap(capture: ConsoleCapture | NetworkCapture, name: string): Markup | undefined {
  if (capture.state === 'unavailable') return html`<div class="gap"><strong>No ${name} records.</strong> The capture is unavailable: ${capture.reason}</div>`
  if (capture.state === 'disabled') return html`<div class="gap"><strong>No ${name} records.</strong> This run turned capture off.</div>`
  return undefined
}

function partialNote(capture: ConsoleCapture | NetworkCapture, name: string): Markup | undefined {
  if (capture.state !== 'partial') return undefined
  const lost = [`${capture.dropped} dropped`, `${capture.truncated} cut`].filter((part) => !part.startsWith('0 ')).join(', ')
  return html`<div class="gap"><strong>The ${name} capture is partial${lost === '' ? '' : ` (${lost})`}.</strong> ${capture.reason}</div>`
}

function describeScope(scope: KindScope): string {
  const words = (areas: readonly string[]): string => areas.map((area) => area.replaceAll('_', ' ')).join(', ')
  return `${words(scope.covered) || 'nothing'}, not ${words(scope.notCovered) || 'anything else'}`
}

function formatMilliseconds(milliseconds: number): string {
  return milliseconds < 10 ? `${milliseconds.toFixed(1)} ms` : formatDuration(milliseconds)
}

function more(total: number, shown: number): Markup | undefined {
  return total > shown ? html`<p class="muted small">${total - shown} more are in the artifact.</p>` : undefined
}
