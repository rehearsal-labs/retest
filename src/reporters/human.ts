import type { TestStatus } from '../protocol/events.ts'
import type { EvidenceGap, EvidenceStatus, RunEvidenceStatus } from '../protocol/recording.ts'
import type { RunResult } from '../protocol/result.ts'
import type { ChildOutput } from '../runner/contract.ts'
import type { Reporter } from './reporter.ts'
import { diagnosticsLocation, diagnosticsTotals } from '../diagnostics/report.ts'
import { countEvaluations } from '../evaluation/report.ts'
import { variantKey } from '../protocol/variant.ts'
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
import {
  countParts,
  describeAppEvent,
  describeBorrowedSetup,
  describeHolders,
  describeLeaseExpired,
  describeLocks,
  describeNarrowed,
  describeResources,
  describeSessions,
  describeStateEvent,
  failureLabel,
  formatDetail,
  formatDuration,
  messageLines,
  plural,
  runNotes,
  testTitle,
  titleWithin,
} from './format.ts'
import { countHostChecks } from './host-checks.ts'
import { renderCard } from './human-card.ts'
import { RunRecord, type EventOfType, type TestRecord } from './run-record.ts'
import { createStyle, visibleLength, type Style, type Writer } from './style.ts'
import {
  acrossTargets,
  describeBrowser,
  describeProxy,
  runTargets,
  targetSummaries,
  variantLabel,
  type RunTargets,
  type TargetSummary,
} from './targets.ts'

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
 * Prints each test as it finishes, then one card per failure and a summary. Servers, browsers and sign-in states
 * get one quiet line each, and a state's contents never appear.
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
  const shownGaps = new Set<string>()
  const gapKey = (attemptId: string, gap: EvidenceGap): string => JSON.stringify([attemptId, gap.code, gap.app, gap.sessionId, gap.message])

  const head = (): void => {
    if (headed) return
    headed = true
    const version = record.started === undefined ? '' : ` ${record.started.retestVersion}`
    const compatibility = record.started?.options.playwright === true ? ', playwright compatibility' : ''
    const shown = record.browser?.app === undefined ? record.browser : undefined
    const several = shown?.instances === undefined ? '' : ` · ${shown.instances} browsers`
    const browser = shown === undefined ? '' : `  ${style.dim(`${describeBrowser(shown)}${several}`)}`
    write(`\n  ${style.bold('retest')}${version}${compatibility}${browser}\n`)
  }

  return {
    name: 'human',
    onEvent(event) {
      record.add(event)
      switch (event.type) {
        case 'native.started':
          write(`  ${style.dim(`${event.product} on ${event.identity.platform === 'macos' ? 'macOS' : `iOS Simulator ${event.identity.os.version}`}`)}\n`)
          break
        case 'browser.started': {
          // A target's further browsers are in the events; its first line says how many there are.
          if (event.instance !== undefined) return
          const inHeader = !headed && event.app === undefined
          head()
          if (!inHeader) write(`  ${style.dim(browserLine(event))}\n`)
          return
        }
        case 'app.started':
        case 'app.reused':
          head()
          write(`  ${style.dim(`${event.app}  ${describeAppEvent(event)}`)}\n`)
          return
        case 'app.failed':
          head()
          write(`  ${style.red('✗')} ${event.app}  ${style.dim(describeAppEvent(event))}\n`)
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
          const test = record.test(event.testId, event.variantKey)
          write(testLines(event, test, { style, targets: runTargets(record) }))
          if (event.evidenceStatus?.state === 'partial' || event.evidenceStatus?.state === 'unavailable') {
            for (const gap of event.evidenceStatus.gaps ?? []) shownGaps.add(gapKey(event.attemptId, gap))
          }
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
      const targets = runTargets(record, result)
      for (const card of failureCards(result, { record, runFolder, targets })) {
        write(`\n${renderCard(card, { style, runFolder, rootDir })}`)
      }
      write(notRunLines(result, targets, style))
      write(runFailureLines(result, style))
      // A cut-off recording's gaps exist only in the rebuilt result. Print those too, without repeating
      // reasons already shown under a finished test, and retain the attempt and app they belong to.
      for (const file of result.files) for (const test of file.tests) {
        const gaps = [...(test.evidenceStatus?.gaps ?? []), ...(test.recordings ?? []).flatMap(recording => recording.gaps)]
          .filter(gap => {
            const key = gapKey(test.attemptId, gap)
            if (shownGaps.has(key)) return false
            shownGaps.add(key)
            return true
          })
        if (gaps.length > 0) {
          const variant = variantLabel(test.variant, targets)
          write(`\n  ${style.yellow('!')} ${test.file} › ${test.name}${variant === undefined ? '' : ` [${variant}]`}\n`)
          write(gapLines(gaps, style))
        }
      }
      if ((result.evidenceStatus?.gaps?.length ?? 0) > 0) {
        write(`\n  ${style.yellow('!')} Run evidence\n${gapLines(result.evidenceStatus?.gaps ?? [], style)}`)
      }
      if (result.narrowed !== undefined) write(`\n  ${style.yellow('!')} ${describeNarrowed(result.narrowed)}\n`)
      write(summaryLines(result, { record, targets, runFolder, style }))
    },
  }
}

