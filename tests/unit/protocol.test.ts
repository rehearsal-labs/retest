import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import {
  commandResultSchema,
  describeCommand,
  pageCommandSchema,
  type CommandResult,
  type PageCommand,
} from '../../src/protocol/commands.ts'
import {
  childEventSchema,
  retestEventSchema,
  type ChildEvent,
  type EventBody,
  type EventStamp,
  type RetestEvent,
} from '../../src/protocol/events.ts'
import { truncateText, type Failure, type SourceLocation } from '../../src/protocol/failures.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import { observedRecord } from '../../src/protocol/observation-record.ts'
import {
  childMessageSchema,
  parentMessageSchema,
  type ChildMessage,
  type ParentMessage,
} from '../../src/protocol/messages.ts'
import { runResultSchema, type RunResult } from '../../src/protocol/result.ts'
import { parse, toJsonSchema, type Issue } from '../../src/protocol/schema.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { isWebUrl, originOf, readOrigin, withoutCredentials } from '../../src/protocol/url.ts'
import { observationOf } from '../support/observation.ts'

type AnySchema = Parameters<typeof parse>[0]

const location: SourceLocation = { file: 'examples/task.retest.ts', line: 7, column: 3 }
const failure: Failure = { class: 'check_failed', message: 'Expected "Release checklist", received "Release".', location }
const locator: LocatorRecipe = { by: 'testId', value: 'saved-task' }
const scope = { testId: 'examples/task.retest.ts > saves a task', attemptId: 'attempt-1' }
const variant = { variant: { web: 'beta', mobile: 'pixel' }, variantKey: 'mobile=pixel,web=beta' }
const pageUrl = 'http://127.0.0.1:4173/'
const pixel = { viewport: { width: 412, height: 923 }, deviceScaleFactor: 2.625, touch: true, isMobile: true }
const stamp: EventStamp = {
  schemaVersion: 1,
  runId: 'run-1',
  sequence: 0,
  time: '2026-09-30T09:15:00.000Z',
  elapsedMs: 0,
  origin: 'parent',
}

const childEvents: ChildEvent[] = [
  { type: 'step.started', ...scope, stepId: 'step-1', name: 'save the task', location, session: 'page' },
  { type: 'step.started', ...scope, stepId: 'step-2', parentStepId: 'step-1', name: 'inner' },
  { type: 'step.started', ...scope, stepId: 'step-3', name: 'beforeEach', hook: 'beforeEach', session: 'owner' },
  { type: 'step.finished', ...scope, stepId: 'step-2', status: 'passed', durationMs: 1.25 },
  { type: 'step.finished', ...scope, stepId: 'step-1', status: 'failed', durationMs: 12.5, failure },
  {
    type: 'assertion.passed',
    ...scope,
    matcher: 'toBeVisible',
    locator,
    expected: null,
    actual: null,
    attempts: 1,
    durationMs: 3,
    session: 'page',
    pageUrl,
  },
  {
    type: 'assertion.failed',
    ...scope,
    stepId: 'step-1',
    matcher: 'toHaveText',
    locator,
    expected: truncateText('Release checklist'),
    actual: truncateText('Release'),
    comparison: 'whole text, trimmed, with each run of whitespace read as one space',
    attempts: 9,
    timeoutMs: 5000,
    durationMs: 5001,
    location,
    pageUrl,
    failure,
  },
  {
    type: 'assertion.failed',
    ...scope,
    matcher: 'toHaveCount',
    locator: { by: 'role', role: 'listitem' },
    expected: truncateText('3'),
    actual: truncateText('2'),
    attempts: 1,
    durationMs: 5001,
    soft: true,
    session: 'member',
    failure,
  },
]

