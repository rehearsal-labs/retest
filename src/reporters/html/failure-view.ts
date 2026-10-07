import type { Failure, SourceLocation, TruncatedText } from '../../protocol/failures.ts'
import type { FailedHostCheck } from '../host-checks.ts'
import type { Markup, Part } from './markup.ts'
import { formatLocation } from '../../protocol/location.ts'
import { describeLocator } from '../../protocol/locator.ts'
import type { ReportContext } from './report-context.ts'
import { diffLines } from '../diff.ts'
import {
  callLocator,
  callName,
  callNotes,
  describeWait,
  messageRepeatsValues,
  recordedValues,
  unshownDetails,
  type FailureCard,
  type RecordedValues,
} from '../failure-card.ts'
import { describePage, failureLabel, formatDetail, formatDuration, statusLabel } from '../format.ts'
import { describeHostCheck, describeHostCheckWait, hostCheckExpectation, hostCheckHeading, hostCheckMessageRepeats, hostCheckPage } from '../host-checks.ts'
import { html, join } from './markup.ts'

/** One labelled line of a check: what it names, and what it says. */
type Line = [label: string, value: Part]

/**
 * What failed, as the terminal card says it: the failing call or host check with its message, locator, page, both
 * values or their diff, the comparison and the wait; then the failure's other details, each other host check that
 * failed, the host checks that never ran, and cleanup failures. Every value is page or test text, escaped.
 *
 * @example failureView(card)
 */
export function failureView(card: FailureCard): Markup {
  const lead = card.hostCheck === undefined ? callBlock(card) : hostCheckBlock(card.hostCheck)
  const details = unshownDetails(card).map(([key, value]): Line => [key, formatDetail(value)])
  const others = card.alsoFailedChecks.map((check) => hostCheckBlock(check))
  const notRun = card.notRunChecks.map(({ check, app }): Line => ['Not run', `host check ${describeHostCheck(check, app)}`])
  const cleanups = card.cleanupFailures.map((failure) => failureBlock(failure))
  return join([lead, lines(details), ...others, lines(notRun), ...cleanups])
}

function callBlock(card: FailureCard): Markup {
  const { failure, call } = card
  const values = recordedValues(call)
  const locator = call === undefined ? undefined : callLocator(call)
  const name = call === undefined ? '' : [callName(call), ...callNotes(call)].join(', ')
  const message = failure !== undefined && !messageRepeatsValues(card) ? html`<pre class="words">${failure.message}</pre>` : undefined
  const rows: Line[] = []
  if (locator !== undefined) rows.push(['Locator', html`<code class="words">${describeLocator(locator)}</code>`])
  if (call?.pageUrl !== undefined) rows.push(['Page', html`<span class="words">${describePage(call.pageUrl, call.pageTitle)}</span>`])
  if (values !== undefined) rows.push(...valueLines(values))
  if (call?.type === 'assertion.failed' && call.comparison !== undefined) rows.push(['Compared', call.comparison])
  if (call !== undefined) rows.push(['Waited', describeWait(call, formatDuration)])
  const diff = values === undefined ? undefined : diffView(values)
  return html`<div class="check"><p><span class="check-name">${headline(card)}</span> ${name === '' ? '' : html`<code class="words">${name}</code>`}</p>${message}${lines(rows)}${diff}</div>`
}

function headline(card: FailureCard): string {
  if (card.failure !== undefined) return failureLabel(card.failure.class)
  return card.test === undefined ? failureLabel('collection_failed') : statusLabel(card.test.status)
}

function hostCheckBlock(check: FailedHostCheck): Markup {
  const { failure, looked } = check
  const message = hostCheckMessageRepeats(check) ? undefined : html`<pre class="words">${failure.message}</pre>`
  const rows: Line[] = [['Expected', html`<span class="words">${hostCheckExpectation(check.check)}</span>`]]
  if (looked !== undefined) rows.push(['Page', html`<span class="words">${hostCheckPage(check.check, looked.actual)}</span>`], ['Waited', describeHostCheckWait(looked, formatDuration)])
  return html`<div class="check"><p><span class="check-name">${failureLabel(failure.class)}</span> <span class="words">${hostCheckHeading(check.check, check.app)}</span></p>${message}${lines(rows)}</div>`
}

function failureBlock(failure: Failure): Markup {
  return html`<div class="check"><p><span class="check-name">${failureLabel(failure.class)}</span></p><pre class="words">${failure.message}</pre></div>`
}

// Values on one line each are shown whole and quoted, as JSON writes them; a value that spans lines is shown as a diff.
function valueLines(values: RecordedValues): Line[] {
  const { expected, actual } = values
  if (spansLines(values)) return [['Values', 'shown below as a diff, − expected and + received']]
  return [
    ['− Expected', html`<span class="value expected">${JSON.stringify(expected.text)}</span>${cutNote(expected)}`],
    ['+ Received', html`<span class="value received">${JSON.stringify(actual.text)}</span>${cutNote(actual)}`],
  ]
}

function spansLines(values: RecordedValues): boolean {
  return values.expected.text.includes('\n') || values.actual.text.includes('\n')
}

function diffView(values: RecordedValues): Markup | undefined {
  if (!spansLines(values)) return undefined
  const rows = diffLines(values.expected.text, values.actual.text).map((line) => {
    if (line.kind === 'same') return html`<div>  ${line.text}</div>`
    return line.kind === 'expected' ? html`<div class="diff-expected">− ${line.text}</div>` : html`<div class="diff-received">+ ${line.text}</div>`
  })
  const notes = [cutNote(values.expected, 'Expected'), cutNote(values.actual, 'Received')]
  return html`<div class="diff" role="group" aria-label="Expected and received, line by line">${rows}</div>${join(notes)}`
}

// A value is recorded cut to a limit; the note says how much of it the record holds.
function cutNote(value: TruncatedText, label?: string): Markup | undefined {
  if (!value.truncated) return undefined
  const subject = label === undefined ? 'Recorded' : `${label} was recorded as`
  return html` <span class="muted small">(${subject} its first ${value.text.length} of ${value.length} characters)</span>`
}

function lines(rows: readonly Line[]): Markup | undefined {
  if (rows.length === 0) return undefined
  return html`<dl class="check-lines">${rows.map(([label, value]) => html`<dt>${label}</dt><dd>${typeof value === 'string' ? html`<span class="words">${value}</span>` : value}</dd>`)}</dl>`
}

/** Renders only a pre-read, redacted source frame authorized by the run's loaded test bundle. */
export function codeFrameView(context: ReportContext, location: SourceLocation): Markup {
  const where = html`<p class="small"><code class="words">${formatLocation(location)}</code></p>`
  const frame = context.sourceFrames.get(`${location.file}:${location.line}`)
  if (frame === undefined) return html`${where}<p class="muted small">The code is not shown: no approved source from the run's loaded test bundle and redactor is available.</p>`
  if (!frame.ok) return html`${where}<p class="muted small">The code is not shown: ${frame.problem}.</p>`
  const width = String(frame.lines.at(-1)?.number ?? location.line).length
  const rows = frame.lines.map((line) => {
    const number = String(line.number).padStart(width)
    return html`<div${line.marked ? html` class="marked"` : ''}><span class="line-number">${number}</span>${line.text}</div>`
  })
  return html`${where}<div class="code" role="group" aria-label="The test's code around this line">${rows}</div>`
}
