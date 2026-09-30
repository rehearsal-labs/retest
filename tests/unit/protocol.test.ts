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
import {
  childMessageSchema,
  parentMessageSchema,
  type ChildMessage,
  type ParentMessage,
} from '../../src/protocol/messages.ts'
import { runResultSchema, type RunResult } from '../../src/protocol/result.ts'
import { parse, toJsonSchema, type Issue } from '../../src/protocol/schema.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { withoutCredentials } from '../../src/protocol/url.ts'

type AnySchema = Parameters<typeof parse>[0]

const location: SourceLocation = { file: 'examples/task.retest.ts', line: 7, column: 3 }
const failure: Failure = { class: 'check_failed', message: 'Expected "Release checklist", received "Release".', location }
const locator: LocatorRecipe = { by: 'testId', value: 'saved-task' }
const scope = { testId: 'examples/task.retest.ts > saves a task', attemptId: 'attempt-1' }
const pageUrl = 'http://127.0.0.1:4173/'
const stamp: EventStamp = { schemaVersion: 1, runId: 'run-1', sequence: 0, time: '2026-09-30T09:15:00.000Z', elapsedMs: 0 }

const childEvents: ChildEvent[] = [
  { type: 'step.started', ...scope, stepId: 'step-1', name: 'save the task', location, session: 'page' },
  { type: 'step.started', ...scope, stepId: 'step-2', parentStepId: 'step-1', name: 'inner' },
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
    type: 'browser.started',
    product: 'Chrome',
    version: '141.0.0.0',
    userAgent: 'Mozilla/5.0',
    pid: 4242,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  },
  { type: 'collection.completed', file: 'examples/task.retest.ts', tests: [{ testId: scope.testId, name: 'saves a task', location }] },
  { type: 'collection.failed', file: 'broken.retest.ts', failure: { class: 'collection_failed', message: 'Unexpected token.' } },
  { type: 'file.failed', file: 'examples/task.retest.ts', failure: { class: 'test_error', message: 'examples/task.retest.ts threw an error while no test was running: Error: late' } },
  { type: 'test.started', ...scope, name: 'saves a task', file: 'examples/task.retest.ts', location },
  { type: 'action.completed', ...scope, command: 'goto', pageUrl, durationMs: 40, location, session: 'page' },
  { type: 'action.completed', ...scope, stepId: 'step-1', command: 'fill', locator, pageUrl, durationMs: 8, valueLength: 17 },
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
  { type: 'evidence.captured', ...scope, kind: 'screenshot', path: 'artifacts/saves-a-task-failure.png', reason: 'failure' },
  { type: 'evidence.failed', ...scope, kind: 'screenshot', reason: 'failure', message: 'The browser closed.' },
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
]

const events: RetestEvent[] = [...parentEvents, ...childEvents].map((body, sequence) => ({ ...stamp, sequence, ...body }))

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
    assert.deepEqual(issues(retestEventSchema, { ...sample('action.failed'), locator: { by: 'role', value: 'button' } }), [
      { path: '$.locator.by', message: 'expected "testId", received "role"' },
    ])
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
      assert.equal(parse(retestEventSchema, { ...stamp, ...event }).ok, true)
    }
    assert.deepEqual(
      issues(childEventSchema, { ...stamp, ...childEvents[0] }).map((issue) => issue.path),
      ['$.schemaVersion', '$.runId', '$.sequence', '$.time', '$.elapsedMs'],
    )
    const testFinished = without(sample('test.finished'), 'schemaVersion')
    assert.match(issues(childEventSchema, testFinished)[0]?.message ?? '', /^expected one of "step.started", /)
  })

  test('the JSON Schema has one closed object per event type', () => {
    const schema = toJsonSchema(retestEventSchema)
    assert.equal(schema.oneOf?.length, new Set(events.map((event) => event.type)).size)
    for (const option of schema.oneOf ?? []) {
      assert.equal(option.additionalProperties, false)
      for (const key of ['schemaVersion', 'type', 'runId', 'sequence', 'time', 'elapsedMs']) {
        assert.ok(option.required?.includes(key), `${JSON.stringify(option.properties?.['type'])} requires ${key}`)
      }
      assert.equal(option.required?.includes('session'), false)
    }
  })
})

