import type { DiagnosticLine, DiagnosticScope, DiagnosticsSummary } from '../../src/protocol/diagnostics.ts'
import type { EvaluationRecord } from '../../src/protocol/evaluation.ts'
import type { EventBody, RetestEvent } from '../../src/protocol/events.ts'
import type { ExecutionRecord } from '../../src/protocol/execution.ts'
import type { Failure, SourceLocation } from '../../src/protocol/failures.ts'
import type { RecordingRecord } from '../../src/protocol/recording.ts'
import type { RunResult } from '../../src/protocol/result.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { defaultDiagnosticLimits } from '../../src/protocol/diagnostics.ts'
import { truncateText } from '../../src/protocol/failures.ts'
import { eventsFile, resultFile, testId } from '../../src/protocol/run-folder.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { buildReport, type ReportInput } from '../../src/reporters/html/build-report.ts'
import { readRunFolder } from '../../src/store/read-run-folder.ts'
import { file, resultOf, stamp } from './reporters-fixtures.ts'

// Run folders for the HTML report's tests: a PNG writer, a folder writer that puts artifacts beside the events, and a
// run from a config whose one test fails with diagnostics, AI checks, an execution record, a browser's engine and build.

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A PNG of one colour, `width` by `height`. */
export function png(width: number, height: number, rgb: readonly [number, number, number] = [200, 40, 40]): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3)
  const pixels = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}

export type FolderParts = { events?: readonly RetestEvent[]; result?: RunResult; files?: Readonly<Record<string, Buffer | string>> }

/** A run folder with its events, its result when given, and each file at its path inside it. */
export function writeFolder(root: string, name: string, parts: FolderParts): string {
  const folder = join(root, name)
  mkdirSync(folder, { recursive: true })
  if (parts.events !== undefined) writeFileSync(join(folder, eventsFile), parts.events.map((event) => `${JSON.stringify(event)}\n`).join(''))
  if (parts.result !== undefined) writeFileSync(join(folder, resultFile), JSON.stringify(parts.result, null, 2))
  for (const [path, bytes] of Object.entries(parts.files ?? {})) {
    mkdirSync(dirname(join(folder, path)), { recursive: true })
    writeFileSync(join(folder, path), bytes)
  }
  return folder
}

/** The report of a run folder, read as `retest report` reads it. */
export async function reportOf(folder: string, shown = 'runs/shown'): Promise<string> {
  const read = readRunFolder(folder)
  const input: ReportInput = { directory: folder, shown, source: read.source, result: read.result, events: read.events, warnings: read.warnings, redactText: (text) => text }
  return buildReport(input)
}

/** The failure screenshot path the shared failing fixture records. */
export const failureScreenshot = 'artifacts/saves-a-task-failure.png'

// A run from a config: one app, `web`, on a target named `chrome`, so every event names its session.
export const configTest: string = testId(file, 'saves a task')
const attemptId = 'k3v9q0x2mb'
const sessionId = `${attemptId}:web`
const variant = { web: 'chrome' }
const scope = { testId: configTest, attemptId, session: 'web', variant, variantKey: 'web=chrome' }
const at = (line: number, column = 3): SourceLocation => ({ file, line, column })
export const configScreenshot = 'artifacts/config-failure.png'
export const judgedScreenshot = 'artifacts/config-judged.png'
export const diagnosticsArtifact = 'diagnostics/config-web.jsonl'

const diagnosticScope: DiagnosticScope = {
  engine: 'chromium',
  source: 'page_target',
  console: { covered: ['top_level_document', 'same_process_frames'], notCovered: ['service_workers'] },
  network: { covered: ['top_level_document'], notCovered: ['out_of_process_frames'] },
}

const identity = { testId: configTest, attemptId, app: 'web', sessionId, target: 'chrome' }

