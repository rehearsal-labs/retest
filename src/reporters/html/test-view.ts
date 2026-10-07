import type { TestStatus } from '../../protocol/events.ts'
import type { TestResult } from '../../protocol/result.ts'
import type { FailureCard } from '../failure-card.ts'
import type { TestEvent } from '../run-record.ts'
import type { TestEvidence } from './evidence-status.ts'
import type { Markup } from './markup.ts'
import type { ReportContext } from './report-context.ts'
import { evaluationWarnings } from '../../evaluation/report.ts'
import { formatInspectCommand } from '../commands.ts'
import { notRunReason } from '../failure-card.ts'
import { failureLabel, formatDuration, statusLabel, testTitle } from '../format.ts'
import { namingTargets, variantLabel } from '../targets.ts'
import { diagnosticsView } from './diagnostics-view.ts'
import { evaluationsView } from './evaluations-view.ts'
import { evidenceLabel, noScreenshotReason } from './evidence-status.ts'
import { codeFrameView, failureView } from './failure-view.ts'
import { html } from './markup.ts'
import { recordingsView } from './recordings-view.ts'
import { replayView } from './replay-view.ts'
import { screenshotsView } from './screenshots-view.ts'
import { targetsView } from './targets-view.ts'
import { timelineView } from './timeline-view.ts'

/** One test as a section shows it: its result, its events, its card when it did not pass, and its evidence. */
export type TestEntry = { test: TestResult; id: string; events: readonly TestEvent[]; card?: FailureCard | undefined; evidence: TestEvidence }

const statusMarks: Record<TestStatus, string> = { passed: '✓', failed: '✗', error: '!', not_run: '–', inconclusive: '?', skipped: '○' }

/** A status as a mark and a word, coloured by what it says. */
export function statusView(status: TestStatus): Markup {
  return html`<span class="status status-${status.replaceAll('_', '-')}">${statusMarks[status]} ${statusLabel(status)}</span>`
}

/**
 * A test that did not pass, open: what failed and its values first, then its screenshots, the code, its recordings, its
 * AI checks, and under them its steps, console and network, targets and replay facts, each to open.
 *
 * @example failingTestView(entry, context)
 */
export function failingTestView(entry: TestEntry, context: ReportContext): Markup {
  return html`<article class="test failing"${attributes(entry)}><div class="test-head">${head(entry, context)}</div><div class="test-body">${body(entry, context)}</div></article>`
}

/**
 * A test that passed, was skipped or did not run, closed under its heading, with the same parts inside.
 *
 * @example otherTestView(entry, context)
 */
export function otherTestView(entry: TestEntry, context: ReportContext): Markup {
  return html`<details class="test"${attributes(entry)}><summary>${head(entry, context)}</summary><div class="test-body">${body(entry, context)}</div></details>`
}

// What a reader and a test both read the outcome from: the status, the failure's class and the evidence state.
function attributes({ test, id, evidence }: TestEntry): Markup {
  const variant = test.variantKey === undefined ? '' : html` data-variant-key="${test.variantKey}"`
  const failure = test.failure === undefined ? '' : html` data-failure-class="${test.failure.class}"`
  return html` id="${id}" data-test-id="${test.testId}"${variant} data-status="${test.status}"${failure} data-evidence="${evidence.status.state}"`
}

function head({ test, evidence }: TestEntry, context: ReportContext): Markup {
  const label = variantLabel(test.variant, context.targets)
  const facts = [
    ...(test.failure === undefined ? [] : [html`<span>${failureLabel(test.failure.class)}</span>`]),
    ...(label === undefined ? [] : [html`<span class="words">${label}</span>`]),
    ...(test.setup === true ? [html`<span>setup</span>`] : []),
    ...(test.status === 'not_run' || test.status === 'skipped' ? [] : [html`<span>${formatDuration(test.durationMs)}</span>`]),
    html`<span class="evidence evidence-${evidence.status.state}">${evidenceLabel(evidence.status.state)}</span>`,
  ]
  return html`<h3>${statusView(test.status)} <span class="test-title">${testTitle(test.file, test.name, test.describePath)}</span></h3><span class="test-facts">${facts}</span>`
}

function body(entry: TestEntry, context: ReportContext): Markup {
  const { test, card, evidence, events } = entry
  const failing = card === undefined ? undefined : failureView(card)
  const reasons = evidenceReasons(entry)
  const warnings = evaluationWarnings(test).map((warning) => html`<div class="notice notice-error words">${warning}</div>`)
  const notRun = notRunNote(test, context)
  const missing = evidence.status.reasons.includes(noScreenshotReason) ? noScreenshotReason : undefined
  const pictures = screenshotsView(evidence.screenshots, { missing })
  const code = card?.location === undefined ? undefined : codeFrameView(context, card.location)
  const recordings = recordingsView(test.recordings ?? [], context.files)
  const evaluations = evaluationsView(test.evaluations ?? [], context.files)
  const openChecks = (test.evaluations ?? []).some((record) => record.verdict !== 'pass' && record.verdict !== 'not_run')
  const diagnostics = diagnosticsView(test.diagnostics ?? [], events, context.files)
  const replay = replayView(test)
  return html`${failing}${notRun}${warnings}${reasons}${pictures}${code}${part('Recordings', recordings, card !== undefined)}${part('AI checks', evaluations, openChecks)}${part('Steps', timelineView(test, events), false)}${part('Console and network', diagnostics, false)}${part('Targets', targetsView(test, context), false)}${part('Replay facts', replay, false)}${commands(entry, context)}`
}

function part(title: string, content: Markup | undefined, open: boolean): Markup | undefined {
  if (content === undefined) return undefined
  return html`<details class="part"${open ? html` open` : ''}><summary>${title}</summary>${content}</details>`
}

function evidenceReasons({ evidence, test }: TestEntry): Markup | undefined {
  const { state, reasons } = evidence.status
  if (reasons.length === 0) return undefined
  if (state === 'none') return html`<p class="muted small">No evidence: ${test.status === 'skipped' ? 'the test was skipped' : 'the test did not run'}.</p>`
  const items = reasons.map((reason) => html`<li class="words">${reason}</li>`)
  return html`<div class="notice notice-error small"><strong>${evidenceLabel(state)}.</strong> What is missing:<ul>${items}</ul></div>`
}

function notRunNote(test: TestResult, context: ReportContext): Markup | undefined {
  if (test.status === 'skipped') return html`<p class="small">Skipped: <code>test.skip</code> or a skipped <code>describe</code> kept it from running.</p>`
  if (test.status !== 'not_run') return undefined
  const reason = notRunReason(context.input.result, test)
  if (reason === undefined) return html`<p class="small">Not run, for the run's own reason at the top of this report.</p>`
  return html`<p class="small"><span class="check-name">${failureLabel(reason.class)}</span></p><pre class="words">${reason.message}</pre>`
}

function commands({ test, card }: TestEntry, context: ReportContext): Markup {
  const targets = card?.test?.targets ?? namingTargets(test.variant, context.targets)
  const inspect = formatInspectCommand({ runFolder: context.input.shown, testId: test.testId, targets })
  const rerun = card?.rerun === undefined ? undefined : html`<dt>Rerun</dt><dd><code class="words">${card.rerun}</code></dd>`
  return html`<dl class="check-lines">${rerun}<dt>Inspect</dt><dd><code class="words">${inspect}</code></dd></dl>`
}
