import type { EventBody, RetestEvent, RunStatus, TestStatus } from '../../src/protocol/events.ts'
import type { RunResult } from '../../src/protocol/result.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, test } from 'node:test'
import { eventsFile } from '../../src/protocol/run-folder.ts'
import { titleWithin } from '../../src/reporters/format.ts'
import { readEvents, readRunFolder } from '../../src/store/read-run-folder.ts'
import { fakeCli } from './cli-fixtures.ts'
import { evaluationFramePath, missingEvaluationFramePath, evaluationDiagnosticsPath, extendedEvidenceRun, configFiles, configRun, mp4, png, recordedRun, recordingPath, recordingRecord, reportOf, writeFolder } from './reporters-html-fixtures.ts'
import {
  actionFailureRun,
  cleanupFailureRun,
  collectionFailureRun,
  failingRun,
  lateErrorRun,
  launchFailureRun,
  lostBrowserRun,
  passingRun,
  plain,
  projectFolder,
  resultOf,
  savesTask,
  showsCount,
  stamp,
  timedOutRun,
} from './reporters-fixtures.ts'

// Terminal, JSONL and HTML state the same outcome for the same run folder. For each folder below, the terminal report
// is what `inspect` prints from it, the JSONL facts are what `events.jsonl` says on its own, and the HTML facts are what
// the report shows and marks. Each run's own facts and each test's status must agree across all three.

const root = projectFolder()

// Event sequences the shared fixtures lack: a skipped test, an inconclusive one, a run stopped by a signal, and a run
// whose outcome a reporter changed after `run.finished`.
function bodiesOf(events: readonly RetestEvent[]): EventBody[] {
  return events.map(({ schemaVersion: _version, runId: _run, sequence: _sequence, time: _time, elapsedMs: _elapsed, origin: _origin, ...body }) => body)
}

function skippedRun(): RetestEvent[] {
  const bodies = bodiesOf(passingRun(root))
  const kept = bodies.filter((body) => !('testId' in body && body.testId === showsCount) && body.type !== 'run.finished')
  return stamp([
    ...kept,
    { type: 'test.finished', testId: showsCount, attemptId: 'attempt-2', session: 'page', status: 'skipped', durationMs: 0, assertionCount: 0 },
    { type: 'run.finished', status: 'passed', exitCode: 0, complete: true, counts: { passed: 1, failed: 0, error: 0, notRun: 0, inconclusive: 0, skipped: 1 }, durationMs: 1000 },
  ])
}

function inconclusiveRun(): RetestEvent[] {
  const failure = { class: 'evaluation_inconclusive' as const, message: 'The required AI check task-saved was undecided.' }
  const bodies = bodiesOf(passingRun(root)).map((body): EventBody => {
    if (body.type === 'test.finished' && body.testId === savesTask) return { ...body, status: 'inconclusive', failure }
    if (body.type === 'run.finished') return { ...body, status: 'failed', exitCode: 1, counts: { passed: 1, failed: 0, error: 0, notRun: 0, inconclusive: 1 } }
    return body
  })
  return stamp(bodies)
}

function interruptedRun(): RetestEvent[] {
  const stoppedBy = { class: 'interrupted' as const, message: 'The run was interrupted by SIGINT.' }
  const bodies = bodiesOf(failingRun(root)).filter((body) => !('testId' in body && body.testId === showsCount) && body.type !== 'run.finished')
  return stamp([
    ...bodies,
    { type: 'test.finished', testId: showsCount, attemptId: 'attempt-2', session: 'page', status: 'not_run', durationMs: 0, assertionCount: 0, failure: stoppedBy },
    { type: 'run.finished', status: 'interrupted', exitCode: 130, complete: false, counts: { passed: 0, failed: 1, error: 0, notRun: 1, inconclusive: 0 }, durationMs: 6000, failure: stoppedBy },
  ])
}