/** The lines of the config run's diagnostics artifact: a console message, an uncaught error, a 404 and a refused request. */
export function diagnosticsLines(texts: { console?: string; url?: string; failure?: string } = {}): DiagnosticLine[] {
  const time = (milliseconds: number): string => new Date(Date.UTC(2026, 8, 30, 9, 15, 0, milliseconds)).toISOString()
  return [
    { ...identity, type: 'capture.started', schemaVersion: 1, scope: diagnosticScope, limits: { ...defaultDiagnosticLimits }, startedAt: time(40) },
    { ...identity, type: 'console', id: 'c1', consoleType: 'log', level: 'info', origin: 'page', text: truncateText(texts.console ?? 'saving the task'), time: time(70), url: 'http://127.0.0.1:4173/app.js', line: 12, column: 5 },
    { ...identity, type: 'runtime_error', id: 'e1', kind: 'uncaught', message: truncateText('Uncaught Error: save failed'), time: time(75), stack: [{ function: 'save', url: 'http://127.0.0.1:4173/app.js', line: 30, column: 9 }] },
    { ...identity, type: 'network.request', requestId: 'r1', method: 'POST', url: texts.url ?? 'http://127.0.0.1:4173/api/tasks', time: time(72) },
    { ...identity, type: 'network.response', requestId: 'r1', status: 404, statusText: 'Not Found', time: time(78) },
    { ...identity, type: 'network.finished', requestId: 'r1', time: time(79), durationMs: 7 },
    { ...identity, type: 'network.request', requestId: 'r2', method: 'GET', url: 'http://127.0.0.1:9/offline', time: time(80) },
    { ...identity, type: 'network.failed', requestId: 'r2', time: time(81), durationMs: 1, reason: texts.failure ?? 'net::ERR_CONNECTION_REFUSED' },
    { ...identity, type: 'capture.finished', endedAt: time(120), console: consoleCapture, network: networkCapture },
  ]
}

const consoleCapture = { state: 'complete' as const, entries: 1, errors: 0, warnings: 0, runtimeErrors: 1, handledLater: 0, dropped: 0, truncated: 0, bytes: 400 }
const networkCapture = { state: 'partial' as const, reason: 'the browser stopped reporting requests after a renderer swap', requests: 2, httpErrors: 1, transportFailures: 1, canceled: 0, pending: 0, outOfScope: 0, dropped: 3, truncated: 0, bytes: 600 }

const diagnosticsSummary: DiagnosticsSummary = {
  app: 'web',
  sessionId,
  path: diagnosticsArtifact,
  scope: diagnosticScope,
  startedAt: '2026-09-30T09:15:00.040Z',
  endedAt: '2026-09-30T09:15:00.120Z',
  console: consoleCapture,
  network: networkCapture,
}

export const execution: ExecutionRecord = {
  bundle: { sha256: 'b'.repeat(64), modules: [{ path: file, sha256: 'a'.repeat(64) }, { path: 'helpers/tasks.ts', sha256: 'c'.repeat(64) }] },
  configuration: {
    sha256: 'd'.repeat(64),
    settings: {
      apps: { web: { target: 'chrome', kind: 'web', browser: 'chrome', headless: true } },
      timeouts: { ...defaultTimeouts },
      locks: [],
      diagnostics: { capture: true, limits: { ...defaultDiagnosticLimits } },
    },
  },
  runtime: { retest: '0.0.0', node: 'v24.12.0', platform: 'darwin-arm64' },
  sessions: [{ app: 'web', sessionId, engine: 'chromium', product: 'Chrome', version: '154.0.8037.93', resource: 'browser-context' }],
  requirement: { version: 'tasks@2', sha256: 'e'.repeat(64), checks: [{ id: 'task-saved', kind: 'evaluation', sha256: 'f'.repeat(64) }] },
  startingState: [{ app: 'web', browserStorage: 'fresh', backendData: 'prepared' }],
}

