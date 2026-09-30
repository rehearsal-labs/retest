import type { Failure } from '../protocol/failures.ts'
import type { RunResult, TestResult } from '../protocol/result.ts'
import type { Reporter } from './reporter.ts'
import type { Writer } from './style.ts'
import { describeLocator } from '../protocol/locator.ts'
import { formatInspectCommand } from './commands.ts'
import {
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
import { countParts, formatDetail, formatDuration, formatLine, quoteRecorded, runNotes, totalTests } from './format.ts'
import { RunRecord } from './run-record.ts'

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
  const cards = failureCards(result, { record, runFolder })
  const lines = [firstLine(result), ...runFailureLines(result)]
  for (const card of cards) lines.push(...cardLines(card))
  for (const test of testsNotRun(result)) lines.push(...notRunLines(test, notRunReason(result, test)))
  const testId = cards.find((card) => card.test !== undefined)?.test?.testId
  lines.push(`next: ${formatInspectCommand({ runFolder, testId, json: true })}`)
  return `${lines.join('\n')}\n`
}

function firstLine(result: RunResult): string {
  const total = totalTests(result.counts)
  const counted = total === 0 ? 'no tests ran' : `${countParts(result.counts).join(', ')} (${total})`
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
  const subject = card.test === undefined ? describeFileProblem(card.fileProblem) : card.test.name
  return [
    `${status} ${where} ${subject}`,
    ...failureLines(card),
    ...unshownDetails(card).map(([key, value]) => `  ${key} ${formatDetail(value)}`),
    ...card.screenshots.map((path) => `  screenshot ${path}`),
    ...card.evidenceProblems.map((problem) => `  screenshot not saved: ${problem}`),
    ...card.cleanupFailures.flatMap((cleanup) => indent(failureText(cleanup))),
  ]
}

function failureLines(card: FailureCard): string[] {
  const { failure, call, test } = card
  const failureClass = failure?.class ?? test?.status ?? 'collection_failed'
  if (call === undefined) return indent(failure === undefined ? [failureClass] : failureText(failure))
  const locator = call.locator === undefined ? '' : ` ${describeLocator(call.locator)}`
  const lines = [`  ${failureClass} ${callName(call)}${locator}`]
  if (failure !== undefined && !messageRepeatsValues(card)) lines.push(...indent(failure.message.split('\n')))
  const waited = `waited ${describeWait(call, milliseconds)}`
  const values = recordedValues(call)
  lines.push(values === undefined ? `  ${waited}` : `  expected ${quoteRecorded(values.expected)} received ${quoteRecorded(values.actual)} ${waited}`)
  if (call.type === 'assertion.failed' && call.comparison !== undefined) lines.push(`  compared ${call.comparison}`)
  return lines
}

function notRunLines(test: TestResult, reason: Failure | undefined): string[] {
  const heading = `not run ${formatLine(test.location)} ${test.name}`
  return reason === undefined ? [heading] : [heading, ...indent(failureText(reason))]
}

// A failure as `class message`, one line per line of its message.
function failureText(failure: Failure): string[] {
  return `${failure.class} ${failure.message}`.split('\n')
}

function indent(lines: readonly string[]): string[] {
  return lines.map((line) => `  ${line}`)
}

function milliseconds(value: number): string {
  return `${Math.round(value)}ms`
}