const parentEvents: EventBody[] = [
  {
    type: 'run.started',
    retestVersion: '0.0.0',
    node: 'v24.12.0',
    platform: 'darwin',
    rootDir: '/work',
    files: ['examples/task.retest.ts'],
    options: {
      baseUrl: 'http://127.0.0.1:4173',
      browserPath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      timeouts: defaultTimeouts,
      reporter: 'jsonl',
    },
  },
  {
    type: 'run.started',
    retestVersion: '0.0.0',
    node: 'v24.12.0',
    platform: 'darwin',
    rootDir: '/work',
    files: ['examples/task.retest.ts'],
    options: { config: 'retest.config.ts', baseUrls: { web: 'https://preview.example.test' }, timeouts: defaultTimeouts, reporter: 'human' },
  },
  {
    type: 'run.started',
    retestVersion: '0.0.0',
    node: 'v24.12.0',
    platform: 'darwin',
    rootDir: '/work',
    files: ['tests/checkout.retest.ts'],
    options: {
      config: 'host.config.ts',
      timeouts: defaultTimeouts,
      reporter: 'host',
      hostChecks: {
        'tests/checkout.retest.ts': [
          { kind: 'address', origin: 'https://shop.example', path: { pattern: '^\\/orders\\/\\d+$', flags: '' } },
          { kind: 'text', text: 'Payment failed', ignoreCase: true, absent: true },
        ],
        'tests/checkout.retest.ts > places an order': [{ kind: 'address', name: 'on the done page', origin: 'https://shop.example', path: '/done' }],
      },
    },
  },
  {
    type: 'browser.started',
    product: 'Chrome',
    version: '141.0.0.0',
    userAgent: 'Mozilla/5.0',
    pid: 4242,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  },
  {
    type: 'browser.started',
    product: 'Chrome',
    version: '141.0.0.0',
    userAgent: 'Mozilla/5.0',
    pid: 4242,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    app: 'mobile',
    target: { name: 'pixel', device: 'Pixel 9', emulation: { ...pixel, userAgent: 'Mozilla/5.0 (Linux; Android 10; K)' } },
  },
  {
    type: 'browser.started',
    product: 'Chrome',
    version: '141.0.0.0',
    userAgent: 'Mozilla/5.0',
    pid: 4242,
    executablePath: '/usr/bin/chromium',
    app: 'web',
    target: { name: 'hosted', proxy: { server: 'http://127.0.0.1:8080', bypass: ['<-loopback>', '*.internal'] } },
  },
  {
    type: 'native.started',
    ...scope,
    session: 'desk',
    app: 'desk',
    sessionId: 'attempt-1:desk',
    target: 'macos',
    product: 'TaskDesk',
    identity: {
      platform: 'macos',
      app: { bundleId: 'dev.retest.fixtures.taskdesk', path: '/work/build/TaskDesk.app', sha256: 'a'.repeat(64) },
      os: { name: 'macOS', version: '26.5', build: '25F71' },
      executor: { name: 'appium-mac2-driver', version: '4.3.6', commit: 'b'.repeat(40), commitVerified: true, productsSha256: 'c'.repeat(64), codeDirectoryHash: 'd'.repeat(40), origin: 'built' },
      xcode: { version: '26.5', build: '17F42' },
    },
  },
  { type: 'native.ended', ...scope, session: 'desk', sessionId: 'attempt-1:desk', unknownOutcomes: [] },
  {
    type: 'native.ended',
    ...scope,
    ...variant,
    session: 'mobile',
    sessionId: 'attempt-1:mobile',
    unknownOutcomes: [
      { source: 'lifecycle', id: 'launch-1', kind: 'launch', generation: 0, failure: { class: 'outcome_unknown', message: 'The launch request had no answer.' }, reconciled: { problem: 'ps did not answer' } },
      { source: 'input', id: 'input-2', kind: 'swipe', generation: 1, route: 'POST /session/:session/actions', input: 'unknown', reconciled: { running: true, pids: [4242] } },
    ],
  },
  { type: 'app.started', app: 'web', ready: 'http://127.0.0.1:4173/health', pid: 5151, durationMs: 2100 },
  { type: 'app.reused', app: 'web', ready: 'http://127.0.0.1:4173/health' },
  { type: 'app.failed', app: 'web', ready: 'http://127.0.0.1:4173/health', failure: { class: 'setup_failed', message: 'Nothing answered.' } },
  { type: 'collection.completed', file: 'examples/task.retest.ts', tests: [{ testId: scope.testId, name: 'saves a task', location }] },
  {
    type: 'collection.completed',
    file: 'tests/archive.retest.ts',
    tests: [
      {
        testId: 'tests/archive.retest.ts > archive > archives a task',
        name: 'archives a task',
        location,
        describePath: ['archive'],
        tags: ['smoke'],
        apps: ['web', 'mobile'],
        variants: [variant.variant, { web: 'chromium', mobile: 'iphone' }],
      },
      { testId: 'tests/archive.retest.ts > signed-in', name: 'signed-in', location, apps: ['web'], setup: true, variants: [{ web: 'beta' }] },
    ],
  },
  { type: 'collection.failed', file: 'broken.retest.ts', failure: { class: 'collection_failed', message: 'Unexpected token.' } },
  { type: 'file.failed', file: 'examples/task.retest.ts', failure: { class: 'test_error', message: 'examples/task.retest.ts threw an error while no test was running: Error: late' } },
  { type: 'run.narrowed', only: [location], kept: 1, collected: 4 },
  { type: 'lock.acquired', ...scope, ...variant, locks: ['inbox', 'account'], waitedMs: 2100, heldBy: ['tests/archive.retest.ts > archives a task'] },
  { type: 'session.reserved', ...scope, ...variant, owner: 'agent-1', sessions: 2, waitedMs: 350, active: { owner: 2, host: 3 }, limits: { perOwner: 4, host: 8 } },
  { type: 'session.released', ...scope, ...variant, owner: 'agent-1', sessions: 2, after: 'browser_closed' },
  {
    type: 'resource.acquired',
    ...scope,
    ...variant,
    resources: [{ kind: 'data-folder', name: '/work/.data/desk', apps: ['desk'] }],
    waitedMs: 700,
    heldBy: ['tests/desk.retest.ts > keeps the folder'],
    heldElsewhere: 1,
  },
  {
    type: 'lease.taken',
    ...scope,
    ...variant,
    lease: { covers: [{ kind: 'lock', name: 'inbox' }, { kind: 'sessions', name: 'agent-1', apps: ['web'], count: 1 }], takenAt: '2026-10-04T10:00:00.000Z', releaseWithinMs: 10_000 },
  },
  {
    type: 'lease.expired',
    ...scope,
    ...variant,
    lease: { covers: [{ kind: 'lock', name: 'inbox' }, { kind: 'desktop', name: 'macos', apps: ['mac'] }], takenAt: '2026-10-04T10:00:00.000Z', releaseWithinMs: 10_000 },
    held: [{ kind: 'desktop', name: 'macos', apps: ['mac'] }],
    released: [{ kind: 'lock', name: 'inbox' }],
  },
  {
    type: 'test.started',
    ...scope,
    ...variant,
    name: 'shares a record',
    file: 'tests/records.retest.ts',
    location,
    execution: {
      bundle: { sha256: 'b'.repeat(64), modules: [{ path: 'tests/records.retest.ts', sha256: 'c'.repeat(64) }] },
      configuration: {
        sha256: 'd'.repeat(64),
        settings: {
          apps: { web: { target: 'beta', kind: 'web', browser: 'chrome', channel: 'beta', headless: true, proxy: { server: 'http://127.0.0.1:8080/', bypass: [] } } },
          timeouts: defaultTimeouts,
          locks: ['records'],
          environment: ['MODE'],
          diagnostics: { capture: true, policy: { strict: { runtimeErrors: true } }, limits: { consoleEntries: 1000 } },
          evaluation: {
            judges: [{ name: 'visual', adapter: 'file', module: 'judges/visual.ts', moduleSha256: 'a'.repeat(64), accepts: ['images'], credentials: [{ name: 'apiKey', source: 'env', variable: 'JUDGE_KEY' }], optionsSha256: 'b'.repeat(64) }],
            timeoutMs: 30000,
            limits: { callsPerTest: 5 },
            promptVersion: 'retest-judge-1',
          },
        },
      },
      secretReferences: [{ name: 'password', source: 'env', variable: 'TASK_PASSWORD', origins: [] }],
      runtime: { retest: '0.0.0', node: 'v24.12.0', platform: 'darwin-arm64' },
      sessions: [{ app: 'web', sessionId: 'attempt-1:web', engine: 'chromium', product: 'Chrome', version: '154.0.8037.92' }],
      owner: 'agent-1',
      appBuilds: { web: 'a1b2c3' },
      requirement: { version: 'records-v1', sha256: 'e'.repeat(64), checks: [{ id: 'record-shown', kind: 'page', sha256: 'f'.repeat(64) }] },
      startingState: [{ app: 'web', browserStorage: 'saved', state: 'signed-in', backendData: 'prepared' }],
      unavailable: ['app-build:mobile'],
    },
  },
  {
    type: 'preparation.finished',
    ...scope,
    preparation: { key: 'tests/records.retest.ts', apps: ['web'], backendData: 'prepared', outcome: 'prepared', recipe: 'shared-records@2', seed: 42, receipt: 'op-7', metadata: { accounts: 2, reset: true }, durationMs: 120 },
  },
  { type: 'cleanup.finished', ...scope, cleanup: { key: 'tests/records.retest.ts', outcome: 'failed', reason: 'it threw: the service did not answer', durationMs: 30 } },
  { type: 'test.started', ...scope, name: 'saves a task', file: 'examples/task.retest.ts', location },
  { type: 'test.started', ...scope, ...variant, name: 'archives a task', file: 'tests/archive.retest.ts', location, describePath: ['archive'], setup: true },
  { type: 'state.saved', ...scope, ...variant, state: 'signed-in', app: 'web', target: 'beta' },
  { type: 'state.restored', ...scope, ...variant, state: 'signed-in', app: 'web', target: 'beta' },
  { type: 'action.completed', ...scope, command: 'goto', pageUrl, durationMs: 40, location, session: 'page' },
  { type: 'action.completed', ...scope, stepId: 'step-1', command: 'fill', locator, pageUrl, durationMs: 8, valueLength: 17 },
  { type: 'action.completed', ...scope, ...variant, command: 'fill', locator: { by: 'label', text: 'Password' }, durationMs: 8, secret: 'password', session: 'web' },
  { type: 'action.completed', ...scope, ...variant, command: 'tap', locator: { by: 'role', role: 'button', name: 'Menu' }, durationMs: 30, session: 'mobile' },
  { type: 'action.completed', ...scope, command: 'press', locator: { by: 'label', text: 'Search' }, key: 'Enter', pageUrl, durationMs: 12, session: 'page' },
  { type: 'action.completed', ...scope, command: 'press', key: 'Shift+Tab', durationMs: 9, session: 'page' },
  {
    type: 'action.completed',
    ...scope,
    command: 'select',
    locator: { by: 'label', text: 'Country' },
    choices: [{ label: 'Canada' }, { value: 'mx' }],
    changed: true,
    input: 'script',
    pageUrl,
    pageTitle: 'Sign up',
    durationMs: 15,
    session: 'page',
  },
  {
    type: 'action.completed',
    ...scope,
    ...variant,
    command: 'check',
    locator: { by: 'role', role: 'checkbox', name: 'Remember me' },
    changed: true,
    via: 'label',
    touch: true,
    durationMs: 22,
    session: 'mobile',
  },
  { type: 'action.completed', ...scope, command: 'uncheck', locator: { by: 'label', text: 'Newsletter' }, changed: false, durationMs: 3, session: 'page' },
  { type: 'action.completed', ...scope, command: 'scroll', scroll: { x: 0, y: 600 }, pageUrl, pageTitle: 'Tasks', durationMs: 5, session: 'page' },
  {
    type: 'action.failed',
    ...scope,
    command: 'scroll',
    locator: { by: 'testId', value: 'terms' },
    scroll: { x: -40.5, y: 1200 },
    durationMs: 10_000,
    failure: { class: 'not_actionable', message: 'Another element receives the wheel.' },
  },
  {
    type: 'assertion.passed',
    ...scope,
    ...variant,
    matcher: 'toHaveText',
    locator,
    expected: truncateText('Release checklist'),
    actual: truncateText('Release checklist'),
    comparison: 'whole text, ends trimmed, each run of spaces or line breaks read as one space',
    attempts: 3,
    timeoutMs: 5000,
    durationMs: 120,
    pageUrl,
    pageTitle: 'Release checklist · Tasks',
    observationId: 'o7',
    judgedBy: 'parent',
    session: 'web',
  },
  {
    type: 'assertion.passed',
    ...scope,
    matcher: 'toBe',
    expected: truncateText('2'),
    actual: truncateText('2'),
    comparison: 'Object.is',
    attempts: 1,
    durationMs: 0,
    judgedBy: 'child',
  },
  {
    type: 'action.failed',
    ...scope,
    command: 'click',
    locator,
    pageUrl,
    durationMs: 10_000,
    failure: { class: 'not_actionable', message: 'Another element receives the click.' },
  },
  { type: 'navigation', ...scope, url: pageUrl, session: 'page' },
  { type: 'navigation', ...scope, stepId: 'step-1', url: pageUrl, title: 'Tasks', cause: 'goto', session: 'page' },
  { type: 'navigation', ...scope, ...variant, url: `${pageUrl}done`, cause: 'action', session: 'web' },
  { type: 'navigation', ...scope, url: `${pageUrl}login`, title: 'Sign in', cause: 'page', session: 'page' },
  {
    type: 'observation',
    ...scope,
    ...variant,
    stepId: 'step-1',
    session: 'web',
    observationId: 'o7',
    locator,
    pageUrl,
    pageTitle: 'Verify your email',
    observed: observedRecord(observationOf([{ text: 'Your code is {{code}}', visible: true }])),
    durationMs: 14,
  },
  { type: 'observation', ...scope, observationId: 'o1', locator: { by: 'role', role: 'dialog' }, observed: observedRecord(observationOf([])), durationMs: 3 },
  {
    type: 'host_check.passed',
    ...scope,
    ...variant,
    session: 'web',
    check: { kind: 'address', origin: 'https://shop.example', path: { pattern: '^\\/orders\\/\\d+$', flags: '' } },
    actual: { url: 'https://shop.example/orders/42', title: 'Order 42' },
    attempts: 1,
    timeoutMs: 5000,
    durationMs: 4,
  },
  {
    type: 'host_check.failed',
    ...scope,
    session: 'web',
    check: { kind: 'text', name: 'no payment error', text: 'Payment failed', ignoreCase: true, absent: true },
    actual: { url: 'https://shop.example/checkout', found: true },
    attempts: 11,
    timeoutMs: 5000,
    durationMs: 5003,
    failure: { class: 'host_check_failed', message: 'The page shows "Payment failed", expected it absent. Looked 11 times in 5000 ms.' },
  },
  { type: 'evidence.captured', ...scope, kind: 'screenshot', path: 'artifacts/saves-a-task-failure.png', reason: 'failure' },
  { type: 'evidence.failed', ...scope, kind: 'screenshot', reason: 'failure', message: 'The browser closed.' },
  {
    type: 'diagnostics.started',
    ...scope,
    session: 'web',
    sessionId: 'attempt-1:web',
    scope: {
      engine: 'chromium',
      source: 'page_target',
      console: { covered: ['top_level_document', 'same_process_frames', 'dedicated_workers'], notCovered: ['out_of_process_frames', 'shared_workers', 'service_workers'] },
      network: { covered: ['top_level_document', 'same_process_frames'], notCovered: ['out_of_process_frames', 'dedicated_workers', 'shared_workers', 'service_workers'] },
    },
    limits: { consoleEntries: 1000, consoleBytes: 1048576, requests: 1000, networkBytes: 2097152, textLength: 4096, stackFrames: 20 },
    startedAt: '2026-10-03T00:00:00.000Z',
    policy: { strict: { runtimeErrors: true, allow: ['/favicon.ico'] }, requireComplete: true },
  },
  {
    type: 'diagnostics.finished',
    ...scope,
    session: 'web',
    sessionId: 'attempt-1:web',
    diagnostics: {
      app: 'web',
      sessionId: 'attempt-1:web',
      path: 'diagnostics/saves-a-task-attempt-1-web.jsonl',
      startedAt: '2026-10-03T00:00:00.000Z',
      endedAt: '2026-10-03T00:00:01.000Z',
      console: { state: 'complete', entries: 3, errors: 1, warnings: 0, runtimeErrors: 1, handledLater: 0, dropped: 0, truncated: 0, bytes: 900 },
      network: { state: 'partial', reason: '2 requests over the attempt\'s limits were dropped', requests: 5, httpErrors: 1, transportFailures: 1, canceled: 0, pending: 1, outOfScope: 0, dropped: 2, truncated: 0, bytes: 3000 },
    },
  },
  {
    type: 'evaluation.finished',
    ...scope,
    evaluation: {
      checkId: 'evaluation-1',
      source: 'test',
      mode: 'required',
      judge: 'visual',
      verdict: 'fail',
      criteria: [{ id: 'saved', requirement: 'The banner says the task was saved.', verdict: 'fail', citations: ['e1'] }],
      criteriaSha256: 'c'.repeat(64),
      evidence: [{ id: 'e1', kind: 'screenshot', app: 'page', sessionId: 'attempt-1:page', attemptId: 'attempt-1', capturedAt: '2026-10-03T00:00:00.000Z', path: 'artifacts/check.png', sha256: 'd'.repeat(64), bytes: 2048, width: 1280, height: 720 }],
      justification: 'The banner reads "Could not save".',
      evaluator: { provider: 'anthropic', model: 'claude-sonnet-5', evaluatorVersion: 'retest-ai-sdk/1', promptVersion: 'retest-judge-1', latencyMs: 812 },
      failure: { class: 'evaluation_failed', message: 'The AI check evaluation-1 failed: the judge found "saved" not met.' },
      durationMs: 900,
    },
  },
  {
    type: 'test.finished',
    ...scope,
    status: 'failed',
    durationMs: 5100,
    assertionCount: 1,
    failure,
    cleanupFailures: [{ class: 'cleanup_failed', message: 'The context did not close.' }],
  },
  {
    type: 'test.finished',
    ...scope,
    status: 'failed',
    durationMs: 900,
    assertionCount: 2,
    failure: { class: 'host_check_failed', message: 'The host check "record-shown" on web failed.', details: { checkId: 'record-shown' } },
    ending: { kind: 'required_check_failed', checkId: 'record-shown', notRun: ['record-reads-well'] },
    bundle: { sha256: 'a'.repeat(64), modules: [{ path: 'tests/helpers/late.ts', sha256: 'c'.repeat(64) }] },
  },
  {
    type: 'run.finished',
    status: 'failed',
    exitCode: 1,
    complete: true,
    counts: { passed: 0, failed: 1, error: 0, notRun: 0, inconclusive: 0 },
    durationMs: 6000.5,
  },
  {
    type: 'run.finished',
    status: 'error',
    exitCode: 2,
    complete: false,
    counts: { passed: 0, failed: 0, error: 0, notRun: 1, inconclusive: 0 },
    durationMs: 12,
    failure: { class: 'setup_failed', message: 'No browser at /opt/chromium.' },
  },
  { type: 'run.outcome', status: 'error', exitCode: 2, complete: false, failure: { class: 'reporting_failed', message: 'The final reporter failed.' } },
  {
    type: 'recording.started',
    ...scope,
    session: 'web',
    sessionId: 'attempt-1:web',
    recordingId: 'attempt-1-1-1',
    number: 1,
    source: 'chromium',
    mode: 'screencast',
    path: 'artifacts/attempt-1/web-1a2b/recording-1.mp4',
    fps: 10,
    width: 1280,
    height: 720,
    codec: 'h264',
    container: 'mp4',
    route: 'decoded',
    keepFrames: false,
    startedUs: 812_000,
  },
  {
    type: 'recording.finished',
    ...scope,
    session: 'web',
    sessionId: 'attempt-1:web',
    recording: {
      recordingId: 'attempt-1-1-1',
      sequence: 1,
      testId: scope.testId,
      attemptId: scope.attemptId,
      app: 'web',
      sessionId: 'attempt-1:web',
      status: 'partial',
      gaps: [{ code: 'pixels_withheld', message: 'The pixel capture policy withheld 4 frames over 1 stretch.', app: 'web', sessionId: 'attempt-1:web' }],
      path: 'artifacts/attempt-1/web-1a2b/recording-1.mp4',
      source: 'chromium',
      mode: 'screencast',
      video: { codec: 'h264', container: 'mp4', width: 1280, height: 720, fps: 10, outputFrames: 30, durationUs: 3_000_000, placedBy: 'link' },
      frames: { delivered: 34, sent: 30, dropped: 0, notSent: 0, withheld: 4, refused: 0 },
      media: { received: 30, shown: 26, superseded: 4, dropped: 0, outOfOrder: 0, outOfRange: 0, undecodable: 0, duplicate: 0, unprocessed: 0 },
      captureGaps: 1,
      withheld: { stretches: 1, durationUs: 400_000 },
      clock: { capture: 'run_us', videoZeroUs: 812_400, durationUs: 3_000_000, shortened: [], shortenedCount: 0 },
      stoppedBy: 'attempt_ended',
      finalizeMs: 41,
    },
  },
  {
    type: 'media.started',
    media: {
      pid: 4242,
      start: 1,
      version: '0.1.0',
      protocol: 2,
      build: { target: 'aarch64-apple-darwin', profile: 'release', revision: 'b59eed5', dirty: true },
      ffmpeg: '/opt/homebrew/bin/ffmpeg',
      encoder: { state: 'ready', codec: 'h264', container: 'mp4', encoder: 'libx264', version: '9.0.2' },
      owner: { pid: 4200, startedAt: 'Tue Oct  6 10:00:01 2026' },
    },
  },
  { type: 'media.failed', start: 1, code: 'media_unavailable', message: 'No media binary is named: set RETEST_MEDIA_BINARY to the retest-media binary.' },
  { type: 'media.lost', pid: 4242, start: 1, exit: { code: null, signal: 'SIGKILL' }, recordings: 1, restart: true },
  { type: 'media.closed', pid: 4243, start: 2, forced: false, exit: { code: 0, signal: null } },
  { type: 'media.leftovers', previousRunId: 'run-0', folder: '/work/.retest/runs/2026-10-06T10-00-00', reference: 'artifacts/attempt-0/web-1a2b/recording-1', status: 'ok', removed: [{ reference: 'artifacts/attempt-0/web-1a2b/recording-1.mp4.partial', kind: 'video_partial', byteLength: 4096 }], skipped: 0 },
  { type: 'capture.withheld', ...scope, session: 'web', sessionId: 'attempt-1:web', secret: 'password', cause: 'unknown', fromUs: 1_200_000 },
  { type: 'capture.resumed', ...scope, session: 'web', sessionId: 'attempt-1:web', secret: 'password', endedBy: 'new_document', fromUs: 1_200_000, untilUs: 1_600_000 },
  { type: 'capture.resumed', ...scope, session: 'desk', sessionId: 'attempt-1:desk', secret: 'password', endedBy: 'field_masked', reason: 'the field reads back masked', fromUs: 1_200_000, untilUs: 1_600_000 },
  { type: 'capture.resumed', ...scope, session: 'phone', sessionId: 'attempt-1:phone', secret: 'password', endedBy: 'field_gone', reason: 'the field that received the secret is gone', fromUs: 1_200_000, untilUs: 1_600_000 },
  { type: 'capture.native_entry', ...scope, session: 'phone', sessionId: 'attempt-1:phone', secret: 'password', nativeField: 'plain', branch: 'typed into a plain field, pixels kept', atUs: 1_700_000 },
  { type: 'capture.masked_entry', ...scope, session: 'web', sessionId: 'attempt-1:web', secret: 'password', atUs: 1_700_000 },
  { type: 'artifact.removal_requested', path: 'artifacts/attempt-1/web-1a2b/recording-1.mp4', kind: 'recording', reason: 'passed_attempt_recording', moment: 'attempt_finished', bytes: 81920, ...scope, session: 'web', sessionId: 'attempt-1:web' },
  { type: 'artifact.removed', path: 'artifacts/attempt-1/web-1a2b/recording-1.mp4', kind: 'recording', reason: 'passed_attempt_recording', moment: 'attempt_finished', bytes: 81920, ...scope, session: 'web', sessionId: 'attempt-1:web' },
  { type: 'artifact.removal_failed', path: 'artifacts/attempt-1/web-1a2b/recording-1.mp4', kind: 'recording', reason: 'passed_attempt_recording', moment: 'attempt_finished', message: 'The file changed before it could be removed.', ...scope, session: 'web', sessionId: 'attempt-1:web' },
]