function changedOutcomeRun(): { events: RetestEvent[]; result: RunResult } {
  const failing = failingRun(root)
  const broken = { class: 'reporting_failed' as const, message: 'The human reporter failed on the end of the run: disk full' }
  const events = stamp([...bodiesOf(failing), { type: 'run.outcome', status: 'error', exitCode: 2, complete: true, failure: broken }])
  return { events, result: { ...resultOf(failing), status: 'error', exitCode: 2, failure: broken } }
}

type Folder = { name: string; folder: string }

function folders(): Folder[] {
  const finished = (name: string, events: RetestEvent[], files: Readonly<Record<string, Buffer | string>> = {}): Folder => ({ name, folder: writeFolder(root, `agree-${name}`, { events, result: resultOf(events), files }) })
  const screenshot = { 'artifacts/saves-a-task-failure.png': png(8, 8) }
  const failing = failingRun(root)
  const changed = changedOutcomeRun()
  const config = configRun(root)
  return [
    ...(['frames', 'diagnostics'] as const).flatMap((kind) => [true, false].map((partial) => finished(`evaluation-${kind}-${partial ? 'partial' : 'complete'}`, extendedEvidenceRun(root, kind, partial), { ...configFiles(), [evaluationFramePath]: png(8, 8), [evaluationDiagnosticsPath]: '{"console":{"records":[{"id":"c1","text":"saved context"}]}}' }))),
    finished('passed', passingRun(root)),
    finished('failed', failing, screenshot),
    finished('action-failed', actionFailureRun(root)),
    finished('browser-lost', lostBrowserRun(root)),
    finished('cleanup-failed', cleanupFailureRun(root), screenshot),
    finished('timed-out', timedOutRun(root)),
    finished('not-launched', launchFailureRun(root)),
    finished('not-collected', collectionFailureRun(root)),
    finished('late-error', lateErrorRun(root)),
    finished('skipped', skippedRun()),
    finished('inconclusive', inconclusiveRun()),
    finished('interrupted', interruptedRun(), screenshot),
    // The newest shape, which a reader built before this release refuses: a browser's engine and build, a screenshot's
    // source and run-clock time, and sessions on every record.
    finished('newest-shape', config),
    // A recorded run, one recording whole and, in the second, one the media process lost.
    finished('recorded', recordedRun(root), { ...configFiles(), [recordingPath]: mp4() }),
    finished('recording-lost', recordedRun(root, recordingRecord({ status: 'unavailable', gaps: [{ code: 'media_process_lost', message: 'The media process ended while this recording ran.' }] }))),
    { name: 'outcome-changed', folder: writeFolder(root, 'agree-outcome-changed', { ...changed, files: screenshot }) },
    { name: 'cut-mid-test', folder: writeFolder(root, 'agree-cut-mid-test', { events: failing.slice(0, failing.findIndex((event) => event.type === 'assertion.failed')) }) },
    { name: 'cut-before-the-end', folder: writeFolder(root, 'agree-cut-before-the-end', { events: passingRun(root).slice(0, -1) }) },
  ]
}

type RunFacts = { status: RunStatus; exitCode: number; complete: boolean }
type Facts = { run: RunFacts | undefined; tests: Map<string, TestStatus | 'unfinished'> }

/** What `events.jsonl` says on its own: the run's settled outcome, if it has one, and each test's last status. */
function jsonlFacts(folder: string): Facts {
  const reading = readEvents(readFileSync(join(folder, eventsFile), 'utf8'))
  assert.ok(reading.ok)
  const settled = reading.events.findLast((event) => event.type === 'run.outcome') ?? reading.events.findLast((event) => event.type === 'run.finished')
  const tests = new Map<string, TestStatus | 'unfinished'>()
  for (const event of reading.events) {
    if (event.type === 'test.started') tests.set(key(event.testId, event.variantKey), 'unfinished')
    if (event.type === 'test.finished') tests.set(key(event.testId, event.variantKey), event.status)
  }
  const run = settled?.type === 'run.outcome' || settled?.type === 'run.finished' ? { status: settled.status, exitCode: settled.exitCode, complete: settled.complete } : undefined
  return { run, tests }
}