/** The config run's required AI check, failed, with what the judge said given as `justification`. */
export function evaluationRecord(justification = 'The list shows "Saving…" and no saved task.'): EvaluationRecord {
  return {
    checkId: 'task-saved',
    source: 'test',
    mode: 'required',
    judge: 'visual',
    verdict: 'fail',
    criteria: [
      { id: 'saved', requirement: 'The task list shows the new task as saved.', verdict: 'fail', citations: ['e1'] },
      { id: 'no-error', requirement: 'No error message is visible.', verdict: 'pass', citations: ['e1'] },
    ],
    criteriaSha256: '1'.repeat(64),
    evidence: [{ id: 'e1', kind: 'screenshot', testId: configTest, app: 'web', sessionId, attemptId, capturedAt: '2026-09-30T09:15:00.090Z', source: 'chromium', path: judgedScreenshot, sha256: '2'.repeat(64), bytes: 1234, width: 40, height: 30 }],
    justification,
    evaluator: {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      modelRevision: 'claude-sonnet-5-20260901',
      evaluatorVersion: '1.2.0',
      promptVersion: '3',
      latencyMs: 2300,
      usage: { inputTokens: 1200, outputTokens: 80, totalTokens: 1280 },
    },
    failure: { class: 'evaluation_failed', message: 'The required AI check task-saved failed: saved.' },
    durationMs: 2400,
    location: at(8),
  }
}

/** The config run's advisory AI check, which did not pass and so warns. */
export const advisoryRecord: EvaluationRecord = {
  checkId: 'tidy-layout',
  source: 'test',
  mode: 'advisory',
  verdict: 'inconclusive',
  criteria: [{ id: 'tidy', requirement: 'Nothing overlaps.' }],
  criteriaSha256: '3'.repeat(64),
  evidence: [{ id: 't1', kind: 'text', attemptId, capturedAt: '2026-09-30T09:15:00.095Z', label: 'layout notes', sha256: '4'.repeat(64), bytes: 30 }],
  reason: 'The judge could not tell from the evidence.',
  warning: 'The advisory AI check tidy-layout was undecided.',
  durationMs: 900,
}

export type ConfigRunTexts = { title?: string; pageTitle?: string; pageUrl?: string; actual?: string; justification?: string }

/** A config run whose one test fails its text check after an AI check failed, with every kind of evidence recorded. */
export function configRun(rootDir: string, texts: ConfigRunTexts = {}): RetestEvent[] {
  const pageUrl = texts.pageUrl ?? 'http://127.0.0.1:4173/'
  const actual = texts.actual ?? 'Saving…'
  const name = texts.title ?? 'saves a task'
  const message = `Expected the text "Release checklist", received ${JSON.stringify(actual)}.`
  const failure: Failure = { class: 'check_failed', message, location: at(9), details: { expected: truncateText('Release checklist'), received: truncateText(actual), attempts: 4, timeoutMs: 5000 } }
  const bodies: EventBody[] = [
    { type: 'run.started', retestVersion: '0.0.0', node: 'v24.12.0', platform: 'darwin', rootDir, files: [file], options: { config: 'retest.config.ts', timeouts: defaultTimeouts, reporter: 'human' } },
    { type: 'browser.started', product: 'Chrome', version: '154.0.8037.93', engine: 'chromium', build: '1610480', userAgent: 'Mozilla/5.0 Chrome/154', pid: 4242, executablePath: '/opt/chrome/chrome', app: 'web', target: { name: 'chrome' } },
    { type: 'collection.completed', file, tests: [{ testId: configTest, name, location: at(3, 1), apps: ['web'], variants: [variant] }] },
    { type: 'test.started', ...scope, name, file, location: at(3, 1), execution },
    { type: 'diagnostics.started', ...scope, sessionId, scope: diagnosticScope, limits: { ...defaultDiagnosticLimits }, startedAt: '2026-09-30T09:15:00.040Z' },
    { type: 'action.completed', ...scope, sessionId, command: 'goto', pageUrl, durationMs: 14, location: at(4) },
    { type: 'navigation', ...scope, sessionId, url: pageUrl, ...(texts.pageTitle === undefined ? {} : { title: texts.pageTitle }), cause: 'goto' },
    { type: 'action.completed', ...scope, sessionId, command: 'fill', locator: { by: 'testId', value: 'task-title' }, pageUrl, durationMs: 8, location: at(5), valueLength: 17 },
    { type: 'evaluation.finished', ...scope, evaluation: evaluationRecord(texts.justification) },
    { type: 'evaluation.finished', ...scope, evaluation: advisoryRecord },
    { type: 'assertion.failed', testId: configTest, attemptId, session: 'web', variant, variantKey: 'web=chrome', sessionId, matcher: 'toHaveText', locator: { by: 'testId', value: 'saved-task' }, expected: truncateText('Release checklist'), actual: truncateText(actual), attempts: 4, timeoutMs: 5000, durationMs: 5001, location: at(9), pageUrl, ...(texts.pageTitle === undefined ? {} : { pageTitle: texts.pageTitle }), failure },
    { type: 'diagnostics.finished', ...scope, sessionId, diagnostics: diagnosticsSummary },
    { type: 'evidence.captured', ...scope, kind: 'screenshot', path: configScreenshot, reason: 'failure', sessionId, capturedAt: '2026-09-30T09:15:00.130Z', capturedElapsedMs: 130, source: 'chromium' },
    { type: 'test.finished', ...scope, status: 'failed', durationMs: 7600, assertionCount: 1, failure, ending: { kind: 'assertion_failed' } },
    { type: 'run.finished', status: 'failed', exitCode: 1, complete: true, counts: { passed: 0, failed: 1, error: 0, notRun: 0, inconclusive: 0 }, durationMs: 8000 },
  ]
  return stamp(bodies)
}