// A child event as the parent writes it: a passed assertion gains the parent's mark.
function written(body: ChildEvent): EventBody {
  return body.type === 'assertion.passed' ? { ...body, judgedBy: 'parent' } : body
}

const events: RetestEvent[] = [
  ...parentEvents.map((body): RetestEvent => ({ ...stamp, ...body })),
  ...childEvents.map((body): RetestEvent => ({ ...stamp, origin: 'child', ...written(body) })),
  ...childEvents.map((body): RetestEvent => ({ ...stamp, origin: 'child', ...variant, ...written(body) })),
].map((event, sequence) => ({ ...event, sequence }))

function roundTrips(schema: AnySchema, value: unknown): void {
  assert.deepEqual(parse(schema, JSON.parse(JSON.stringify(value))), { ok: true, value })
}

function issues(schema: AnySchema, value: unknown): Issue[] {
  const result = parse(schema, value)
  assert.equal(result.ok, false, `expected ${JSON.stringify(value)} to be rejected`)
  return result.ok ? [] : result.issues
}

function sample<Type extends RetestEvent['type']>(type: Type): Extract<RetestEvent, { type: Type }> {
  const found = events.find((event): event is Extract<RetestEvent, { type: Type }> => event.type === type)
  assert.ok(found, `no sample for ${type}`)
  return found
}