// Milestone 1's one browser has no app or target; a browser a config started names the one it serves, and the
// proxy its pages go through. The line says what happened, at the run's indent beside the app lines: a browser
// may start before any file is collected, and the tests after it are not all the ones that ran in it.
function browserLine(browser: EventOfType<'browser.started'>): string {
  const { app, target } = browser
  const described = describeBrowser(browser)
  const several = browser.instances === undefined ? '' : ` · ${browser.instances} browsers`
  if (app === undefined || target === undefined) return `started ${described}${several}`
  const proxy = target.proxy === undefined ? '' : ` · ${describeProxy(target.proxy)}`
  return `started ${variantKey({ [app]: target.name })}  ${described}${proxy}${several}`
}

type LineContext = { style: Style; targets: RunTargets }

function testLines(event: EventOfType<'test.finished'>, test: TestRecord | undefined, context: LineContext): string {
  const { style } = context
  const marks: Record<TestStatus, string> = {
    passed: style.green('✓'),
    failed: style.red('✗'),
    error: style.yellow('!'),
    not_run: style.dim('-'),
    inconclusive: style.yellow('?'),
    skipped: style.dim('○'),
  }
  const name = test === undefined ? event.testId : titleWithin(test.name, test.describePath)
  const setup = test?.setup === true ? ` ${style.dim('(setup)')}` : ''
  const label = variantLabel(test?.variant, context.targets)
  const variant = label === undefined ? '' : `  ${style.cyan(label)}`
  const after = event.status === 'not_run' ? 'not run' : event.status === 'skipped' ? 'skipped' : formatDuration(event.durationMs)
  const borrowed = test?.setupFor === undefined || event.status === 'not_run' ? [] : [describeBorrowedSetup(test.name, test.file, test.setupFor)]
  const states = (test?.events ?? []).flatMap((noted) => {
    if (noted.type === 'state.saved' || noted.type === 'state.restored') return [describeStateEvent(noted)]
    if (noted.type === 'session.reserved' && noted.attemptId === event.attemptId) return [describeSessions(noted)]
    if (noted.type === 'lease.expired' && noted.attemptId === event.attemptId) return [describeLeaseExpired(noted)]
    if (noted.type === 'resource.acquired' && noted.attemptId === event.attemptId) return waitNotes(describeResources(noted), noted)
    return noted.type === 'lock.acquired' && noted.attemptId === event.attemptId ? waitNotes(describeLocks(noted), noted) : []
  })
  const notes = [...borrowed, ...states].map((note) => `      ${style.dim(note)}\n`)
  // An advisory AI check that did not pass is a warning, shown whatever the test's status.
  const warnings = (test?.events ?? []).flatMap((noted) => (noted.type === 'evaluation.finished' && noted.attemptId === event.attemptId && noted.evaluation.warning !== undefined ? [noted.evaluation.warning] : []))
  const warned = warnings.map((warning) => `      ${style.yellow('!')} ${warning}\n`)
  return `    ${marks[event.status]} ${name}${setup}${variant}  ${style.dim(after)}\n${notes.join('')}${warned.join('')}${evidenceLines(event.evidenceStatus, style)}`
}

// Evidence that is not complete is said under its test, apart from the test's mark, with each thing it lacks; complete
// evidence, or none asked for, adds nothing.
function evidenceLines(status: EvidenceStatus | undefined, style: Style): string {
  if (status === undefined || status.state === 'complete' || status.state === 'not_requested') return ''
  return `      ${style.yellow('!')} ${style.dim(`evidence ${status.state}`)}\n${gapLines(status.gaps ?? [], style)}`
}

function gapLines(gaps: readonly EvidenceGap[], style: Style): string {
  return gaps.map(gap => `        ${style.dim(`${gap.app === undefined ? '' : `${gap.app}: `}${gap.code}: ${gap.message}`)}\n`).join('')
}

// What an attempt took and, when it had to wait, who held it as it asked: a line of its own under the first.
function waitNotes(line: string, event: { waitedMs: number; heldBy?: readonly string[] | undefined; heldElsewhere?: number | undefined }): string[] {
  const holders = event.waitedMs === 0 ? undefined : describeHolders(event)
  return holders === undefined ? [line] : [line, holders]
}

