import type { TestResult } from '../../protocol/result.ts'
import type { ActionEvent } from '../actions.ts'
import type { EventOfType, TestEvent } from '../run-record.ts'
import type { Look, TimelineEntry } from '../../cli/inspect/looks.ts'
import type { Markup } from './markup.ts'
import { describeObserved, timelineEntries } from '../../cli/inspect/looks.ts'
import { describeConsole, describeNetwork } from '../../diagnostics/report.ts'
import { describeEvaluation } from '../../evaluation/report.ts'
import { describeLocator } from '../../protocol/locator.ts'
import { secretPlaceholder } from '../../protocol/secret.ts'
import { describeLeaseParts } from '../../runner/resources.ts'
import { actionNotes, describeWrittenAction } from '../actions.ts'
import {
  describeCleanup,
  describeLeaseExpired,
  describeLocks,
  describePage,
  describePreparation,
  describeResources,
  describeSessions,
  describeSessionsReleased,
  describeStateEvent,
  failureLabel,
  formatDuration,
  plural,
  printable,
  statusLabel,
} from '../format.ts'
import { describeHostCheck, hostCheckPage } from '../host-checks.ts'
import { html } from './markup.ts'

/** How a timeline row ended, when it is a check, an action or a step that can end either way. */
type Mark = 'passed' | 'failed' | 'warning'

/** One row: what happened, how it ended, what it took and what the reader should know under it. */
type Described = { what: string; mark?: Mark; took?: number; failure?: string; details?: string[] }

const marks: Record<Mark, string> = { passed: '✓', failed: '✗', warning: '!' }
const markClasses: Record<Mark, string> = { passed: 'status-passed', failed: 'status-failed', warning: 'status-error' }
const deepest = 6

/**
 * A test's events as a table, in order: steps, actions, navigations, checks with the looks they rested on, host checks,
 * screenshots, AI checks and diagnostics, each at its time since the test's first event. A test with a variant names
 * the app of each row about a page. Every row carries its moment on the run's clock, which a recording's own clock maps
 * to its video.
 *
 * @example timelineView(test, record.events)
 */
export function timelineView(test: TestResult, events: readonly TestEvent[]): Markup {
  if (events.length === 0) return html`<p class="gap">No steps are shown: the run folder holds no events for this test.</p>`
  const start = events[0]?.elapsedMs ?? 0
  const named = test.variant !== undefined
  const stepNames = new Map<string, string>()
  let depth = 0
  const rows: Markup[] = []
  for (const entry of timelineEntries(events)) {
    const event = entry.kind === 'event' ? entry.event : entry.last
    if (event.type === 'step.finished') depth = Math.max(0, depth - 1)
    const described = entry.kind === 'event' ? describe(entry, stepNames) : { what: describeLooks(entry.looks, entry.last) }
    const app = named && isPageEvent(event) ? event.session : undefined
    rows.push(row({ described, offsetMs: event.elapsedMs - start, elapsedMs: event.elapsedMs, app, depth, named, jump: (test.recordings?.length ?? 0) > 0 }))
    if (event.type === 'step.started') {
      stepNames.set(event.stepId, event.name)
      depth += 1
    }
  }
  const appHead = named ? html`<th scope="col">App</th>` : ''
  return html`<div class="table-wrap"><table class="timeline"><thead><tr><th scope="col">Time</th>${appHead}<th scope="col">Step</th><th scope="col">Took</th></tr></thead><tbody>${rows}</tbody></table></div>`
}

type RowParts = { described: Described; offsetMs: number; elapsedMs: number; app: string | undefined; depth: number; named: boolean; jump: boolean }

function row({ described, offsetMs, elapsedMs, app, depth, named, jump }: RowParts): Markup {
  const { mark, what, took, failure, details = [] } = described
  const marked = mark === undefined ? '' : html`<span class="status ${markClasses[mark]}">${marks[mark]}</span> `
  const failed = failure === undefined ? '' : html` <span class="status status-failed">${failure}</span>`
  const under = details.map((detail) => html`<div class="detail words">${detail}</div>`)
  const level = Math.min(depth, deepest)
  const indent = level === 0 ? '' : ` depth-${level}`
  const appCell = named ? html`<td class="app">${app ?? ''}</td>` : ''
  const rowClass = mark === 'failed' ? html` class="row-failed"` : ''
  const words = jump ? html`<button type="button" class="jump-step words" data-jump-step data-elapsed-ms="${elapsedMs}"${app === undefined ? '' : html` data-jump-app="${app}"`}>${what}</button>` : html`<span class="words">${what}</span>`
  return html`<tr${rowClass} data-elapsed-ms="${elapsedMs}"><td class="time">${formatDuration(offsetMs)}</td>${appCell}<td class="what${indent}">${marked}${words}${failed}${under}</td><td class="number">${took === undefined ? '' : formatDuration(took)}</td></tr>`
}