function without(value: object, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key))
}

describe('events', () => {
  test('there is a sample of every event type', () => {
    assert.equal(retestEventSchema.kind, 'discriminated-union')
    if (retestEventSchema.kind !== 'discriminated-union') return
    assert.deepEqual(new Set(events.map((event) => event.type)), new Set(retestEventSchema.options.keys()))
  })

  test('every sample survives a JSON round trip', () => {
    for (const event of events) roundTrips(retestEventSchema, event)
  })

  test('native resume reasons are optional, exact and published in the version 1 JSON schema', () => {
    const reasons = ['the field reads back masked', 'the field that received the secret is gone']
    const option = toJsonSchema(retestEventSchema).oneOf?.find(option => option.properties?.['type']?.const === 'capture.resumed')
    assert.ok(option)
    assert.deepEqual(option.properties?.['reason']?.enum, reasons)
    assert.equal(option.required?.includes('reason'), false)
    assert.equal(option.properties?.['schemaVersion']?.const, 1)
    assert.deepEqual(events.filter(event => event.type === 'capture.resumed' && event.reason !== undefined).map(event => event.type === 'capture.resumed' ? event.reason : undefined), reasons)
    assert.deepEqual(issues(retestEventSchema, { ...sample('capture.resumed'), reason: 'probably safe' }).map(issue => issue.path), ['$.reason'])
  })

  test('native entry branches are exact, versioned and contain no private value', () => {
    const branches = ['typed into a secure field', 'typed into a plain field, pixels kept', 'typed into a plain field, pixels withheld', 'field type unreadable, pixels kept', 'field type unreadable, pixels withheld']
    const option = toJsonSchema(retestEventSchema).oneOf?.find(option => option.properties?.['type']?.const === 'capture.native_entry')
    assert.ok(option)
    assert.deepEqual(option.properties?.['branch']?.enum, branches)
    assert.equal(option.properties?.['schemaVersion']?.const, 1)
    for (const branch of branches) roundTrips(retestEventSchema, { ...sample('capture.native_entry'), branch })
    assert.deepEqual(issues(retestEventSchema, { ...sample('capture.native_entry'), branch: 'probably masked' }).map(issue => issue.path), ['$.branch'])
    assert.deepEqual(issues(retestEventSchema, { ...sample('capture.native_entry'), value: 'private' }).map(issue => issue.path), ['$.value'])
    roundTrips(retestEventSchema, { ...sample('capture.masked_entry'), nativeField: 'secure', readBack: 'length_matched' })
    assert.deepEqual(issues(retestEventSchema, { ...sample('capture.masked_entry'), readBack: 'assumed' }).map(issue => issue.path), ['$.readBack'])
  })

  test('malformed events are rejected with the path to the problem', () => {
    const types = retestEventSchema.kind === 'discriminated-union' ? [...retestEventSchema.options.keys()] : []
    const typeNames = types.map((type) => JSON.stringify(type))
    assert.deepEqual(issues(retestEventSchema, { ...sample('run.finished'), type: 'run.done' }), [
      { path: '$.type', message: `expected one of ${typeNames.join(', ')}, received "run.done"` },
    ])
    assert.deepEqual(issues(retestEventSchema, without(sample('run.finished'), 'runId')), [
      { path: '$.runId', message: 'missing required key' },
    ])
    assert.deepEqual(issues(retestEventSchema, { ...sample('test.finished'), retries: 1 }), [
      { path: '$.retries', message: 'unknown key' },
    ])
    assert.deepEqual(issues(retestEventSchema, { ...sample('test.started'), schemaVersion: 2 }), [
      { path: '$.schemaVersion', message: 'expected 1, received 2' },
    ])
    assert.deepEqual(issues(retestEventSchema, { ...sample('navigation'), sequence: -1 }), [
      { path: '$.sequence', message: 'expected integer >= 0, received -1' },
    ])
    assert.deepEqual(issues(retestEventSchema, { ...sample('assertion.passed'), failure }), [
      { path: '$.failure', message: 'unknown key' },
    ])
    assert.deepEqual(issues(retestEventSchema, without(sample('assertion.failed'), 'failure')), [
      { path: '$.failure', message: 'missing required key' },
    ])
    assert.deepEqual(issues(retestEventSchema, without(sample('file.failed'), 'failure')), [
      { path: '$.failure', message: 'missing required key' },
    ])
    assert.deepEqual(issues(retestEventSchema, { ...sample('file.failed'), testId: scope.testId }), [
      { path: '$.testId', message: 'unknown key' },
    ])
    assert.deepEqual(issues(retestEventSchema, { ...sample('action.completed'), value: 'Release checklist' }), [
      { path: '$.value', message: 'unknown key' },
    ])
    assert.deepEqual(issues(retestEventSchema, { ...sample('action.failed'), locator: { by: 'xpath', value: '//button' } }), [
      { path: '$.locator.by', message: 'expected one of "testId", "role", "label", "text", "placeholder", "css", received "xpath"' },
    ])
    assert.deepEqual(issues(retestEventSchema, { ...sample('action.failed'), locator: { by: 'css', selector: 'li', within: [{ by: 'css', selector: 'ul', within: [] }] } }), [
      { path: '$.locator.within[0].within', message: 'unknown key' },
    ])
    assert.deepEqual(issues(retestEventSchema, { ...sample('navigation'), origin: 'browser' }), [
      { path: '$.origin', message: 'expected one of "parent", "child", received "browser"' },
    ])
    assert.deepEqual(issues(retestEventSchema, without(sample('navigation'), 'origin')), [
      { path: '$.origin', message: 'missing required key' },
    ])
    assert.deepEqual(issues(retestEventSchema, { ...sample('test.finished'), variant: { web: 1 } }), [
      { path: '$.variant.web', message: 'expected string, received 1' },
    ])
    assert.deepEqual(issues(retestEventSchema, { ...sample('test.started'), setup: false }), [
      { path: '$.setup', message: 'expected true, received false' },
    ])
    assert.deepEqual(issues(retestEventSchema, { ...sample('state.saved'), cookies: [] }), [
      { path: '$.cookies', message: 'unknown key' },
    ])
    assert.deepEqual(issues(retestEventSchema, { ...sample('app.started'), pid: 0 }), [
      { path: '$.pid', message: 'expected integer >= 1, received 0' },
    ])
    assert.deepEqual(issues(retestEventSchema, { ...sample('action.completed'), command: 'drag' }), [
      {
        path: '$.command',
        message: 'expected one of "goto", "reload", "goBack", "goForward", "fill", "click", "tap", "hover", "press", "select", "check", "uncheck", "scroll", "swipe", "nativeKeyboard", "nativeAlert", received "drag"',
      },
    ])
    assert.deepEqual(issues(retestEventSchema, { ...sample('action.completed'), input: 'keyboard', via: 'control', touch: false }), [
      { path: '$.input', message: 'expected "script", received "keyboard"' },
      { path: '$.via', message: 'expected "label", received "control"' },
      { path: '$.touch', message: 'expected true, received false' },
    ])
    assert.deepEqual(issues(retestEventSchema, { ...sample('action.completed'), scroll: { y: 600 }, changed: 'yes' }), [
      { path: '$.changed', message: 'expected boolean, received "yes"' },
      { path: '$.scroll.x', message: 'missing required key' },
    ])
    assert.deepEqual(issues(retestEventSchema, { ...sample('action.completed'), choices: ['Canada'] }), [
      { path: '$.choices[0]', message: 'expected object, received "Canada"' },
    ])
    assert.deepEqual(issues(retestEventSchema, { ...sample('navigation'), cause: 'link', title: null }), [
      { path: '$.title', message: 'expected string, received null' },
      { path: '$.cause', message: 'expected one of "goto", "action", "page", received "link"' },
    ])
    assert.deepEqual(issues(retestEventSchema, { ...sample('observation'), pageTitle: 3 }), [{ path: '$.pageTitle', message: 'expected string, received 3' }])
    assert.deepEqual(issues(retestEventSchema, { ...sample('host_check.passed'), actual: { title: ['Order 42'] } }), [
      { path: '$.actual.title', message: 'expected string, received array' },
    ])
    assert.deepEqual(issues(retestEventSchema, { ...sample('browser.started'), target: { name: 'hosted', proxy: { server: 'http://p:1', username: 'ada' } } }), [
      { path: '$.target.proxy.username', message: 'unknown key' },
    ])
    assert.deepEqual(issues(retestEventSchema, without(sample('host_check.passed'), 'session')), [{ path: '$.session', message: 'missing required key' }])
    assert.deepEqual(issues(retestEventSchema, { ...sample('host_check.passed'), actual: { url: pageUrl, text: 'Thank you' } }), [
      { path: '$.actual.text', message: 'unknown key' },
    ])
    assert.deepEqual(issues(retestEventSchema, { ...sample('host_check.failed'), timeoutMs: 0 }), [{ path: '$.timeoutMs', message: 'expected integer >= 1, received 0' }])
    assert.deepEqual(issues(retestEventSchema, { ...sample('host_check.passed'), check: { kind: 'address', origin: 'https://shop.example', app: 'web' } }), [
      { path: '$.check.app', message: 'unknown key' },
    ])
    assert.deepEqual(issues(retestEventSchema, { ...sample('observation'), observed: observationOf([{ text: 'Saved', visible: true }]) }), [
      { path: '$.observed.text', message: 'expected object or null, received "Saved"' },
      { path: '$.observed.items[0].text', message: 'expected object, received "Saved"' },
    ])
    assert.deepEqual(issues(retestEventSchema, without(sample('observation'), 'observationId')), [{ path: '$.observationId', message: 'missing required key' }])
    assert.deepEqual(issues(retestEventSchema, { ...sample('run.finished'), exitCode: 3 }), [
      { path: '$.exitCode', message: 'expected 0 or 1 or 2 or 130 or 143, received 3' },
    ])
    assert.deepEqual(
      issues(retestEventSchema, { ...sample('run.finished'), failure: { class: 'lost', message: 'x' } }).map((issue) => issue.path),
      ['$.failure.class'],
    )
    assert.deepEqual(issues(retestEventSchema, { ...sample('browser.started'), pid: 0 }), [
      { path: '$.pid', message: 'expected integer >= 1, received 0' },
    ])
    assert.deepEqual(issues(retestEventSchema, without(sample('browser.started'), 'executablePath')), [
      { path: '$.executablePath', message: 'missing required key' },
    ])
    assert.deepEqual(issues(retestEventSchema, { ...sample('assertion.failed'), actual: { text: 'Release', truncated: false } }), [
      { path: '$.actual.length', message: 'missing required key' },
    ])
    assert.deepEqual(issues(retestEventSchema, { ...sample('collection.completed'), tests: [{ ...sample('test.started').location }] }), [
      { path: '$.tests[0].testId', message: 'missing required key' },
      { path: '$.tests[0].name', message: 'missing required key' },
      { path: '$.tests[0].location', message: 'missing required key' },
      { path: '$.tests[0].file', message: 'unknown key' },
      { path: '$.tests[0].line', message: 'unknown key' },
      { path: '$.tests[0].column', message: 'unknown key' },
    ])
  })

  test('child events carry no stamp, and stamping one makes a full event', () => {
    for (const event of childEvents) {
      roundTrips(childEventSchema, event)
      assert.equal(parse(retestEventSchema, { ...stamp, ...written(event) }).ok, true)
    }
    assert.deepEqual(
      issues(childEventSchema, { ...stamp, ...childEvents[0] }).map((issue) => issue.path),
      ['$.schemaVersion', '$.runId', '$.sequence', '$.time', '$.elapsedMs', '$.origin'],
    )
    assert.deepEqual(issues(childEventSchema, { ...childEvents[0], ...variant }), [
      { path: '$.variant', message: 'unknown key' },
      { path: '$.variantKey', message: 'unknown key' },
    ])
    const testFinished = without(sample('test.finished'), 'schemaVersion')
    assert.match(issues(childEventSchema, testFinished)[0]?.message ?? '', /^expected one of "step.started", /)
  })

  test('a locator assertion the test process sends names its look and carries its check; the parent reads check and never writes it', () => {
    const sent: ChildEvent = {
      type: 'assertion.passed',
      ...scope,
      matcher: 'toHaveText',
      locator,
      expected: truncateText('x'.repeat(5000)),
      actual: null,
      attempts: 2,
      durationMs: 60,
      observationId: 'o2',
      check: { matcher: 'toHaveText', text: 'x'.repeat(5000) },
    }
    roundTrips(childEventSchema, sent)
    roundTrips(childEventSchema, { ...sent, type: 'assertion.failed', failure, check: { matcher: 'toHaveCount', count: 3 } })
    assert.deepEqual(issues(retestEventSchema, { ...stamp, ...sent, judgedBy: 'parent' }), [{ path: '$.check', message: 'unknown key' }])
    assert.deepEqual(issues(childEventSchema, { ...sent, check: { matcher: 'toBe' } }).map((issue) => issue.path), ['$.check.matcher'])
  })

  test('judgedBy is the parent\'s mark on a passed assertion, never the test process\'s, and never on a failure', () => {
    const passed: ChildEvent = { type: 'assertion.passed', ...scope, matcher: 'toBe', expected: truncateText('2'), actual: truncateText('2'), attempts: 1, durationMs: 0 }
    roundTrips(childEventSchema, passed)
    assert.deepEqual(issues(childEventSchema, { ...passed, judgedBy: 'child' }), [{ path: '$.judgedBy', message: 'unknown key' }])
    roundTrips(retestEventSchema, { ...stamp, origin: 'child', ...passed, judgedBy: 'child' })
    assert.deepEqual(issues(retestEventSchema, { ...stamp, origin: 'child', ...passed }), [{ path: '$.judgedBy', message: 'missing required key' }], 'an assertion.passed without judgedBy is not a version 1 event')
    assert.deepEqual(issues(retestEventSchema, { ...sample('assertion.failed'), judgedBy: 'parent' }), [{ path: '$.judgedBy', message: 'unknown key' }])
    assert.deepEqual(issues(retestEventSchema, { ...sample('assertion.passed'), judgedBy: 'browser' }), [
      { path: '$.judgedBy', message: 'expected one of "parent", "child", received "browser"' },
    ])
  })

  test('the JSON Schema has one closed object per event type', () => {
    const schema = toJsonSchema(retestEventSchema)
    assert.equal(schema.oneOf?.length, new Set(events.map((event) => event.type)).size)
    for (const option of schema.oneOf ?? []) {
      assert.equal(option.additionalProperties, false)
      for (const key of ['schemaVersion', 'type', 'runId', 'sequence', 'time', 'elapsedMs', 'origin']) {
        assert.ok(option.required?.includes(key), `${JSON.stringify(option.properties?.['type'])} requires ${key}`)
      }
      // A host check always names the app whose page it read.
      const type = option.properties?.['type']?.const
      assert.equal(option.required?.includes('session'), type === 'host_check.passed' || type === 'host_check.failed', String(type))
    }
  })
})

