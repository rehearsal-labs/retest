import type { NavigationCause } from '../../protocol/page-facts.ts'
import type { TestResult } from '../../protocol/result.ts'
import type { EventOfType, TestEvent } from '../../reporters/run-record.ts'
import type { Style } from '../../reporters/style.ts'
import type { RunTargets } from '../../reporters/targets.ts'
import type { Look, TimelineEntry } from './looks.ts'
import { join } from 'node:path'
import { describeConsole, describeNetwork } from '../../diagnostics/report.ts'
import { describeEvaluation, evaluationDetails } from '../../evaluation/report.ts'
import { describeLocator } from '../../protocol/locator.ts'
import { secretPlaceholder } from '../../protocol/secret.ts'
import { formatLocation } from '../../protocol/location.ts'
import { actionNotes, describeWrittenAction, type ActionEvent } from '../../reporters/actions.ts'
import { describeCleanup, describeLocks, describePage, describePreparation, describeSessions, describeSessionsReleased, describeStateEvent, formatDuration, plural, printable, statusLabel, testTitle } from '../../reporters/format.ts'
import { describeHostCheck, hostCheckPage } from '../../reporters/host-checks.ts'
import { visibleLength } from '../../reporters/style.ts'
import { describeVariant } from '../../reporters/targets.ts'
import { describeObserved, timelineEntries } from './looks.ts'

export type TimelineOptions = { style: Style; runFolder: string; targets: RunTargets }

const timeWidth = 9

/** An entry's first line, and the lines under it. */
type Described = [string, ...string[]]

/**
 * One test's events as lines, in order: steps, actions, navigations, checks, host checks and evidence, each at its
 * time since the test started. The looks an assertion took are shown under it. A navigation names the page's title
 * and what started it, when the run recorded them. A test with a variant names it, and each line about a page names
 * its app.
 *
 * @example stdout.write(renderTimeline(test, events, { style, runFolder, targets }))
 */
export function renderTimeline(test: TestResult, events: TestEvent[], options: TimelineOptions): string {
  const { style } = options
  const label = describeVariant(test.variant, options.targets)
  const variant = label === undefined ? '' : `  ${style.cyan(label)}`
  const heading = `  ${style.bold(testTitle(test.file, test.name, test.describePath))}${variant}  ${style.dim(formatLocation(test.location))}`
  const hostChecks = test.hostChecks === undefined || test.hostChecks.length === 0 ? [] : [plural(test.hostChecks.length, 'host check')]
  // A skipped test never ran, so it has no time and no checks to show; the host checks keyed to it are still named.
  const facts = test.status === 'skipped' ? [statusLabel(test.status), ...hostChecks] : [statusLabel(test.status), formatDuration(test.durationMs), plural(test.assertionCount, 'check'), ...hostChecks]
  const summary = `  ${facts.join(' · ')}`
  const start = events[0]?.elapsedMs ?? 0
  const stepNames = new Map<string, string>()
  let depth = 0
  const lines = [heading, summary, '']
  for (const entry of timelineEntries(events)) {
    const event = entry.kind === 'event' ? entry.event : entry.last
    if (event.type === 'step.finished') depth = Math.max(0, depth - 1)
    const time = style.dim(formatDuration(event.elapsedMs - start).padStart(timeWidth))
    const app = test.variant !== undefined && isPageEvent(event) && event.session !== undefined ? `${style.cyan(event.session)}  ` : ''
    const [first, ...details] = entry.kind === 'event' ? describe(entry, stepNames, options) : [describeLooks(entry.looks, entry.last)]
    const indent = `  ${' '.repeat(timeWidth)}  ${'  '.repeat(depth)}${' '.repeat(visibleLength(app) + 2)}`
    lines.push(`  ${time}  ${'  '.repeat(depth)}${app}${first}`, ...details.map((detail) => `${indent}${style.dim(detail)}`))
    if (event.type === 'step.started') {
      stepNames.set(event.stepId, event.name)
      depth++
    }
  }
  if (events.length === 0) lines.push(style.dim('  No events were recorded for this test.'))
  return `${lines.join('\n')}\n`
}

function isPageEvent(event: TestEvent): boolean {
  switch (event.type) {
    case 'action.completed':
    case 'action.failed':
    case 'navigation':
    case 'observation':
    case 'host_check.passed':
    case 'host_check.failed':
    case 'diagnostics.started':
    case 'diagnostics.finished':
      return true
    default:
      return false
  }
}

function typed(event: { secret?: string; valueLength?: number }): string {
  if (event.secret !== undefined) return `, ${secretPlaceholder(event.secret)}`
  return event.valueLength === undefined ? '' : `, ${plural(event.valueLength, 'character')}`
}

type EventEntry = Extract<TimelineEntry, { kind: 'event' }>