/** What the HTML report marks and shows: the run's outcome, and each test's status and evidence state by its id and variant. */
function htmlFacts(html: string): Facts & { exitLine: string; testsLine: string; evidence: Map<string, string> } {
  const main = /<main data-run-id="[^"]*" data-status="([a-z]+)" data-exit-code="(\d+)" data-complete="(true|false)"/.exec(html)
  assert.ok(main !== null)
  const tests = new Map<string, TestStatus | 'unfinished'>()
  const evidence = new Map<string, string>()
  for (const match of html.matchAll(/data-test-id="([^"]*)"(?: data-variant-key="([^"]*)")? data-status="([a-z_]+)"(?: data-failure-class="[^"]*")? data-evidence="([a-z]+)"/g)) {
    const id = key(unescape(match[1] ?? ''), match[2] === undefined ? undefined : unescape(match[2]))
    tests.set(id, parseStatus(match[3] ?? ''))
    evidence.set(id, match[4] ?? '')
  }
  const text = visible(html)
  const exitLine = /Retest run \S+ [^E]*?(Exit [^\n]*?) Tests /.exec(text)?.[1] ?? ''
  const testsLine = /Tests (.*?) (?:Checks|Host checks|AI checks|Diagnostics|Time) /.exec(text)?.[1] ?? ''
  return { run: { status: parseRunStatus(main[1] ?? ''), exitCode: Number(main[2]), complete: main[3] === 'true' }, tests, exitLine, testsLine, evidence }
}

/** The outcome data block a program reads, as `JSON.parse` reads it. */
function dataBlock(html: string): unknown {
  const blocks = [...html.matchAll(dataBlockPattern)]
  assert.equal(blocks.length, 1, 'one outcome data block')
  return JSON.parse(blocks[0]?.[1] ?? '')
}

/** What the terminal report says, as `inspect` prints it: its Tests and Exit rows, and each test line's mark. */
function terminalFacts(output: string): { exitLine: string; testsLine: string; lines: string[]; notRun: string[] } {
  const lines = plain(output).split('\n')
  const row = (label: string): string => lines.find((line) => line.startsWith(`  ${label} `))?.slice(label.length + 2).trim() ?? ''
  const notRunAt = lines.findIndex((line) => line === '  Not run')
  const notRun = notRunAt === -1 ? [] : lines.slice(notRunAt + 1).filter((line) => line.startsWith('    ')).map((line) => line.trim())
  return { exitLine: `Exit ${row('Exit')}`, testsLine: row('Tests'), lines, notRun }
}

const terminalMarks: Record<TestStatus, string> = { passed: '✓', failed: '✗', error: '!', not_run: '-', inconclusive: '?', skipped: '○' }