describe('commands', () => {
  const commands: PageCommand[] = [
    { kind: 'goto', url: '/' },
    { kind: 'fill', locator: { by: 'testId', value: 'task-title' }, value: 'Release checklist' },
    { kind: 'fill', locator: { by: 'label', text: 'Password' }, value: { secret: 'password' } },
    { kind: 'click', locator: { by: 'testId', value: 'save-task' } },
    { kind: 'tap', locator: { by: 'role', role: 'button', name: 'Menu', exact: false } },
    { kind: 'press', locator: { by: 'label', text: 'Search' }, key: 'Enter' },
    { kind: 'press', key: 'Shift+Tab' },
    { kind: 'select', locator: { by: 'label', text: 'Country' }, choices: [{ label: 'Canada' }] },
    { kind: 'select', locator: { by: 'testId', value: 'colours' }, choices: [{ label: 'Red' }, { value: 'b' }] },
    { kind: 'select', locator: { by: 'testId', value: 'colours' }, choices: [] },
    { kind: 'select', locator: { by: 'testId', value: 'colours' }, choices: [{ label: 'Red' }], multiple: true },
    { kind: 'select', locator: { by: 'testId', value: 'colours' }, choices: [{ label: 'Red' }, { value: 'b' }], multiple: true },
    { kind: 'check', locator: { by: 'role', role: 'checkbox', name: 'Remember me' } },
    { kind: 'uncheck', locator: { by: 'label', text: 'Newsletter' } },
    { kind: 'scroll', x: 0, y: 600 },
    { kind: 'scroll', locator: { by: 'testId', value: 'terms' }, x: -40.5, y: 1200 },
    { kind: 'scroll', x: 0, y: 0 },
    { kind: 'swipe', direction: 'up' },
    { kind: 'swipe', locator: { by: 'testId', value: 'task-list' }, direction: 'left' },
    { kind: 'nativeKeyboard', operation: 'wait' },
    { kind: 'nativeKeyboard', operation: 'dismiss' },
    { kind: 'nativeKeyboard', operation: 'dismissFirstRunCard' },
    { kind: 'nativeAlert', operation: 'accept', button: 'Allow' },
    { kind: 'nativeAlert', operation: 'dismiss', button: 'Not Now' },
    { kind: 'observe', locator },
    { kind: 'observe', locator: { by: 'text', text: 'Saved' } },
  ]
  const many = Array.from({ length: 101 }, (_, index) => ({ text: `Task ${index}`, visible: index % 2 === 0 }))
  const results: CommandResult[] = [
    { ok: true, kind: 'goto', url: pageUrl },
    { ok: true, kind: 'goto', url: pageUrl, page: { url: pageUrl, title: 'Tasks' } },
    { ok: true, kind: 'fill' },
    { ok: true, kind: 'click' },
    { ok: true, kind: 'click', page: { url: pageUrl } },
    { ok: true, kind: 'tap' },
    { ok: true, kind: 'press' },
    { ok: true, kind: 'scroll', page: { url: pageUrl, title: 'Terms' } },
    { ok: true, kind: 'swipe' },
    { ok: true, kind: 'nativeKeyboard' },
    { ok: true, kind: 'nativeAlert' },
    { ok: true, kind: 'select', changed: true, page: { url: pageUrl, title: 'Sign up' } },
    { ok: true, kind: 'select', changed: false },
    { ok: true, kind: 'check', changed: true, via: 'label' },
    { ok: true, kind: 'uncheck', changed: false },
    { ok: true, kind: 'observe', observation: observationOf([{ text: 'Saved', visible: true }]), observationId: 'o4', page: { url: pageUrl, title: 'Tasks' } },
    { ok: true, kind: 'observe', observation: observationOf([{ text: 'Release checklist', visible: true }]) },
    { ok: true, kind: 'observe', observation: observationOf([{ text: 'Saved', visible: true }]), observationId: 'o3' },
    { ok: true, kind: 'observe', observation: observationOf([{ text: '', visible: true }], 'Release checklist') },
    { ok: true, kind: 'observe', observation: observationOf([]) },
    { ok: true, kind: 'observe', observation: observationOf(many) },
    { ok: false, failure: { class: 'ambiguous', message: 'Two elements match.' } },
  ]

  test('every command and result survives a JSON round trip', () => {
    for (const command of commands) roundTrips(pageCommandSchema, command)
    for (const result of results) roundTrips(commandResultSchema, result)
  })

  test('malformed commands and results are rejected', () => {
    assert.deepEqual(issues(pageCommandSchema, { kind: 'drag', locator }), [
      {
        path: '$.kind',
        message:
          'expected one of "goto", "reload", "goBack", "goForward", "fill", "click", "tap", "hover", "press", "select", "check", "uncheck", "scroll", "swipe", "nativeKeyboard", "nativeAlert", "observe", "observePage", received "drag"',
      },
    ])
    assert.deepEqual(issues(pageCommandSchema, { kind: 'reload', url: '/' }), [{ path: '$.url', message: 'unknown key' }])
    assert.deepEqual(issues(pageCommandSchema, { kind: 'observePage', locator }), [{ path: '$.locator', message: 'unknown key' }])
    assert.deepEqual(issues(commandResultSchema, { ok: true, kind: 'goBack' }), [{ path: '$.url', message: 'missing required key' }])
    assert.deepEqual(issues(commandResultSchema, { ok: true, kind: 'observePage', observation: { url: null } }).map((issue) => issue.path), ['$.observation.title'])
    assert.deepEqual(issues(pageCommandSchema, { kind: 'select', locator, choices: 'Canada' }), [{ path: '$.choices', message: 'expected array, received "Canada"' }])
    assert.deepEqual(issues(pageCommandSchema, { kind: 'select', locator, choices: [{ label: 'Canada', value: 'ca' }] }).map((issue) => issue.path), [
      '$.choices[0].value',
    ])
    assert.deepEqual(issues(pageCommandSchema, { kind: 'select', locator, choices: [{ text: 'Canada' }] }).map((issue) => issue.path), [
      '$.choices[0].label',
      '$.choices[0].text',
    ])
    assert.deepEqual(issues(pageCommandSchema, { kind: 'select', locator, choices: [{ label: 'Red' }], multiple: false }), [
      { path: '$.multiple', message: 'expected true, received false' },
    ])
    assert.deepEqual(issues(pageCommandSchema, { kind: 'check', locator, force: true }), [{ path: '$.force', message: 'unknown key' }])
    assert.deepEqual(issues(pageCommandSchema, { kind: 'uncheck' }), [{ path: '$.locator', message: 'missing required key' }])
    assert.deepEqual(issues(pageCommandSchema, { kind: 'scroll', y: 600 }), [{ path: '$.x', message: 'missing required key' }])
    assert.deepEqual(issues(pageCommandSchema, { kind: 'scroll', x: '0', y: 600 }), [{ path: '$.x', message: 'expected number, received "0"' }])
    assert.deepEqual(issues(pageCommandSchema, { kind: 'swipe', direction: 'sideways' }), [{ path: '$.direction', message: 'expected one of "up", "down", "left", "right", received "sideways"' }])
    assert.deepEqual(issues(pageCommandSchema, { kind: 'nativeKeyboard', operation: 'type' }), [{ path: '$.operation', message: 'expected one of "dismiss", "dismissFirstRunCard", "wait", received "type"' }])
    assert.deepEqual(issues(pageCommandSchema, { kind: 'nativeAlert', operation: 'accept', button: 'OK', locator }), [{ path: '$.locator', message: 'unknown key' }])
    assert.deepEqual(issues(commandResultSchema, { ok: true, kind: 'select' }), [{ path: '$.changed', message: 'missing required key' }])
    assert.deepEqual(issues(commandResultSchema, { ok: true, kind: 'click', changed: true }), [{ path: '$.changed', message: 'unknown key' }])
    assert.deepEqual(issues(commandResultSchema, { ok: true, kind: 'select', changed: false, via: 'label' }), [{ path: '$.via', message: 'unknown key' }])
    assert.deepEqual(issues(commandResultSchema, { ok: true, kind: 'check', changed: true, via: 'control' }), [
      { path: '$.via', message: 'expected "label", received "control"' },
    ])
    assert.deepEqual(issues(commandResultSchema, { ok: true, kind: 'press', page: { url: pageUrl, title: 7 } }), [
      { path: '$.page.title', message: 'expected string, received 7' },
    ])
    assert.deepEqual(issues(commandResultSchema, { ok: true, kind: 'press', page: { title: 'Tasks' } }), [{ path: '$.page.url', message: 'missing required key' }])
    assert.deepEqual(issues(pageCommandSchema, { kind: 'press', locator }), [{ path: '$.key', message: 'missing required key' }])
    assert.deepEqual(issues(pageCommandSchema, { kind: 'press', key: 13 }), [{ path: '$.key', message: 'expected string, received 13' }])
    assert.deepEqual(issues(pageCommandSchema, { kind: 'press', key: 'a', modifiers: ['Control'] }), [{ path: '$.modifiers', message: 'unknown key' }])
    assert.deepEqual(issues(commandResultSchema, { ok: true, kind: 'press', observationId: 'o1' }), [{ path: '$.observationId', message: 'unknown key' }])
    assert.deepEqual(issues(pageCommandSchema, { kind: 'fill', locator, value: { secret: 'password', value: 'hunter2' } }), [
      { path: '$.value.value', message: 'unknown key' },
    ])
    assert.deepEqual(issues(pageCommandSchema, { kind: 'fill', locator, value: 42 }), [
      { path: '$.value', message: 'expected string or object, received 42' },
    ])
    assert.deepEqual(issues(pageCommandSchema, { kind: 'click', locator, force: true }), [
      { path: '$.force', message: 'unknown key' },
    ])
    const observation = observationOf([{ text: 'x', visible: true }])
    assert.deepEqual(issues(commandResultSchema, { ok: true, kind: 'observe', observation: { ...observation, visible: 'yes' } }), [
      { path: '$.observation.visible', message: 'expected boolean or null, received "yes"' },
    ])
    assert.deepEqual(issues(commandResultSchema, { ok: true, kind: 'observe', observation: without(observation, 'items') }), [
      { path: '$.observation.items', message: 'missing required key' },
    ])
    assert.deepEqual(issues(commandResultSchema, { ok: true, kind: 'observe', observation: { ...observation, items: [{ text: 'x' }] } }), [
      { path: '$.observation.items[0].visible', message: 'missing required key' },
    ])
    assert.deepEqual(issues(commandResultSchema, { ok: true, kind: 'fill', url: pageUrl }), [
      { path: '$.url', message: 'unknown key' },
    ])
    assert.deepEqual(issues(commandResultSchema, { ok: false }), [{ path: '$.failure', message: 'missing required key' }])
  })

  test('each command is named as a test writes it, never with the fill value', () => {
    const quoted = { by: 'testId', value: "it's" } as const
    assert.equal(describeCommand({ kind: 'goto', url: '/tasks?x=1' }), 'page.goto("/tasks?x=1")')
    assert.equal(describeCommand({ kind: 'click', locator: quoted }), "getByTestId('it\\'s').click()")
    assert.equal(describeCommand({ kind: 'fill', locator: quoted, value: 'secret' }), "getByTestId('it\\'s').fill()")
    assert.equal(describeCommand({ kind: 'observe', locator: quoted }), "a look at getByTestId('it\\'s')")
    assert.equal(describeCommand({ kind: 'tap', locator: quoted }), "getByTestId('it\\'s').tap()")
    assert.equal(describeCommand({ kind: 'press', locator: { by: 'label', text: 'Search' }, key: 'Enter' }), "getByLabel('Search').press('Enter')")
    assert.equal(describeCommand({ kind: 'press', key: 'Enter' }), "page.keyboard.press('Enter')")
    assert.equal(describeCommand({ kind: 'press', key: "'" }), "page.keyboard.press('\\'')")
    assert.equal(describeCommand({ kind: 'press', key: 'x'.repeat(500) }), `page.keyboard.press('${'x'.repeat(200)}…')`)
    assert.equal(
      describeCommand({ kind: 'fill', locator: { by: 'label', text: 'Password' }, value: { secret: 'password' } }),
      `getByLabel('Password').fill(secret("password"))`,
    )
  })

  test('select, check, uncheck and scroll are named as a test writes them', () => {
    const country = { by: 'label', text: 'Country' } as const
    assert.equal(describeCommand({ kind: 'select', locator: country, choices: [{ label: 'Canada' }] }), "getByLabel('Country').select('Canada')")
    assert.equal(describeCommand({ kind: 'select', locator: country, choices: [{ value: 'ca' }] }), "getByLabel('Country').select({ value: 'ca' })")
    assert.equal(
      describeCommand({ kind: 'select', locator: { by: 'testId', value: 'colours' }, choices: [{ label: 'Red' }, { value: 'b' }] }),
      "getByTestId('colours').select(['Red', { value: 'b' }])",
    )
    assert.equal(describeCommand({ kind: 'select', locator: country, choices: [] }), "getByLabel('Country').select([])")
    assert.equal(describeCommand({ kind: 'select', locator: country, choices: [{ label: 'Canada' }], multiple: true }), "getByLabel('Country').select(['Canada'])")
    assert.equal(
      describeCommand({ kind: 'select', locator: country, choices: [{ label: 'Red' }, { value: 'b' }], multiple: true }),
      "getByLabel('Country').select(['Red', { value: 'b' }])",
    )
    assert.equal(describeCommand({ kind: 'select', locator: country, choices: [], multiple: true }), "getByLabel('Country').select([])")
    assert.equal(describeCommand({ kind: 'select', locator: country, choices: [{ label: "Côte d'Ivoire" }] }), "getByLabel('Country').select('Côte d\\'Ivoire')")
    assert.equal(describeCommand({ kind: 'select', locator: country, choices: [{ label: 'x'.repeat(500) }] }), `getByLabel('Country').select('${'x'.repeat(200)}…')`)
    const remember = { by: 'role', role: 'checkbox', name: 'Remember me' } as const
    assert.equal(describeCommand({ kind: 'check', locator: remember }), "getByRole('checkbox', { name: 'Remember me' }).check()")
    assert.equal(describeCommand({ kind: 'uncheck', locator: remember }), "getByRole('checkbox', { name: 'Remember me' }).uncheck()")
    assert.equal(describeCommand({ kind: 'scroll', x: 0, y: 600 }), 'page.scroll({ y: 600 })')
    assert.equal(describeCommand({ kind: 'scroll', x: 120, y: 0 }), 'page.scroll({ x: 120 })')
    assert.equal(describeCommand({ kind: 'scroll', locator: { by: 'testId', value: 'terms' }, x: -40.5, y: 1200 }), "getByTestId('terms').scroll({ x: -40.5, y: 1200 })")
    assert.equal(describeCommand({ kind: 'scroll', x: 0, y: 0 }), 'page.scroll({ x: 0, y: 0 })')
  })

  test('swipes and the software keyboard are named as a test writes them', () => {
    assert.equal(describeCommand({ kind: 'swipe', direction: 'up' }), "page.swipe('up')")
    assert.equal(describeCommand({ kind: 'swipe', locator: { by: 'testId', value: 'task-list' }, direction: 'left' }), "getByTestId('task-list').swipe('left')")
    assert.equal(describeCommand({ kind: 'nativeKeyboard', operation: 'wait' }), 'page.keyboard.wait()')
    assert.equal(describeCommand({ kind: 'nativeKeyboard', operation: 'dismiss' }), 'page.keyboard.dismiss()')
    assert.equal(describeCommand({ kind: 'nativeKeyboard', operation: 'dismissFirstRunCard' }), 'page.keyboard.dismissFirstRunCard()')
  })
})

