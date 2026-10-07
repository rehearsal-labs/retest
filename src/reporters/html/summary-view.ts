import type { RunStatus } from '../../protocol/events.ts'
import type { FailureCard } from '../failure-card.ts'
import type { EvidenceState } from './evidence-status.ts'
import type { Markup } from './markup.ts'
import type { ReportContext } from './report-context.ts'
import type { TestEntry } from './test-view.ts'
import { diagnosticsTotals } from '../../diagnostics/report.ts'
import { countEvaluations } from '../../evaluation/report.ts'
import { describeFileProblem, runFailureToShow } from '../failure-card.ts'
import { countParts, describeNarrowed, failureLabel, formatDetail, formatDuration, runNotes, testTitle } from '../format.ts'
import { countHostChecks } from '../host-checks.ts'
import { describeBrowser, describeNative, targetSummaries, variantLabel } from '../targets.ts'
import { codeFrameView, failureView } from './failure-view.ts'
import { evidenceLabel } from './evidence-status.ts'
import { html } from './markup.ts'
import { statusView } from './test-view.ts'

const runWords: Record<RunStatus, { mark: string; word: string; tone: string }> = {
  passed: { mark: '✓', word: 'Passed', tone: 'passed' },
  failed: { mark: '✗', word: 'Failed', tone: 'failed' },
  error: { mark: '!', word: 'Could not check everything', tone: 'error' },
  interrupted: { mark: '!', word: 'Interrupted', tone: 'error' },
}

/** How a run ended, in words, as the page title and heading say it. */
export function runStatusWord(status: RunStatus): string {
  return runWords[status].word
}

/**
 * The top of a report: how the run ended and its exit code, the tests, checks, host checks, AI checks and diagnostics
 * in counts, as the terminal summary gives them, then the facts of the run and, apart from the outcome, how much of
 * its evidence is here. Anything a reader must know first follows: why the folder read as it did, the run's own
 * failure, a run that stopped or did not check everything, and `test.only`.
 *
 * @example runSummaryView(entries, context)
 */
export function runSummaryView(entries: readonly TestEntry[], context: ReportContext): Markup {
  const { result } = context.input
  const { mark, word, tone } = runWords[result.status]
  const notes = runNotes(result)
  const exit = `Exit ${result.exitCode}${notes.length === 0 ? '' : ` · ${notes.join(', ')}`}`
  const heading = html`<div class="run-head"><h1>Retest run <span class="status status-${tone}">${mark} ${word}</span></h1><span class="status status-${tone}">${exit}</span></div>`
  return html`<header>${heading}${countsView(context)}${factsView(entries, context)}</header>${noticesView(context)}`
}

function countsView(context: ReportContext): Markup {
  const { result } = context.input
  const tests = result.files.flatMap((file) => file.tests)
  const summaries = targetSummaries(result, context.targets)
  const rows: [string, string][] = [['Tests', `${countParts(result.counts).join(' · ') || 'none'}${summaries.length > 1 ? ` across ${summaries.length} targets` : ''}`]]
  const checks = countChecks(context)
  if (checks.length > 0) rows.push(['Checks', checks.join(' · ')])
  const hostChecks = countHostChecks(tests)
  if (hostChecks.length > 0) rows.push(['Host checks', hostChecks.join(' · ')])
  const evaluations = countEvaluations(tests)
  if (evaluations.length > 0) rows.push(['AI checks', evaluations.join(' · ')])
  const diagnostics = diagnosticsTotals(tests)
  if (diagnostics !== undefined) rows.push(['Diagnostics', diagnostics.join(' · ')])
  rows.push(['Time', formatDuration(result.durationMs)])
  return html`<ul class="counts">${rows.map(([label, value]) => html`<li><span class="muted">${label}</span> ${value}</li>`)}</ul>`
}

function countChecks(context: ReportContext): string[] {
  let passed = 0
  let failed = 0
  for (const test of context.record.tests.values()) {
    for (const event of test.events) {
      if (event.type === 'assertion.passed') passed += 1
      if (event.type === 'assertion.failed') failed += 1
    }
  }
  return [...(failed > 0 ? [`${failed} failed`] : []), ...(passed > 0 ? [`${passed} passed`] : [])]
}

