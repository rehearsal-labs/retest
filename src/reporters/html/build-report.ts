import type { JsonValue } from '../../evaluation/contract.ts'
import type { ReportContext, ReportInput } from './report-context.ts'
import type { TestEntry } from './test-view.ts'
import { readReportCodeFrame, type CodeFrame } from '../code-frame.ts'
import { failureCards, testCard } from '../failure-card.ts'
import { recordEvents } from '../run-record.ts'
import { runTargets } from '../targets.ts'
import { ArtifactFiles } from './artifact-files.ts'
import { testEvidence } from './evidence-status.ts'
import { folderView } from './folder-view.ts'
import { dataBlock, html } from './markup.ts'
import { page } from './page.ts'
import { fileProblemView, overviewView, runStatusWord, runSummaryView } from './summary-view.ts'
import { failingTestView, otherTestView } from './test-view.ts'

export type { ReportInput, ResultSource } from './report-context.ts'

/** The version of the outcome data block's shape. A key added later keeps it; a key changed or removed raises it. */
export const outcomeDataVersion = 1

/**
 * A run's report as one HTML document, made from its result and its events alone, with the run folder's files read
 * through the safe read and linked by their paths inside the folder. It says how the run ended, then what failed, each
 * failure with its check, its values and its screenshot first; then every test in a table; then the tests that did not
 * fail, closed. How much of the evidence is here is said apart from how each test ended, and what is missing is named
 * where it would have been. The same outcome facts travel in a JSON data block, `retest-outcome`, for a program that
 * reads the file.
 *
 * @example writeFileSync(join(folder, 'report.html'), await buildReport({ directory: folder, shown, source: 'result.json', result, events, warnings: [] }))
 */
export async function buildReport(input: ReportInput): Promise<string> {
  const record = recordEvents(input.events)
  const targets = runTargets(record, input.result)
  const context: ReportContext = { input, record, targets, rootDir: record.started?.rootDir, files: new ArtifactFiles(input.directory), sourceFrames: new Map() }
  const cardOptions = { record, runFolder: input.shown, targets }
  const entries: TestEntry[] = input.result.files.flatMap((file) => file.tests).map((test, index) => {
    const events = record.test(test.testId, test.variantKey)?.events ?? []
    const failing = test.status === 'failed' || test.status === 'error' || test.status === 'inconclusive'
    return { test, id: `test-${index + 1}`, events, card: failing ? testCard(test, cardOptions) : undefined, evidence: testEvidence(test, events, context.files) }
  })
  const cards = failureCards(input.result, cardOptions)
  const sources = new Map<string, CodeFrame>()
  if (context.rootDir !== undefined && input.redactText !== undefined) {
    const approved = new Set(input.result.files.flatMap((file) => file.tests.filter((test) => test.execution?.bundle?.modules.some((module) => module.path === file.file) === true).map(() => file.file)))
    for (const card of cards) {
      const location = card.location
      if (location === undefined || !approved.has(location.file)) continue
      try {
        sources.set(`${location.file}:${location.line}`, await readReportCodeFrame(context.rootDir, location, input.redactText))
      } catch {
        sources.set(`${location.file}:${location.line}`, { ok: false, problem: 'the source could not be read safely' })
      }
    }
  }
  context.sourceFrames = sources
  const fileProblems = cards.filter((card) => card.fileProblem !== undefined).map((card, index) => fileProblemView(card, `file-${index + 1}`, context))
  const failing = entries.filter((entry) => entry.card !== undefined).map((entry) => failingTestView(entry, context))
  const others = entries.filter((entry) => entry.card === undefined).map((entry) => otherTestView(entry, context))
  const failures = fileProblems.length + failing.length === 0 ? undefined : html`<section aria-labelledby="failures"><h2 id="failures">Failures</h2>${fileProblems}${failing}</section>`
  const rest = others.length === 0 ? undefined : html`<section aria-labelledby="other-tests"><h2 id="other-tests">Other tests</h2>${others}</section>`
  const { result } = input
  const body = html`<main data-run-id="${result.runId}" data-status="${result.status}" data-exit-code="${result.exitCode}" data-complete="${String(result.complete)}" data-source="${input.source}">${runSummaryView(entries, context)}${failures}<section aria-labelledby="all-tests"><h2 id="all-tests">All tests</h2>${overviewView(entries, context)}</section>${rest}${folderView(context)}</main>`
  return page({ title: `Retest run ${result.runId}: ${runStatusWord(result.status)}`, body, data: [dataBlock('retest-outcome', outcomeData(input, entries)), dataBlock('retest-recording-clocks', recordingClocks(entries))] })
}

/** Recording clocks and identities are data only. Generated element ids avoid selectors made from run text. */
function recordingClocks(entries: readonly TestEntry[]): JsonValue {
  return {
    version: 1,
    tests: entries.map(({ id, test }) => ({
      elementId: id,
      testId: test.testId,
      name: test.name,
      recordings: (test.recordings ?? []).map((recording) => ({
        recordingId: recording.recordingId,
        app: recording.app,
        sessionId: recording.sessionId,
        path: recording.path ?? null,
        clock: recording.clock === undefined ? null : {
          capture: recording.clock.capture,
          videoZeroUs: recording.clock.videoZeroUs,
          durationUs: recording.clock.durationUs,
          shortened: recording.clock.shortened.map((gap) => ({ ...gap })),
          shortenedCount: recording.clock.shortenedCount,
        },
      })),
    })),
  }
}

/**
 * The outcome facts the page shows, as data: the run's status, exit code, completeness, counts and where its result was
 * read from, and each test's id, name, variant, status, failure class and evidence state, in run order. Every value is
 * the result's own or the evidence state the page shows; nothing is added.
 */
function outcomeData(input: ReportInput, entries: readonly TestEntry[]): JsonValue {
  const { result, source } = input
  const { passed, failed, error, notRun, inconclusive, skipped } = result.counts
  return {
    version: outcomeDataVersion,
    runId: result.runId,
    status: result.status,
    exitCode: result.exitCode,
    complete: result.complete,
    source,
    counts: { passed, failed, error, notRun, inconclusive, ...(skipped === undefined ? {} : { skipped }) },
    tests: entries.map(({ test, evidence }) => ({
      testId: test.testId,
      name: test.name,
      ...(test.variantKey === undefined ? {} : { variantKey: test.variantKey }),
      status: test.status,
      ...(test.failure === undefined ? {} : { failureClass: test.failure.class }),
      evidence: evidence.status.state,
    })),
  }
}