describe('recorded URLs', () => {
  test('lose their user name and password, and nothing else', () => {
    assert.equal(withoutCredentials('http://ada:secret@127.0.0.1:4173/app?x=1#top'), 'http://127.0.0.1:4173/app?x=1#top')
    assert.equal(withoutCredentials('https://ada@example.test'), 'https://example.test/')
    assert.equal(withoutCredentials('http://127.0.0.1:4173'), 'http://127.0.0.1:4173')
    assert.equal(withoutCredentials('not a url'), 'not a url')
  })

  test('are web addresses only when http or https, and name their origin then', () => {
    assert.deepEqual(['https://a.test/x', 'http://127.0.0.1:1', 'about:blank', 'file:///tmp/a', 'ws://a.test'].map((text) => isWebUrl(URL.parse(text))), [true, true, false, false, false])
    assert.equal(isWebUrl(null), false)
    assert.deepEqual(['http://127.0.0.1:4173/login?next=/', 'about:blank', 'data:text/html,x', 'nonsense', undefined].map(originOf), ['http://127.0.0.1:4173', undefined, undefined, undefined, undefined])
  })

  test('name an origin only when they are one, with or without a trailing slash', () => {
    assert.deepEqual(['https://Example.test/', 'https://example.test', 'http://127.0.0.1:4173'].map(readOrigin), ['https://example.test', 'https://example.test', 'http://127.0.0.1:4173'])
    assert.deepEqual(['https://example.test/login', 'https://example.test/?a=1', 'https://example.test/#top', 'ftp://example.test', 'example.test'].map(readOrigin), [undefined, undefined, undefined, undefined, undefined])
  })
})

