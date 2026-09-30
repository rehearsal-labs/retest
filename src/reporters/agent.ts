import type { Failure } from '../protocol/failures.ts'
import type { RunResult, TestResult } from '../protocol/result.ts'
import type { Reporter } from './reporter.ts'
import type { Writer } from './style.ts'
import { formatLine } from '../protocol/location.ts'
import { describeLocator } from '../protocol/locator.ts'
import { formatInspectCommand } from './commands.ts'
import {
  callLocator,
  callName,
  describeFileProblem,
  describeWait,
  failureCards,
  messageRepeatsValues,
  notRunReason,
  recordedValues,
  runFailureToShow,
  testsNotRun,
  unshownDetails,
  type FailureCard,
} from './failure-card.ts'
import {
  countParts,
  formatDetail,
  formatDuration,
  messageLines,
  quoteRecorded,
  runNotes,
  titleWithin,
  totalTests,
} from './format.ts'
import {
  describeHostCheck,
  describeHostCheckWait,
  hostCheckExpectation,
  hostCheckHeading,
  hostCheckMessageRepeats,
  hostCheckPage,
  type FailedHostCheck,
} from './host-checks.ts'
import { RunRecord } from './run-record.ts'
import { acrossTargets, runTargets, targetSummaries, variantLabel, type RunTargets } from './targets.ts'

export type AgentReporterOptions = { stdout: Writer; runFolder: string }

/**
 * The short report for a coding agent, printed once the run ends: counts, one block per failure, and a
 * `next:` line with the command that shows more.
 *
 * @example runFiles(options, [createAgentReporter({ stdout, runFolder })])
 */
export function createAgentReporter(options: AgentReporterOptions): Reporter {
  const record = new RunRecord()
  return {
    name: 'agent',
    onEvent(event) {
      record.add(event)
    },
    onRunEnd(result) {
      options.stdout.write(renderAgentReport(result, record, options.runFolder))
    },
  }
}

function renderAgentReport(result: RunResult, record: RunRecord, runFolder: string): string {
  const targets = runTargets(record, result)
  const cards = failureCards(result, { record, runFolder, targets })
  const lines = [firstLine(result, targets), ...runFailureLines(result)]
  for (const card of cards) lines.push(...cardLines(card))
  for (const test of testsNotRun(result)) lines.push(...notRunLines(test, notRunReason(result, test), targets))
  const first = cards.find((card) => card.test !== undefined)?.test
  lines.push(`next: ${formatInspectCommand({ runFolder, testId: first?.testId, targets: first?.targets, json: true })}`)
  return `${lines.join('\n')}\n`
}

function firstLine(result: RunResult, targets: RunTargets): string {
  const total = totalTests(result.counts)
  const across = acrossTargets(targetSummaries(result, targets).length)
  const counted = total === 0 ? 'no tests ran' : `${countParts(result.counts).join(', ')} (${total})${across}`
  const notes = runNotes(result).map((note) => `, ${note}`)
  return `retest: ${counted} in ${formatDuration(result.durationMs)}, exit ${result.exitCode}${notes.join('')}`
}

function runFailureLines(result: RunResult): string[] {
  const failure = runFailureToShow(result)
  if (failure === undefined) return []
  const details = Object.entries(failure.details ?? {}).map(([key, value]) => `${key} ${formatDetail(value)}`)
  const lines = [...failureText(failure), ...details]
  return lines.map((line, index) => (index === 0 ? `run failed: ${line}` : `  ${line}`))
}

function cardLines(card: FailureCard): string[] {
  const status = card.test?.status === 'failed' ? 'fail' : 'error'
  const where = card.location === undefined ? card.file : formatLine(card.location)
  const subject = card.test === undefined ? describeFileProblem(card.fileProblem) : titleWithin(card.test.name, card.test.describePath)
  return [
    `${status} ${where} ${subject}${bracketed(card.variant)}`,
    ...(card.hostCheck === undefined ? failureLines(card) : hostCheckLines(card.hostCheck)),
    ...unshownDetails(card).map(([key, value]) => `  ${key} ${formatDetail(value)}`),
    ...card.alsoFailedChecks.flatMap(hostCheckLines),
    ...card.notRunChecks.map(({ check, app }) => `  not run host check ${describeHostCheck(check, app)}`),
    ...card.screenshots.map((path) => `  screenshot ${path}`),
    ...card.evidenceProblems.map((problem) => `  screenshot not saved: ${problem}`),
    ...card.cleanupFailures.flatMap((cleanup) => indent(failureText(cleanup))),
  ]
}

function failureLines(card: FailureCard): string[] {
  const { failure, call, test } = card
  const failureClass = failure?.class ?? test?.status ?? 'collection_failed'
  if (call === undefined) return indent(failure === undefined ? [failureClass] : failureText(failure))
  const recipe = callLocator(call)
  const locator = recipe === undefined ? '' : ` ${describeLocator(recipe)}`
  const lines = [`  ${failureClass} ${callName(call)}${locator}`]
  if (failure !== undefined && !messageRepeatsValues(card)) lines.push(...indent(messageLines(failure.message)))
  const waited = `waited ${describeWait(call, milliseconds)}`
  const values = recordedValues(call)
  lines.push(values === undefined ? `  ${waited}` : `  expected ${quoteRecorded(values.expected)} received ${quoteRecorded(values.actual)} ${waited}`)
  if (call.type === 'assertion.failed' && call.comparison !== undefined) lines.push(`  compared ${call.comparison}`)
  return lines
}

// One line for what the check asked and what the page showed, then its message when it says more, then its looks.
function hostCheckLines(check: FailedHostCheck): string[] {
  const { failure, looked } = check
  const page = looked === undefined ? '' : `, page ${hostCheckPage(check.check, looked.actual)}`
  const lines = [`  ${failure.class} ${hostCheckHeading(check.check, check.app)} expected ${hostCheckExpectation(check.check)}${page}`]
  if (!hostCheckMessageRepeats(check)) lines.push(...indent(messageLines(failure.message)))
  if (looked !== undefined) lines.push(`  waited ${describeHostCheckWait(looked, milliseconds)}`)
  return lines
}

function notRunLines(test: TestResult, reason: Failure | undefined, targets: RunTargets): string[] {
  const heading = `not run ${formatLine(test.location)} ${titleWithin(test.name, test.describePath)}${bracketed(variantLabel(test.variant, targets))}`
  return reason === undefined ? [heading] : [heading, ...indent(failureText(reason))]
}

// A failure as `class message`, one line per line of its message.
function failureText(failure: Failure): string[] {
  return messageLines(`${failure.class} ${failure.message}`)
}

function bracketed(label: string | undefined): string {
  return label === undefined ? '' : ` [${label}]`
}

function indent(lines: readonly string[]): string[] {
  return lines.map((line) => `  ${line}`)
}

function milliseconds(value: number): string {
  return `${Math.round(value)}ms`
}