/** Where the config run's recording is, as the run would name it. */
export const recordingPath = 'artifacts/k3v9q0x2mb/web-0123456789abc/recording-1.mp4'

/** The first bytes of an MP4 file: a box of type `ftyp`, brand `isom`. Enough for the report's check of what it is. */
export function mp4(): Buffer {
  const box = Buffer.alloc(32)
  box.writeUInt32BE(32, 0)
  box.write('ftypisom', 4, 'latin1')
  return box
}

/** The config run's one recording as its `recording.finished` writes it, complete unless `changes` say otherwise. */
export function recordingRecord(changes: Partial<RecordingRecord> = {}): RecordingRecord {
  return {
    recordingId: 'rec-1',
    sequence: 1,
    testId: configTest,
    attemptId,
    app: 'web',
    sessionId,
    status: 'complete',
    gaps: [],
    path: recordingPath,
    source: 'chromium',
    mode: 'screencast',
    video: { codec: 'h264', container: 'mp4', width: 1280, height: 720, fps: 10, outputFrames: 42, durationUs: 4_200_000 },
    frames: { delivered: 50, sent: 50, dropped: 0, notSent: 0, withheld: 0, refused: 0 },
    clock: { capture: 'run_us', videoZeroUs: 30_000, durationUs: 4_200_000, shortened: [], shortenedCount: 0 },
    stoppedBy: 'attempt_ended',
    ...changes,
  }
}

/**
 * The config run, recorded: `recording.started` once the page opened, `recording.finished` with `record` before the
 * attempt's end, and `extra` events after it, such as a retention's `artifact.removed`.
 */
export function recordedRun(rootDir: string, record: RecordingRecord = recordingRecord(), extra: readonly EventBody[] = []): RetestEvent[] {
  const bodies = configRun(rootDir).map(({ schemaVersion: _version, runId: _run, sequence: _sequence, time: _time, elapsedMs: _elapsed, origin: _origin, ...body }): EventBody => body)
  const started: EventBody = { type: 'recording.started', ...scope, sessionId, recordingId: record.recordingId, number: record.sequence, source: 'chromium', mode: 'screencast', path: recordingPath, fps: 10, width: 1280, height: 720, codec: 'h264', container: 'mp4', route: 'encoded', keepFrames: false, startedUs: 30_000 }
  const finished: EventBody = { type: 'recording.finished', ...scope, sessionId, recording: record }
  const opened = bodies.findIndex((body) => body.type === 'diagnostics.started') + 1
  const ended = bodies.findIndex((body) => body.type === 'test.finished')
  return stamp([...bodies.slice(0, opened), started, ...bodies.slice(opened, ended), finished, ...extra, ...bodies.slice(ended)])
}