function isPageEvent(event: TestEvent): boolean {
  switch (event.type) {
    case 'action.completed':
    case 'action.failed':
    case 'navigation':
    case 'observation':
    case 'host_check.passed':
    case 'host_check.failed':
    case 'evidence.captured':
    case 'evidence.failed':
    case 'diagnostics.started':
    case 'diagnostics.finished':
    case 'recording.started':
    case 'recording.finished':
    case 'capture.withheld':
    case 'capture.resumed':
    case 'capture.masked_entry':
      return true
    default:
      return false
  }
}

type EventEntry = Extract<TimelineEntry<TestEvent>, { kind: 'event' }>

function describe(entry: EventEntry, stepNames: ReadonlyMap<string, string>): Described {
  const { event } = entry
  const type: string = event.type
  switch (event.type) {
    case 'native.started': {
      const { identity } = event
      return {
        what: `${event.product} on ${identity.platform === 'macos' ? 'macOS' : `iOS Simulator ${identity.os.version}`}`,
        details: [`session ${event.sessionId}`, `${identity.app.bundleId} · build ${identity.app.build ?? 'unavailable'} · sha256 ${identity.app.sha256}`, `${identity.executor.name} ${identity.executor.version} · Xcode ${identity.xcode.version} (${identity.xcode.build})`],
      }
    }
    case 'native.ended':
      return { what: 'native session ended', ...(event.unknownOutcomes.length === 0 ? {} : { mark: 'warning' as const, details: [`${plural(event.unknownOutcomes.length, 'action')} with an unknown outcome kept`] }) }
    case 'test.started':
      return { what: 'started' }
    case 'lock.acquired':
      return { what: describeLocks(event) }
    case 'session.reserved':
      return { what: describeSessions(event) }
    case 'session.released':
      return { what: describeSessionsReleased(event) }
    case 'resource.acquired':
      return { what: describeResources(event) }
    case 'lease.taken':
      return { what: `lease taken: ${describeLeaseParts(event.lease.covers, event.variant)}` }
    case 'lease.expired':
      return { what: describeLeaseExpired(event), mark: 'warning' }
    case 'preparation.finished':
      return { what: describePreparation(event.preparation), ...(event.preparation.outcome === 'prepared' ? {} : { mark: 'warning' as const }), took: event.preparation.durationMs }
    case 'cleanup.finished':
      return { what: describeCleanup(event.cleanup), ...(event.cleanup.outcome === 'done' ? {} : { mark: 'warning' as const }), took: event.cleanup.durationMs }
    case 'step.started':
      return { what: `▸ ${event.name}${event.hook === undefined ? '' : ` (${event.hook})`}` }
    case 'step.finished':
      return { what: stepNames.get(event.stepId) ?? event.stepId, mark: event.status === 'passed' ? 'passed' : 'failed', took: event.durationMs }
    case 'action.completed':
      return { what: describeAction(event), took: event.durationMs }
    case 'action.failed':
      return { what: describeAction(event), mark: 'failed', took: event.durationMs, failure: failureLabel(event.failure.class) }
    case 'navigation':
      return { what: describeNavigation(event) }
    case 'host_check.passed':
      return { what: `host check ${describeHostCheck(event.check)}`, mark: 'passed', took: event.durationMs, details: [plural(event.attempts, 'look')] }
    case 'host_check.failed':
      return { what: `host check ${describeHostCheck(event.check)}`, mark: 'failed', took: event.durationMs, failure: failureLabel(event.failure.class), details: [`${plural(event.attempts, 'look')}, page ${hostCheckPage(event.check, event.actual)}`] }
    case 'state.saved':
    case 'state.restored':
      return { what: describeStateEvent(event) }
    case 'assertion.passed':
    case 'assertion.failed':
      return describeAssertion(event, entry.looks)
    case 'evidence.captured':
      return { what: `screenshot ${event.path}`, details: screenshotFacts(event) }
    case 'evidence.failed':
      return { what: `screenshot not saved: ${event.message}`, mark: 'warning' }
    case 'evaluation.finished':
      return describeEvaluationEvent(event)
    case 'recording.started':
      return { what: `recording ${event.number} started: ${event.source}, ${event.mode}, ${event.width}×${event.height} at ${event.fps} fps` }
    case 'recording.finished': {
      const { recording } = event
      const what = `recording ${recording.sequence} ${recording.status === 'complete' ? 'complete' : recording.status}`
      return recording.status === 'complete' ? { what } : { what, mark: 'warning', details: recording.gaps.map((gap) => gap.message) }
    }
    case 'artifact.removal_requested':
      return { what: `retention removal requested: ${event.kind} ${event.path}`, details: [`${event.reason}, ${event.moment}, ${event.bytes} bytes`] }
    case 'artifact.removed':
      return { what: `retention removed: ${event.kind} ${event.path}`, details: [`${event.reason}, ${event.moment}, ${event.bytes} bytes`] }
    case 'artifact.removal_failed':
      return { what: `retention removal failed: ${event.kind} ${event.path}`, mark: 'warning', details: [event.message] }
    case 'capture.withheld':
      return { what: `captures withheld by the pixel policy while ${secretPlaceholder(event.secret)} may be on screen`, mark: 'warning' }
    case 'capture.resumed':
      return { what: `captures resumed: ${event.reason ?? resumedWords[event.endedBy]}` }
    case 'capture.masked_entry':
      return { what: `${secretPlaceholder(event.secret)} typed into a field that masks it, so captures went on` }
    case 'diagnostics.started':
      return { what: 'diagnostics capture started' }
    case 'diagnostics.finished':
      return { what: `diagnostics ${describeConsole(event.diagnostics.console)} · ${describeNetwork(event.diagnostics.network)}` }
    case 'test.finished':
      return { what: statusLabel(event.status).toLowerCase(), ...(event.status === 'not_run' || event.status === 'skipped' ? {} : { took: event.durationMs }) }
    default:
      return { what: type }
  }
}