describe('terminal, JSONL and HTML agree on a run folder', async () => {
  for (const { name, folder } of folders()) {
    test(name, async () => {
      const read = readRunFolder(folder)
      const html = await reportOf(folder)
      const fromHtml = htmlFacts(html)
      const fromJsonl = jsonlFacts(folder)
      if (name.startsWith('evaluation-')) {
        const state = name.endsWith('partial') ? 'partial' : 'complete'
        assert.match(html, new RegExp(`data-evidence="${state}"`))
        assert.ok(visible(html).includes('Judge verdict'))
        assert.ok(visible(html).includes('frames_incomplete'))
        assert.ok(!visible(html).includes('Screenshot frames-e1'))
        assert.ok(!visible(html).includes('Screenshot diagnostics-e1'))
        if (name.includes('frames')) {
          assert.ok(visible(html).includes('Frames frames-e1'))
          if (state === 'partial') {
            assert.ok(visible(html).includes('frames were omitted by the evidence bound'))
            assert.ok(visible(html).includes('pending-frame'))
            assert.ok(html.includes(`data-reference="${missingEvaluationFramePath}"`))
          }
        } else {
          assert.ok(visible(html).includes('Diagnostics diagnostics-e1'))
          assert.ok(visible(html).includes('saved context'))
          if (state === 'partial') assert.ok(visible(html).includes('older diagnostic records were omitted'))
        }
      }
      const fake = fakeCli({ cwd: root })
      assert.equal(await fake.cli(['inspect', relative(root, folder)]), 0, fake.stderr.text)
      const fromTerminal = terminalFacts(fake.stdout.text)

      // The run: the HTML marks what the folder's result says, and shows the terminal's Exit and Tests rows word for word.
      assert.deepEqual(fromHtml.run, { status: read.result.status, exitCode: read.result.exitCode, complete: read.result.complete })
      assert.equal(fromHtml.exitLine, fromTerminal.exitLine)
      assert.equal(fromHtml.testsLine, fromTerminal.testsLine)
      // JSONL's own outcome, when the run wrote one, is the same; a run that never wrote one reads as incomplete.
      if (fromJsonl.run === undefined) assert.deepEqual({ status: fromHtml.run?.status, complete: fromHtml.run?.complete, exitCode: fromHtml.run?.exitCode }, { status: 'error', complete: false, exitCode: 2 })
      else assert.deepEqual(fromHtml.run, fromJsonl.run)

      // Each test: one status in all three.
      for (const result of read.result.files.flatMap((file) => file.tests)) {
        const id = key(result.testId, result.variantKey)
        assert.equal(fromHtml.tests.get(id), result.status, `${id} in the HTML`)
        const jsonl = fromJsonl.tests.get(id)
        if (jsonl === 'unfinished') assert.equal(result.status, 'error', `${id} started and never finished, so it is an error`)
        else if (jsonl === undefined) assert.equal(result.status, 'not_run', `${id} never started, so it did not run`)
        else assert.equal(jsonl, result.status, `${id} in events.jsonl`)
        const title = titleWithin(result.name, result.describePath)
        if (result.status === 'not_run') assert.ok(fromTerminal.notRun.some((line) => line.includes(title)), `${id} in the terminal's Not run list`)
        else if (jsonl !== 'unfinished') assert.ok(fromTerminal.lines.some((line) => line.startsWith(`    ${terminalMarks[result.status]} ${title}`)), `${id} as ${result.status} in the terminal`)
      }
      assert.equal(fromHtml.tests.size, read.result.files.flatMap((file) => file.tests).length, 'the HTML has one section for each test')

      // The data block states the folder's result and the evidence state each section shows, and nothing else.
      const { passed, failed, error, notRun, inconclusive, skipped } = read.result.counts
      assert.deepEqual(dataBlock(html), {
        version: 1,
        runId: read.result.runId,
        status: read.result.status,
        exitCode: read.result.exitCode,
        complete: read.result.complete,
        source: read.source,
        counts: { passed, failed, error, notRun, inconclusive, ...(skipped === undefined ? {} : { skipped }) },
        tests: read.result.files.flatMap((file) => file.tests).map((result) => ({
          testId: result.testId,
          name: result.name,
          ...(result.variantKey === undefined ? {} : { variantKey: result.variantKey }),
          status: result.status,
          ...(result.failure === undefined ? {} : { failureClass: result.failure.class }),
          evidence: fromHtml.evidence.get(key(result.testId, result.variantKey)),
        })),
      })
    })
  }
})

function key(testId: string, variantKey: string | undefined): string {
  return variantKey === undefined ? testId : `${testId} [${variantKey}]`
}

function unescape(text: string): string {
  return text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&#96;', '`').replaceAll('&amp;', '&')
}

const dataBlockPattern = /<script type="application\/json" id="retest-outcome">([^<]*)<\/script>/g

function visible(html: string): string {
  return unescape(html.replace(/<style>[\s\S]*?<\/style>/, '').replace(dataBlockPattern, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ')
}

const testStatuses: readonly TestStatus[] = ['passed', 'failed', 'error', 'not_run', 'inconclusive', 'skipped']
const runStatuses: readonly RunStatus[] = ['passed', 'failed', 'error', 'interrupted']

function parseStatus(text: string): TestStatus {
  const status = testStatuses.find((candidate) => candidate === text)
  assert.ok(status !== undefined, `a test status: ${text}`)
  return status
}

function parseRunStatus(text: string): RunStatus {
  const status = runStatuses.find((candidate) => candidate === text)
  assert.ok(status !== undefined, `a run status: ${text}`)
  return status
}