function describe(entry: EventEntry, stepNames: Map<string, string>, options: TimelineOptions): Described {
  const { style } = options
  const { event } = entry
  switch (event.type) {
    case 'test.started':
      return ['started']
    case 'lock.acquired':
      return [describeLocks(event)]
    case 'session.reserved':
      return [describeSessions(event)]
    case 'session.released':
      return [describeSessionsReleased(event)]
    case 'preparation.finished':
      return [describePreparation(event.preparation)]
    case 'cleanup.finished':
      return [describeCleanup(event.cleanup)]
    case 'step.started':
      return [`▸ ${event.name}`]
    case 'step.finished': {
      const mark = event.status === 'passed' ? style.green('✓') : style.red('✗')
      return [`${mark} ${stepNames.get(event.stepId) ?? event.stepId}  ${style.dim(formatDuration(event.durationMs))}`]
    }
    case 'action.completed':
    case 'action.failed': {
      const text = `${describeAction(event)}  ${style.dim(formatDuration(event.durationMs))}`
      return [event.type === 'action.failed' ? `${style.red('✗')} ${text}  ${style.red(event.failure.class)}` : text]
    }
    case 'navigation':
      return [style.dim(describeNavigation(event))]
    case 'host_check.passed':
      return [`${style.green('✓')} host check ${describeHostCheck(event.check)}  ${style.dim(hostCheckFacts(event))}`]
    case 'host_check.failed':
      return [
        `${style.red('✗')} host check ${describeHostCheck(event.check)}  ${style.dim(hostCheckFacts(event))}  ${style.red(event.failure.class)}`,
        `page ${hostCheckPage(event.check, event.actual)}`,
      ]
    case 'state.saved':
    case 'state.restored':
      return [describeStateEvent(event)]
    case 'assertion.passed':
    case 'assertion.failed':
      return describeAssertion(event, entry.looks, style)
    case 'evidence.captured':
      return [`screenshot ${join(options.runFolder, event.path)}`]
    case 'evidence.failed':
      return [style.yellow(`screenshot not saved: ${event.message}`)]
    case 'evaluation.finished':
      return describeEvaluationEvent(event, options)
    case 'diagnostics.started':
      return [style.dim('diagnostics capture started')]
    case 'diagnostics.finished':
      return [style.dim(`diagnostics ${describeConsole(event.diagnostics.console)} · ${describeNetwork(event.diagnostics.network)}`)]
    case 'test.finished': {
      const duration = event.status === 'not_run' || event.status === 'skipped' ? '' : `  ${style.dim(formatDuration(event.durationMs))}`
      return [`${statusLabel(event.status).toLowerCase()}${duration}`]
    }
  }
}

// An AI check: its verdict, the judge and model that answered, then its criteria, what the judge said and its evidence.
function describeEvaluationEvent(event: EventOfType<'evaluation.finished'>, options: TimelineOptions): Described {
  const { style } = options
  const { evaluation } = event
  const mark = evaluation.verdict === 'pass' ? style.green('✓') : evaluation.mode === 'advisory' ? style.yellow('!') : style.red('✗')
  const failed = evaluation.failure === undefined ? '' : `  ${style.red(evaluation.failure.class)}`
  const details = evaluationDetails(evaluation, options.runFolder).map(({ label, value }) => `${label.toLowerCase()} ${value}`)
  return [`${mark} AI check ${describeEvaluation(evaluation)}  ${style.dim(formatDuration(evaluation.durationMs))}${failed}`, ...details]
}

function describeAction(event: ActionEvent): string {
  const target = event.locator === undefined ? '' : ` ${describeLocator(event.locator)}`
  const notes = actionNotes(event).map((note) => `, ${note}`)
  const page = event.command === 'goto' && event.pageUrl !== undefined ? ` → ${printable(event.pageUrl)}` : ''
  return `${describeWrittenAction(event) ?? `${event.command}${target}`}${typed(event)}${notes.join('')}${page}`
}

const causes: Record<NavigationCause, string> = { goto: 'by goto', action: 'by an action', page: 'by the page' }

// A run from before titles and causes has neither, and the line claims neither.
function describeNavigation(event: EventOfType<'navigation'>): string {
  const cause = event.cause === undefined ? '' : `, ${causes[event.cause]}`
  return `navigated to ${describePage(event.url, event.title)}${cause}`
}

type AssertionEvent = EventOfType<'assertion.passed'> | EventOfType<'assertion.failed'>

// A locator assertion's looks go on the line under it, ending with the one its verdict rested on. A pass the test
// file's process judged alone, on a value only it holds, says so.
function describeAssertion(event: AssertionEvent, looks: readonly Look[], style: Style): Described {
  const passed = event.type === 'assertion.passed'
  const mark = passed ? style.green('✓') : style.red('✗')
  const target = event.locator === undefined ? '' : ` ${describeLocator(event.locator)}`
  const facts = [
    formatDuration(event.durationMs),
    ...(looks.length === 0 ? [plural(event.attempts, 'look')] : []),
    ...(event.soft === true ? ['soft'] : []),
    ...(passed && event.judgedBy === 'child' ? ['reported by the test file'] : []),
  ]
  const failed = event.type === 'assertion.failed' ? `  ${style.red(event.failure.class)}` : ''
  const line = `${mark} ${event.matcher}${target}  ${style.dim(facts.join(', '))}${failed}`
  if (looks.length === 0) return [line]
  const named = looks.find((look) => look.observationId === event.observationId)
  const looked = `looked ${plural(looks.length, 'time')}`
  if (event.observationId === undefined) return [line, `${looked}, last ${describeLook(looks.at(-1))}`]
  const verdict = `${passed ? 'passed' : 'failed'} on ${named === undefined ? event.observationId : describeLook(named)}`
  return [line, `${looked}, ${verdict}`]
}

function describeLook(look: Look | undefined): string {
  return look === undefined ? '' : `${look.observationId}: ${describeObserved(look.observed)}`
}

// Looks no assertion claimed, such as those of a check the run stopped while it looked.
function describeLooks(looks: readonly Look[], last: Look): string {
  const looked = `looked at ${describeLocator(last.locator)}`
  return looks.length === 1 ? `${looked}, ${describeLook(last)}` : `${looked} ${plural(looks.length, 'time')}, last ${describeLook(last)}`
}

function hostCheckFacts(event: EventOfType<'host_check.passed'> | EventOfType<'host_check.failed'>): string {
  return `${formatDuration(event.durationMs)}, ${plural(event.attempts, 'look')}`
}