function describeAction(event: ActionEvent): string {
  const target = event.locator === undefined ? '' : ` ${describeLocator(event.locator)}`
  const typed = event.secret !== undefined ? `, ${secretPlaceholder(event.secret)}` : event.valueLength === undefined ? '' : `, ${plural(event.valueLength, 'character')}`
  const notes = actionNotes(event).map((note) => `, ${note}`).join('')
  const page = event.command === 'goto' && event.pageUrl !== undefined ? ` → ${printable(event.pageUrl)}` : ''
  return `${describeWrittenAction(event) ?? `${event.command}${target}`}${typed}${notes}${page}`
}

const causes = { goto: 'by goto', action: 'by an action', page: 'by the page' } as const

const resumedWords: Record<EventOfType<'capture.resumed'>['endedBy'], string> = {
  nothing_typed: 'nothing was typed',
  field_gone: 'the field is gone',
  field_empty: 'the field is empty',
  field_masked: 'the field masks its text',
  new_document: 'the page opened another document',
  session_ended: 'the session ended',
}

// A run from before titles and causes has neither, and the row claims neither.
function describeNavigation(event: EventOfType<'navigation'>): string {
  const cause = event.cause === undefined ? '' : `, ${causes[event.cause]}`
  return `navigated to ${describePage(event.url, event.title)}${cause}`
}

type AssertionEvent = EventOfType<'assertion.passed'> | EventOfType<'assertion.failed'>

// A locator check's looks go under it, ending with the one its verdict rested on. A pass the test file's process judged
// alone, on a value only it holds, says so.
function describeAssertion(event: AssertionEvent, looks: readonly Look[]): Described {
  const passed = event.type === 'assertion.passed'
  const target = event.locator === undefined ? '' : ` ${describeLocator(event.locator)}`
  const notes = [...(looks.length === 0 ? [plural(event.attempts, 'look')] : []), ...(event.soft === true ? ['soft'] : []), ...(passed && event.judgedBy === 'child' ? ['reported by the test file'] : [])]
  const described: Described = {
    what: `${event.matcher}${target}`,
    mark: passed ? 'passed' : 'failed',
    took: event.durationMs,
    ...(event.type === 'assertion.failed' ? { failure: failureLabel(event.failure.class) } : {}),
  }
  const details = [...(notes.length === 0 ? [] : [notes.join(', ')]), ...looksDetail(event, looks)]
  return details.length === 0 ? described : { ...described, details }
}

function looksDetail(event: AssertionEvent, looks: readonly Look[]): string[] {
  if (looks.length === 0) return []
  const looked = `looked ${plural(looks.length, 'time')}`
  if (event.observationId === undefined) return [`${looked}, last ${describeLook(looks.at(-1))}`]
  const named = looks.find((look) => look.observationId === event.observationId)
  return [`${looked}, ${event.type === 'assertion.passed' ? 'passed' : 'failed'} on ${named === undefined ? event.observationId : describeLook(named)}`]
}

function describeLook(look: Look | undefined): string {
  return look === undefined ? '' : `${look.observationId}: ${describeObserved(look.observed)}`
}

// Looks no check claimed, such as those of a check the run stopped while it looked.
function describeLooks(looks: readonly Look[], last: Look): string {
  const looked = `looked at ${describeLocator(last.locator)}`
  return looks.length === 1 ? `${looked}, ${describeLook(last)}` : `${looked} ${plural(looks.length, 'time')}, last ${describeLook(last)}`
}

function screenshotFacts(event: EventOfType<'evidence.captured'>): string[] {
  const facts = [
    ...(event.source === undefined ? [] : [event.source]),
    ...(event.sessionId === undefined ? [] : [`session ${event.sessionId}`]),
    ...(event.observationId === undefined ? [] : [`look ${event.observationId}`]),
  ]
  return facts.length === 0 ? [] : [facts.join(', ')]
}

function describeEvaluationEvent(event: EventOfType<'evaluation.finished'>): Described {
  const { evaluation } = event
  const mark: Mark = evaluation.verdict === 'pass' ? 'passed' : evaluation.mode === 'advisory' ? 'warning' : 'failed'
  return {
    what: `AI check ${describeEvaluation(evaluation)}`,
    mark,
    took: evaluation.durationMs,
    ...(evaluation.failure === undefined ? {} : { failure: failureLabel(evaluation.failure.class) }),
    details: ['its criteria, evidence and judge are under AI checks'],
  }
}
