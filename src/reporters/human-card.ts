import { truncateText, type SourceLocation, type TruncatedText } from '../protocol/failures.ts'
import { describeLocator } from '../protocol/locator.ts'
import { readCodeFrame } from './code-frame.ts'
import { formatInspectCommand } from './commands.ts'
import { diffLines } from './diff.ts'
import {
  callName,
  describeFileProblem,
  describeWait,
  messageRepeatsValues,
  recordedValues,
  unshownDetails,
  type FailureCard,
  type RecordedValues,
} from './failure-card.ts'
import {
  failureLabel,
  formatDetail,
  formatDuration,
  formatLocation,
  quoteRecorded,
  shownValueLength,
  statusLabel,
} from './format.ts'
import type { Style } from './style.ts'

export type HumanCardOptions = {
  style: Style
  runFolder: string
  /** The run's root directory, which the code frame reads from. Without it there is no code frame. */
  rootDir: string | undefined
}

const indent = '    '
const labelWidth = 17
const maxDiffLines = 40

/**
 * A failure as one block of terminal text: what failed, the values, the wait, the code and the next
 * commands.
 *
 * @example stdout.write(renderCard(card, { style, runFolder, rootDir }))
 */
export function renderCard(card: FailureCard, options: HumanCardOptions): string {
  const { style } = options
  const lines = [heading(card, style), '', ...summary(card, style)]
  if (card.location !== undefined && options.rootDir !== undefined) {
    lines.push('', ...frame(options.rootDir, card.location, style))
  }
  lines.push('', ...closing(card, options))
  return `${lines.join('\n')}\n`
}

function heading(card: FailureCard, style: Style): string {
  const after = card.test === undefined ? describeFileProblem(card.fileProblem) : formatDuration(card.test.durationMs)
  return `  ${style.red('✗')} ${style.bold(card.title)}  ${style.dim(after)}`
}

function summary(card: FailureCard, style: Style): string[] {
  const { failure, call } = card
  const values = recordedValues(call)
  const lines = [field(style.red(style.bold(headline(card))), call === undefined ? '' : callName(call))]
  if (failure !== undefined && !messageRepeatsValues(card)) lines.push(...failure.message.split('\n').map((line) => indent + line))
  if (call?.locator !== undefined) lines.push(field('Locator', describeLocator(call.locator)))
  if (call?.pageUrl !== undefined) lines.push(field('Page', call.pageUrl))
  if (values !== undefined) lines.push(...valueLines(values, style))
  if (call?.type === 'assertion.failed' && call.comparison !== undefined) lines.push(field('Compared', call.comparison))
  if (call !== undefined) lines.push(field('Waited', describeWait(call, formatDuration)))
  for (const [key, value] of unshownDetails(card)) lines.push(field(key, formatDetail(value)))
  return lines
}

function headline(card: FailureCard): string {
  if (card.failure !== undefined) return failureLabel(card.failure.class)
  return card.test === undefined ? failureLabel('collection_failed') : statusLabel(card.test.status)
}

function valueLines(values: RecordedValues, style: Style): string[] {
  const { expected, actual } = values
  if (!expected.text.includes('\n') && !actual.text.includes('\n')) {
    return [field(style.green('- Expected'), quoteRecorded(expected)), field(style.red('+ Received'), quoteRecorded(actual))]
  }
  const diff = diffLines(shown(expected), shown(actual))
  const lines = [field(style.green('- Expected'), ''), field(style.red('+ Received'), ''), '']
  for (const line of diff.slice(0, maxDiffLines)) {
    if (line.kind === 'same') lines.push(`${indent}  ${line.text}`)
    else if (line.kind === 'expected') lines.push(style.green(`${indent}- ${line.text}`))
    else lines.push(style.red(`${indent}+ ${line.text}`))
  }
  if (diff.length > maxDiffLines) lines.push(style.dim(`${indent}… ${diff.length - maxDiffLines} more lines`))
  lines.push(...cutNote('Expected', expected, style), ...cutNote('Received', actual, style))
  return lines
}

function shown(value: TruncatedText): string {
  return truncateText(value.text, shownValueLength).text
}

function cutNote(label: string, value: TruncatedText, style: Style): string[] {
  const shownLength = shown(value).length
  if (shownLength === value.length) return []
  return [style.dim(`${indent}${label} shows ${shownLength} of ${value.length} characters.`)]
}

function frame(rootDir: string, location: SourceLocation, style: Style): string[] {
  const where = `${indent}${style.dim(formatLocation(location))}`
  const code = readCodeFrame(rootDir, location)
  if (!code.ok) return [`${where}  ${style.dim(`(${code.problem})`)}`]
  const width = String(code.lines.at(-1)?.number ?? location.line).length
  const lines = code.lines.map((line) => {
    const number = String(line.number).padStart(width)
    const text = line.text === '' ? '' : ` ${line.text}`
    return line.marked
      ? `${indent}${style.red('›')} ${style.bold(`${number} │`)}${text}`
      : `${indent}  ${style.dim(`${number} │`)}${text}`
  })
  return [where, ...lines]
}

function closing(card: FailureCard, options: HumanCardOptions): string[] {
  const lines = card.screenshots.map((path) => field('Screenshot', path))
  for (const problem of card.evidenceProblems) lines.push(field('Screenshot', `not saved: ${problem}`))
  for (const failure of card.cleanupFailures) {
    lines.push(field(options.style.red(failureLabel(failure.class)), failure.message))
  }
  if (card.rerun !== undefined) lines.push(field('Rerun', card.rerun))
  const inspect = formatInspectCommand({ runFolder: options.runFolder, testId: card.test?.testId })
  lines.push(field('Inspect', inspect))
  return lines
}

// Labels may carry colour codes, so the padding counts only the visible characters.
function field(label: string, value: string): string {
  const visible = label.replace(/\u001b\[\d+m/g, '').length
  const gap = ' '.repeat(Math.max(2, labelWidth - visible))
  return value === '' ? `${indent}${label}` : `${indent}${label}${gap}${value}`
}