describe('commands', () => {
  const commands: PageCommand[] = [
    { kind: 'goto', url: '/' },
    { kind: 'fill', locator: { by: 'testId', value: 'task-title' }, value: 'Release checklist' },
    { kind: 'click', locator: { by: 'testId', value: 'save-task' } },
    { kind: 'observe', locator },
  ]
  const results: CommandResult[] = [
    { ok: true, kind: 'goto', url: pageUrl },
    { ok: true, kind: 'fill' },
    { ok: true, kind: 'click' },
    { ok: true, kind: 'observe', observation: { count: 1, visible: true, text: 'Release checklist' } },
    { ok: true, kind: 'observe', observation: { count: 0, visible: null, text: null } },
    { ok: false, failure: { class: 'ambiguous', message: 'Two elements match.' } },
  ]

  test('every command and result survives a JSON round trip', () => {
    for (const command of commands) roundTrips(pageCommandSchema, command)
    for (const result of results) roundTrips(commandResultSchema, result)
  })

  test('malformed commands and results are rejected', () => {
    assert.deepEqual(issues(pageCommandSchema, { kind: 'hover', locator }), [
      { path: '$.kind', message: 'expected one of "goto", "fill", "click", "observe", received "hover"' },
    ])
    assert.deepEqual(issues(pageCommandSchema, { kind: 'click', locator, force: true }), [
      { path: '$.force', message: 'unknown key' },
    ])
    assert.deepEqual(issues(commandResultSchema, { ok: true, kind: 'observe', observation: { count: 1, visible: 'yes', text: null } }), [
      { path: '$.observation.visible', message: 'expected boolean or null, received "yes"' },
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
  })
})

describe('recorded URLs', () => {
  test('lose their user name and password, and nothing else', () => {
    assert.equal(withoutCredentials('http://ada:secret@127.0.0.1:4173/app?x=1#top'), 'http://127.0.0.1:4173/app?x=1#top')
    assert.equal(withoutCredentials('https://ada@example.test'), 'https://example.test/')
    assert.equal(withoutCredentials('http://127.0.0.1:4173'), 'http://127.0.0.1:4173')
    assert.equal(withoutCredentials('not a url'), 'not a url')
  })
})

describe('messages', () => {
  const parentMessages: ParentMessage[] = [
    { type: 'collect', file: '/work/examples/task.retest.ts', rootDir: '/work' },
    { type: 'run', ...scope, timeouts: { ...defaultTimeouts, action: 500 } },
    { type: 'command-result', id: 1, result: { ok: true, kind: 'goto', url: pageUrl } },
    { type: 'command-result', id: 2, result: { ok: false, failure: { class: 'timeout', message: 'Out of time.' } } },
    { type: 'abort', reason: 'The test ran out of time.' },
    { type: 'close' },
  ]
  const childMessages: ChildMessage[] = [
    { type: 'collected', tests: [{ name: 'saves a task', location }, { name: 'slow', location, timeout: 90_000 }] },
    { type: 'collected', tests: [] },
    { type: 'collection-failed', failure: { class: 'collection_failed', message: 'Two tests are named "saves a task".' } },
    { type: 'command', id: 1, command: { kind: 'goto', url: '/' }, timeoutMs: 30_000 },
    { type: 'command', id: 2, command: { kind: 'click', locator }, location, timeoutMs: 0 },
    { type: 'command', id: 3, command: { kind: 'observe', locator }, location, stepId: 'step-2', timeoutMs: 300 },
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
    assert.deepEqual(issues(parentMessageSchema, { type: 'run', ...scope, timeouts: without(defaultTimeouts, 'action') }), [
      { path: '$.timeouts.action', message: 'missing required key' },
    ])
    assert.deepEqual(issues(parentMessageSchema, 'close'), [{ path: '$', message: 'expected object, received "close"' }])
    assert.deepEqual(issues(childMessageSchema, { type: 'collected', tests: [{ name: 'x', location, timeout: 0 }] }), [
      { path: '$.tests[0].timeout', message: 'expected integer >= 1, received 0' },
    ])
    assert.deepEqual(issues(childMessageSchema, { type: 'command', id: 1.5, command: { kind: 'goto', url: '/' }, timeoutMs: 1 }), [
      { path: '$.id', message: 'expected integer >= 0, received 1.5' },
    ])
    assert.deepEqual(
      issues(childMessageSchema, { type: 'event', event: { ...stamp, ...childEvents[0] } }).map((issue) => issue.path),
      ['$.event.schemaVersion', '$.event.runId', '$.event.sequence', '$.event.time', '$.event.elapsedMs'],
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
          { ...scope, name: 'never ran', file: 'examples/task.retest.ts', location, status: 'not_run', durationMs: 0, assertionCount: 0, evidence: [] },
        ],
      },
      { file: 'broken.retest.ts', collection: 'failed', failure: { class: 'collection_failed', message: 'x' }, tests: [] },
    ],
  }

  test('a full result survives a JSON round trip, with or without a browser or a failure of its own', () => {
    roundTrips(runResultSchema, result)
    roundTrips(runResultSchema, { ...result, browser: null })
    roundTrips(runResultSchema, { ...result, failure: { class: 'reporting_failed', message: 'Retest could not write events.jsonl.' } })
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