/** The config run's folder, with its screenshots and its diagnostics artifact. */
export function configFolder(root: string, name: string, texts: ConfigRunTexts & { console?: string; url?: string; failure?: string } = {}): string {
  const events = configRun(root, texts)
  return writeFolder(root, name, { events, result: resultOf(events), files: configFiles(texts) })
}

/** The files the config run's records name, its recording aside. */
export function configFiles(texts: { console?: string; url?: string; failure?: string } = {}): Record<string, Buffer | string> {
  const lines = diagnosticsLines(texts).map((line) => `${JSON.stringify(line)}\n`).join('')
  return { [configScreenshot]: png(64, 48), [judgedScreenshot]: png(40, 30, [40, 120, 200]), [diagnosticsArtifact]: lines }
}

export const evaluationFramePath = 'artifacts/evaluation-frame.png'
export const missingEvaluationFramePath = 'artifacts/evaluation-frame-missing.png'
export const evaluationDiagnosticsPath = 'diagnostics/evaluation-context.json'

/** A failed run with an advisory frame/diagnostics check; the kept failure image keeps evidence distinct from outcome. */
export function extendedEvidenceRun(root: string, kind: 'frames' | 'diagnostics', partial = true): RetestEvent[] {
  return configRun(root).filter((event) => event.type !== 'diagnostics.finished' && event.type !== 'diagnostics.started').map((event): RetestEvent => {
    if (event.type !== 'evaluation.finished') return event
    const evidence: EvaluationRecord['evidence'] = kind === 'frames' ? [{
      id: 'frames-e1', kind, attemptId, app: 'web', sessionId, capturedAt: '2026-09-30T09:15:00.090Z', sha256: '2'.repeat(64), bytes: 20,
      status: partial ? 'partial' : 'complete', ...(partial ? { reason: 'frames were omitted by the evidence bound' } : {}), fromUs: 1000, toUs: 9000,
      omitted: { byCount: partial ? 2 : 0, byBytes: 0, undecodable: 0 },
      framesNotSent: partial ? [{ frameId: 'pending-frame', captureUs: 8000, fate: 'pending' }] : [],
      frames: [evaluationFramePath, ...(partial ? [missingEvaluationFramePath] : [])].map((path, index) => ({ id: `frames-e1-f${index + 1}`, frameId: `frame-${index + 1}`, captureUs: 2000 + index * 1000, fate: 'shown' as const, format: 'png' as const, path, sha256: '3'.repeat(64), bytes: 10, width: 8, height: 8 })),
    }] : [{
      id: 'diagnostics-e1', kind, attemptId, app: 'web', sessionId, capturedAt: '2026-09-30T09:15:00.090Z', sha256: '4'.repeat(64), bytes: 40, path: evaluationDiagnosticsPath,
      status: partial ? 'partial' : 'complete', ...(partial ? { reason: 'older diagnostic records were omitted' } : {}), include: ['console'], console: { state: partial ? 'partial' : 'complete', ...(partial ? { reason: 'the console reached its bound' } : {}) }, records: ['c1'], recordsOmitted: partial ? 2 : 0,
    }]
    return { ...event, evaluation: { ...event.evaluation, mode: 'advisory', verdict: 'inconclusive', criteria: [{ id: 'saved', requirement: 'A saved message appears.', verdict: 'inconclusive', judgeVerdict: 'pass', rule: 'frames_incomplete', citations: [kind === 'frames' ? 'frames-e1-f1' : 'diagnostics-e1'] }], evidence } }
  })
}