describe('messages', () => {
  const parentMessages: ParentMessage[] = [
    { type: 'collect', file: '/work/examples/task.retest.ts', rootDir: '/work' },
    { type: 'run', ...scope, timeouts: { ...defaultTimeouts, action: 500 }, apps: ['page'] },
    { type: 'run', ...scope, timeouts: defaultTimeouts, apps: ['web', 'mobile'], variant: variant.variant },
    { type: 'command-result', id: 1, result: { ok: true, kind: 'goto', url: pageUrl } },
    { type: 'command-result', id: 3, result: { ok: true, kind: 'check', changed: false, page: { url: pageUrl, title: 'Settings' } } },
    { type: 'command-result', id: 2, result: { ok: false, failure: { class: 'timeout', message: 'Out of time.' } } },
    { type: 'abort', reason: 'The test ran out of time.' },
    { type: 'close' },
  ]
  const childMessages: ChildMessage[] = [
    { type: 'collected', tests: [{ name: 'saves a task', location }, { name: 'slow', location, timeout: 90_000 }] },
    {
      type: 'collected',
      tests: [
        {
          name: 'archives "Release checklist"',
          location,
          describes: [{ name: 'archive', location: { ...location, line: 2 } }],
          tags: ['smoke'],
          apps: ['owner', 'member'],
          state: { owner: 'owner-signed-in', member: 'member-signed-in' },
          row: { template: 'archives "$title"', index: 0 },
        },
        { name: 'signed-in', location, apps: ['web'], setup: true },
        { name: 'uses a state', location, state: 'signed-in' },
      ],
    },
    { type: 'collected', tests: [] },
    { type: 'collection-failed', failure: { class: 'collection_failed', message: 'Two tests are named "saves a task".' } },
    { type: 'command', ...scope, id: 1, app: 'page', command: { kind: 'goto', url: '/' }, timeoutMs: 30_000 },
    { type: 'command', ...scope, id: 2, app: 'page', command: { kind: 'click', locator }, location, timeoutMs: 0 },
    { type: 'command', ...scope, id: 3, app: 'owner', command: { kind: 'observe', locator }, location, stepId: 'step-2', timeoutMs: 300 },
    { type: 'command', ...scope, id: 4, app: 'member', command: { kind: 'fill', locator, value: { secret: 'password' } }, timeoutMs: 300 },
    { type: 'command', ...scope, id: 5, app: 'page', command: { kind: 'select', locator, choices: [{ label: 'Canada' }] }, timeoutMs: 300 },
    { type: 'command', ...scope, id: 6, app: 'page', command: { kind: 'scroll', x: 0, y: 600 }, stepId: 'step-1', timeoutMs: 300 },
    { type: 'command', ...scope, id: 7, app: 'page', command: { kind: 'select', locator, choices: [{ value: 'b' }], multiple: true }, timeoutMs: 300 },
    ...childEvents.map((event): ChildMessage => ({ type: 'event', event })),
    { type: 'test-finished', ...scope, status: 'passed', assertionCount: 2, durationMs: 120 },
    { type: 'test-finished', ...scope, status: 'failed', failure, assertionCount: 0, durationMs: 5 },
    { type: 'process-error', failure: { class: 'test_error', message: 'Error: thrown after the last test', location } },
  ]

  test('every message survives a JSON round trip', () => {
    for (const message of parentMessages) roundTrips(parentMessageSchema, message)
    for (const message of childMessages) roundTrips(childMessageSchema, message)
  })

  test('malformed messages are rejected with the path to the problem', () => {
    assert.deepEqual(issues(parentMessageSchema, { type: 'close', reason: 'done' }), [
      { path: '$.reason', message: 'unknown key' },
    ])
    assert.deepEqual(issues(parentMessageSchema, { type: 'run', ...scope, timeouts: without(defaultTimeouts, 'action'), apps: [] }), [
      { path: '$.timeouts.action', message: 'missing required key' },
    ])
    assert.deepEqual(issues(parentMessageSchema, { type: 'run', ...scope, timeouts: defaultTimeouts }), [
      { path: '$.apps', message: 'missing required key' },
    ])
    assert.deepEqual(issues(childMessageSchema, { type: 'command', ...scope, id: 1, command: { kind: 'goto', url: '/' }, timeoutMs: 1 }), [
      { path: '$.app', message: 'missing required key' },
    ])
    assert.deepEqual(issues(childMessageSchema, { type: 'collected', tests: [{ name: 'x', location, setup: false }] }), [
      { path: '$.tests[0].setup', message: 'expected true, received false' },
    ])
    assert.deepEqual(issues(childMessageSchema, { type: 'collected', tests: [{ name: 'x', location, state: ['a'] }] }), [
      { path: '$.tests[0].state', message: 'expected string or object, received array' },
    ])
    assert.deepEqual(issues(childMessageSchema, { type: 'collected', tests: [{ name: 'x', location, row: { template: 'x', index: -1 } }] }), [
      { path: '$.tests[0].row.index', message: 'expected integer >= 0, received -1' },
    ])
    assert.deepEqual(issues(parentMessageSchema, 'close'), [{ path: '$', message: 'expected object, received "close"' }])
    assert.deepEqual(issues(childMessageSchema, { type: 'collected', tests: [{ name: 'x', location, timeout: 0 }] }), [
      { path: '$.tests[0].timeout', message: 'expected integer >= 1, received 0' },
    ])
    assert.deepEqual(issues(childMessageSchema, { type: 'command', ...scope, id: 1.5, app: 'page', command: { kind: 'goto', url: '/' }, timeoutMs: 1 }), [
      { path: '$.id', message: 'expected integer >= 0, received 1.5' },
    ])
    assert.deepEqual(
      issues(childMessageSchema, { type: 'event', event: { ...stamp, ...childEvents[0] } }).map((issue) => issue.path),
      ['$.event.schemaVersion', '$.event.runId', '$.event.sequence', '$.event.time', '$.event.elapsedMs', '$.event.origin'],
    )
    assert.deepEqual(issues(childMessageSchema, { type: 'test-finished', ...scope, status: 'error', assertionCount: 0, durationMs: 1 }), [
      { path: '$.status', message: 'expected one of "passed", "failed", received "error"' },
    ])
    assert.deepEqual(issues(childMessageSchema, { type: 'process-error', failure: { class: 'test_error' } }), [
      { path: '$.failure.message', message: 'missing required key' },
    ])
  })
})

