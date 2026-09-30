import type { TestStatus } from '../protocol/events.ts'
import type { RunResult } from '../protocol/result.ts'
import type { ChildOutput } from '../runner/contract.ts'
import type { Reporter } from './reporter.ts'
import { createChildEcho } from './child-output.ts'
import {
  describeFileProblem,
  failureCards,
  fileProblemOf,
  notRunReason,
  runFailureToShow,
  testsNotRun,
  type FileProblem,
} from './failure-card.ts'
import { countParts, failureLabel, formatDetail, formatDuration, plural, runNotes, testTitle } from './format.ts'
import { renderCard } from './human-card.ts'
import { RunRecord, type EventOfType } from './run-record.ts'
import { createStyle, type Style, type Writer } from './style.ts'

export type HumanReporterOptions = {
  stdout: Writer
  stderr: Writer
  color: boolean
  /** The run folder as the person gave it, used in printed paths and commands. */
  runFolder: string
}

/** The terminal report for a person. It also echoes the test files' own output. */
export type HumanReporter = Reporter & { onOutput(output: ChildOutput): void }

/**
 * Prints each test as it finishes, then one card per failure and a summary.
 *
 * @example runFiles(options, [createHumanReporter({ stdout, stderr, color: true, runFolder })])
 */
export function createHumanReporter(options: HumanReporterOptions): HumanReporter {
  const style = createStyle(options.color)
  const record = new RunRecord()
  const echo = createChildEcho({ stdout: options.stdout, stderr: options.stderr, style })
  const write = (text: string): void => {
    options.stdout.write(text)
  }
  let headed = false

  const head = (): void => {
    if (headed) return
    headed = true
    const version = record.started === undefined ? '' : ` ${record.started.retestVersion}`
    const browser = record.browser === undefined ? '' : `  ${style.dim(browserName(record.browser))}`
    write(`\n  ${style.bold('retest')}${version}${browser}\n`)
  }

  return {
    name: 'human',
    onEvent(event) {
      record.add(event)
      switch (event.type) {
        case 'browser.started':
          if (headed) write(`  ${style.dim(browserName(event))}\n`)
          else head()
          return
        case 'collection.completed':
          head()
          write(`\n  ${style.bold(event.file)}  ${style.dim(plural(event.tests.length, 'test'))}\n`)
          return
        case 'collection.failed':
          head()
          write(`\n  ${style.red('✗')} ${style.bold(event.file)}  ${style.dim(describeFileProblem('collection'))}\n`)
          return
        case 'file.failed':
          head()
          write(`  ${style.red('✗')} ${style.bold(event.file)}  ${style.dim(describeFileProblem('process'))}\n`)
          return
        case 'test.finished': {
          head()
          const name = record.tests.get(event.testId)?.name ?? event.testId
          write(testLine(event, name, style))
        }
      }
    },
    onOutput(output) {
      echo.push(output)
    },
    onRunEnd(result) {
      echo.flush()
      head()
      const { runFolder } = options
      const rootDir = record.started?.rootDir
      for (const card of failureCards(result, { record, runFolder })) {
        write(`\n${renderCard(card, { style, runFolder, rootDir })}`)
      }
      write(notRunLines(result, style))
      write(runFailureLines(result, style))
      write(summaryLines(result, record, options.runFolder, style))
    },
  }
}

function browserName(browser: EventOfType<'browser.started'>): string {
  return browser.product.includes(browser.version) ? browser.product : `${browser.product} ${browser.version}`
}

function testLine(event: EventOfType<'test.finished'>, name: string, style: Style): string {
  const marks: Record<TestStatus, string> = {
    passed: style.green('✓'),
    failed: style.red('✗'),
    error: style.yellow('!'),
    not_run: style.dim('-'),
    inconclusive: style.yellow('?'),
  }
  const after = event.status === 'not_run' ? 'not run' : formatDuration(event.durationMs)
  return `    ${marks[event.status]} ${name}  ${style.dim(after)}\n`
}

function notRunLines(result: RunResult, style: Style): string {
  const tests = testsNotRun(result)
  if (tests.length === 0) return ''
  const lines = tests.map((test) => {
    const reason = notRunReason(result, test)
    return `    ${testTitle(test.file, test.name)}${reason === undefined ? '' : `  ${style.dim(reason.message)}`}`
  })
  return `\n  ${style.bold('Not run')}\n${lines.join('\n')}\n`
}

function runFailureLines(result: RunResult, style: Style): string {
  const failure = runFailureToShow(result)
  if (failure === undefined) return ''
  const details = Object.entries(failure.details ?? {}).map(([key, value]) => `${key}  ${formatDetail(value)}`)
  const lines = [style.red(failureLabel(failure.class)), ...failure.message.split('\n'), ...details]
  return `\n  ${style.bold('Run failed')}\n${lines.map((line) => `    ${line}`).join('\n')}\n`
}

function summaryLines(result: RunResult, record: RunRecord, runFolder: string, style: Style): string {
  const lines = [row('Tests', countParts(result.counts).join(' · ') || 'none')]
  const checks = countChecks(record)
  if (checks.length > 0) lines.push(row('Checks', checks.join(' · ')))
  const files = fileProblemCounts(result)
  if (files.length > 0) lines.push(row('Files', files.join(' · ')))
  lines.push(row('Time', formatDuration(result.durationMs)), row('Output', runFolder))
  const notes = runNotes(result)
  const exit = `${result.exitCode}${notes.length === 0 ? '' : ` · ${notes.join(', ')}`}`
  lines.push(row('Exit', result.exitCode === 0 ? style.green(exit) : style.red(exit)))
  return `\n${lines.join('\n')}\n\n`
}

function fileProblemCounts(result: RunResult): string[] {
  const problems = result.files.map(fileProblemOf)
  const counted = (problem: FileProblem): string[] => {
    const count = problems.filter((found) => found === problem).length
    return count === 0 ? [] : [`${plural(count, 'file')} ${describeFileProblem(problem)}`]
  }
  return [...counted('collection'), ...counted('process')]
}

function countChecks(record: RunRecord): string[] {
  let passed = 0
  let failed = 0
  for (const test of record.tests.values()) {
    for (const event of test.events) {
      if (event.type === 'assertion.passed') passed++
      if (event.type === 'assertion.failed') failed++
    }
  }
  return [...(failed > 0 ? [`${failed} failed`] : []), ...(passed > 0 ? [`${passed} passed`] : [])]
}

function row(label: string, value: string): string {
  return `  ${label.padEnd(8)}${value}`
}