function factsView(entries: readonly TestEntry[], context: ReportContext): Markup {
  const { result, source } = context.input
  const started = context.record.started
  const rows: [string, string][] = [
    ['Run', result.runId],
    ['Started', result.startedAt],
    ['Finished', result.finishedAt],
    ['Retest', result.retestVersion],
  ]
  if (started !== undefined) rows.push(['Node', `${started.node} on ${started.platform}`])
  for (const browser of context.record.browsers.filter((each) => each.instance === undefined)) {
    const target = browser.app === undefined || browser.target === undefined ? '' : `${browser.app}=${browser.target.name}: `
    const engine = [...(browser.engine === undefined ? [] : [`engine ${browser.engine}`]), ...(browser.build === undefined ? [] : [`build ${browser.build}`])]
    rows.push(['Browser', `${target}${describeBrowser(browser)}${engine.length === 0 ? '' : ` · ${engine.join(', ')}`}${browser.instances === undefined ? '' : ` · ${browser.instances} browsers`}`])
  }
  for (const native of result.natives ?? []) rows.push(['Native app', `${native.app}=${native.target}: ${describeNative(native)}`])
  rows.push(['Read from', describeSource(source)], ['Evidence', describeEvidence(entries)])
  return html`<dl class="facts">${rows.map(([label, value]) => html`<dt>${label}</dt><dd>${value}</dd>`)}</dl>`
}

function describeSource(source: ReportContext['input']['source']): string {
  if (source === 'result.json') return 'result.json and events.jsonl'
  if (source === 'events.jsonl') return 'events.jsonl alone: the run left no result.json, so its result was rebuilt and is incomplete'
  return 'the run as it ended, before it wrote result.json'
}

// How much of the evidence is here, apart from how the tests ended: how many tests are at each state, worst first.
function describeEvidence(entries: readonly TestEntry[]): string {
  const order: EvidenceState[] = ['unavailable', 'partial', 'complete', 'none']
  const parts = order.flatMap((state) => {
    const count = entries.filter((entry) => entry.evidence.status.state === state).length
    return count === 0 ? [] : [`${evidenceLabel(state).toLowerCase()} for ${count} ${count === 1 ? 'test' : 'tests'}`]
  })
  return parts.length === 0 ? 'no tests' : parts.join(' · ')
}

function noticesView(context: ReportContext): Markup {
  const { result, warnings } = context.input
  const read = warnings.map((warning) => html`<div class="notice notice-error words">${warning}</div>`)
  const failure = runFailureToShow(result)
  const details = Object.entries(failure?.details ?? {}).map(([key, value]) => html`<div class="small words">${key} ${formatDetail(value)}</div>`)
  const failed = failure === undefined ? undefined : html`<div class="notice notice-failed"><p><span class="check-name">Run failed: ${failureLabel(failure.class)}</span></p><pre class="words">${failure.message}</pre>${details}</div>`
  const stopped = result.status === 'interrupted' ? html`<div class="notice notice-error">The run was stopped before it finished. Tests it had not reached did not run.</div>` : undefined
  const incomplete = result.complete ? undefined : html`<div class="notice notice-error">The run is incomplete: it did not check everything it was asked to check.</div>`
  const narrowed = result.narrowed === undefined ? undefined : html`<div class="notice notice-error words">${describeNarrowed(result.narrowed)}</div>`
  return html`${read}${failed}${stopped}${incomplete}${narrowed}`
}

/**
 * Every test in one table, in run order, each linked to its section: its status, title, targets, time and how much of
 * its evidence is here.
 *
 * @example overviewView(entries, context)
 */
export function overviewView(entries: readonly TestEntry[], context: ReportContext): Markup {
  if (entries.length === 0) return html`<p class="muted">The run has no tests.</p>`
  const rows = entries.map(({ test, id, evidence }) => {
    const label = variantLabel(test.variant, context.targets) ?? ''
    const took = test.status === 'not_run' || test.status === 'skipped' ? '' : formatDuration(test.durationMs)
    return html`<tr><td>${statusView(test.status)}</td><td><a class="words" href="#${id}">${testTitle(test.file, test.name, test.describePath)}</a></td><td class="words">${label}</td><td class="number">${took}</td><td class="evidence evidence-${evidence.status.state}">${evidenceLabel(evidence.status.state)}</td></tr>`
  })
  return html`<div class="table-wrap"><table><thead><tr><th scope="col">Status</th><th scope="col">Test</th><th scope="col">Targets</th><th scope="col">Took</th><th scope="col">Evidence</th></tr></thead><tbody>${rows}</tbody></table></div>`
}

/**
 * A file that could not be collected, or whose process failed outside its tests, as an open section with its failure
 * and the code it points to.
 *
 * @example fileProblemView(card, 'file-1', context)
 */
export function fileProblemView(card: FailureCard, id: string, context: ReportContext): Markup {
  const problem = card.fileProblem === undefined ? '' : describeFileProblem(card.fileProblem)
  const code = card.location === undefined ? undefined : codeFrameView(context, card.location)
  const failure = card.failure === undefined ? '' : html` data-failure-class="${card.failure.class}"`
  return html`<article class="test failing" id="${id}" data-file="${card.file}"${failure}><div class="test-head"><h3><span class="status status-failed">✗ File</span> <span class="test-title">${card.title}</span></h3><span class="test-facts"><span>${problem}</span></span></div><div class="test-body">${failureView(card)}${code}</div></article>`
}