describe('result', () => {
  const result: RunResult = {
    schemaVersion: 1,
    runId: 'run-1',
    retestVersion: '0.0.0',
    startedAt: '2026-09-30T09:15:00.000Z',
    finishedAt: '2026-09-30T09:15:06.000Z',
    complete: false,
    status: 'failed',
    exitCode: 1,
    durationMs: 6000,
    browser: { product: 'Chrome', version: '141.0.0.0', executablePath: '/usr/bin/chromium' },
    counts: { passed: 1, failed: 1, error: 0, notRun: 1, inconclusive: 0 },
    files: [
      {
        file: 'examples/task.retest.ts',
        collection: 'ok',
        tests: [
          { ...scope, name: 'saves a task', file: 'examples/task.retest.ts', location, status: 'passed', durationMs: 90, assertionCount: 1, evidence: [] },
          {
            ...scope,
            name: 'shows the count',
            file: 'examples/task.retest.ts',
            location,
            status: 'failed',
            durationMs: 5100,
            assertionCount: 1,
            failure,
            cleanupFailures: [{ class: 'cleanup_failed', message: 'The context did not close.' }],
            evidence: [{ kind: 'screenshot', path: 'artifacts/shows-the-count-failure.png' }],
          },
          {
            ...scope,
            name: 'places an order',
            file: 'examples/task.retest.ts',
            location,
            status: 'failed',
            durationMs: 2100,
            assertionCount: 2,
            failure: { class: 'check_failed', message: 'The page is on /login, expected /done.' },
            hostChecks: [
              { check: { kind: 'address', origin: 'https://shop.example', path: '/done' }, app: 'web', status: 'failed', failure: { class: 'check_failed', message: 'x' } },
              { check: { kind: 'text', text: 'Payment failed', absent: true }, app: 'web', status: 'passed' },
            ],
            evidence: [{ kind: 'screenshot', path: 'artifacts/places-an-order-failure.png', app: 'web' }],
          },
          {
            ...scope,
            name: 'never started',
            file: 'examples/task.retest.ts',
            location,
            status: 'not_run',
            durationMs: 0,
            assertionCount: 0,
            hostChecks: [{ check: { kind: 'text', text: 'Saved' }, app: 'web', status: 'not_run' }],
            evidence: [],
          },
          { ...scope, name: 'never ran', file: 'examples/task.retest.ts', location, status: 'not_run', durationMs: 0, assertionCount: 0, evidence: [] },
          {
            ...scope,
            ...variant,
            name: 'signed-in',
            file: 'examples/task.retest.ts',
            location,
            describePath: ['archive'],
            setup: true,
            status: 'failed',
            durationMs: 900,
            assertionCount: 1,
            failure,
            evidence: [
              { kind: 'screenshot', path: 'artifacts/signed-in-web-failure.png', app: 'web' },
              { kind: 'screenshot', path: 'artifacts/signed-in-mobile-failure.png', app: 'mobile' },
            ],
          },
        ],
      },
      { file: 'broken.retest.ts', collection: 'failed', failure: { class: 'collection_failed', message: 'x' }, tests: [] },
    ],
  }

  test('a full result survives a JSON round trip, with or without a browser or a failure of its own', () => {
    roundTrips(runResultSchema, result)
    roundTrips(runResultSchema, { ...result, browser: null })
    roundTrips(runResultSchema, { ...result, failure: { class: 'reporting_failed', message: 'Retest could not write events.jsonl.' } })
    const pixelBrowser = { ...result.browser, app: 'mobile', target: { name: 'pixel', device: 'Pixel 9', emulation: pixel } }
    roundTrips(runResultSchema, { ...result, browsers: [{ ...result.browser, app: 'web', target: { name: 'beta' } }, pixelBrowser] })
  })

  test('malformed results are rejected with the path to the problem', () => {
    const [file] = result.files
    assert.ok(file)
    const video = { ...file, tests: file.tests.map((entry) => ({ ...entry, evidence: [{ kind: 'video', path: 'a.webm' }] })) }
    assert.deepEqual(issues(runResultSchema, { ...result, files: [video] })[0], {
      path: '$.files[0].tests[0].evidence[0].kind',
      message: 'expected "screenshot", received "video"',
    })
    assert.deepEqual(issues(runResultSchema, without(result, 'browser')), [{ path: '$.browser', message: 'missing required key' }])
    const unknownStatus = { ...file, tests: [{ ...file.tests[0], hostChecks: [{ check: { kind: 'text', text: 'Saved' }, app: 'web', status: 'skipped' }] }] }
    assert.deepEqual(issues(runResultSchema, { ...result, files: [unknownStatus] }), [
      { path: '$.files[0].tests[0].hostChecks[0].status', message: 'expected one of "passed", "failed", "not_run", received "skipped"' },
    ])
    assert.deepEqual(issues(runResultSchema, { ...result, counts: without(result.counts, 'notRun') }), [
      { path: '$.counts.notRun', message: 'missing required key' },
    ])
  })
})

test('protocol modules import only each other', () => {
  const directory = new URL('../../src/protocol/', import.meta.url)
  for (const file of readdirSync(directory)) {
    const source = readFileSync(new URL(file, directory), 'utf8')
    for (const [, specifier] of source.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
      assert.match(specifier ?? '', /^\.\/[a-z-]+\.ts$/, `${file} imports ${specifier}`)
    }
  }
})

test('native secret pixel branches and masked proof are additive version 1 records with closed values', () => {
  for (const nativeField of ['secure', 'plain', 'unreadable'] as const) {
    for (const entry of [
      { type: 'capture.masked_entry', ...scope, session: 'phone', sessionId: 'attempt-1:phone', secret: 'password', atUs: 1 },
      { type: 'capture.withheld', ...scope, session: 'phone', sessionId: 'attempt-1:phone', secret: 'password', cause: 'unknown', fromUs: 1 },
    ]) {
      const event = { ...stamp, ...entry }
      roundTrips(retestEventSchema, event)
      roundTrips(retestEventSchema, { ...event, nativeField })
      assert.ok(issues(retestEventSchema, { ...event, nativeField: 'assumed-secure' }).length > 0)
    }
  }
})