function notRunLines(result: RunResult, targets: RunTargets, style: Style): string {
  const tests = testsNotRun(result)
  if (tests.length === 0) return ''
  const lines = tests.map((test) => {
    const reason = notRunReason(result, test)
    const label = variantLabel(test.variant, targets)
    const variant = label === undefined ? '' : `  ${style.cyan(label)}`
    return `    ${testTitle(test.file, test.name, test.describePath)}${variant}${reason === undefined ? '' : `  ${style.dim(messageLines(reason.message).join('\n'))}`}`
  })
  return `\n  ${style.bold('Not run')}\n${lines.join('\n')}\n`
}

function runFailureLines(result: RunResult, style: Style): string {
  const failure = runFailureToShow(result)
  if (failure === undefined) return ''
  const details = Object.entries(failure.details ?? {}).map(([key, value]) => `${key}  ${formatDetail(value)}`)
  const lines = [style.red(failureLabel(failure.class)), ...messageLines(failure.message), ...details]
  return `\n  ${style.bold('Run failed')}\n${lines.map((line) => `    ${line}`).join('\n')}\n`
}

type SummaryContext = { record: RunRecord; targets: RunTargets; runFolder: string; style: Style }

function summaryLines(result: RunResult, context: SummaryContext): string {
  const { style } = context
  const summaries = targetSummaries(result, context.targets)
  const rows: [string, string][] = [['Tests', `${countParts(result.counts).join(' · ') || 'none'}${acrossTargets(summaries.length)}`]]
  const checks = countChecks(context.record)
  if (checks.length > 0) rows.push(['Checks', checks.join(' · ')])
  const hostChecks = countHostChecks(result.files.flatMap((file) => file.tests))
  if (hostChecks.length > 0) rows.push(['Host checks', hostChecks.join(' · ')])
  const evaluations = countEvaluations(result.files.flatMap((file) => file.tests))
  if (evaluations.length > 0) rows.push(['AI checks', evaluations.join(' · ')])
  const diagnostics = diagnosticsTotals(result.files.flatMap((file) => file.tests))
  if (diagnostics !== undefined) rows.push(['Diagnostics', [...diagnostics, diagnosticsLocation(context.runFolder)].join(' · ')])
  const files = fileProblemCounts(result)
  if (files.length > 0) rows.push(['Files', files.join(' · ')])
  if (result.evidenceStatus !== undefined) rows.push(['Evidence', describeEvidence(result.evidenceStatus)])
  rows.push(['Time', formatDuration(result.durationMs)], ['Output', context.runFolder])
  const notes = runNotes(result)
  const exit = `${result.exitCode}${notes.length === 0 ? '' : ` · ${notes.join(', ')}`}`
  rows.push(['Exit', result.exitCode === 0 ? style.green(exit) : style.red(exit)])
  const width = Math.max(8, ...rows.map(([label]) => label.length + 2))
  const lines = rows.map(([label, value]) => `  ${label.padEnd(width)}${value}`)
  const perTarget = summaries.length > 1 ? `\n${targetLines(summaries, style).join('\n')}\n` : ''
  return `${perTarget}\n${lines.join('\n')}\n\n`
}

// The run's evidence on one line: its state, how many attempts ended each way, and whether the run required it.
function describeEvidence(status: RunEvidenceStatus): string {
  const { complete, partial, unavailable, notRequested } = status.attempts
  const counts = [[complete, 'complete'], [partial, 'partial'], [unavailable, 'unavailable'], [notRequested, 'not recorded']] as const
  const parts = counts.flatMap(([count, label]) => (count === 0 ? [] : [`${count} ${label}`]))
  return [status.state === 'not_requested' ? 'nothing recorded' : status.state, ...parts, ...(status.required === true ? ['required'] : [])].join(' · ')
}

// One line per target, as the columns of a table: the variant, its browser, how its tests ended and their time.
function targetLines(summaries: readonly TargetSummary[], style: Style): string[] {
  const rows = summaries.map((summary) => ({
    label: summary.label,
    browser: summary.browser,
    outcome: `${targetMark(summary, style)} ${countParts(summary.counts).join(' · ')}`,
    time: formatDuration(summary.durationMs),
  }))
  const width = (pick: (row: (typeof rows)[number]) => string): number => Math.max(...rows.map((row) => visibleLength(pick(row))))
  const labelWidth = width((row) => row.label)
  const browserWidth = width((row) => row.browser)
  const outcomeWidth = width((row) => row.outcome)
  return rows.map((row) =>
    [
      `  ${style.cyan(row.label.padEnd(labelWidth))}`,
      ...(browserWidth === 0 ? [] : [style.dim(row.browser.padEnd(browserWidth))]),
      `${row.outcome}${' '.repeat(outcomeWidth - visibleLength(row.outcome))}`,
      style.dim(row.time),
    ].join('  '),
  )
}

function targetMark(summary: TargetSummary, style: Style): string {
  const { counts } = summary
  if (counts.failed > 0) return style.red('✗')
  if (counts.error > 0 || counts.notRun > 0) return style.yellow('!')
  if (counts.inconclusive > 0) return style.yellow('?')
  return style.green('✓')
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
