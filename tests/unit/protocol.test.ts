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
  { type: 'test.started', ...scope, name: 'saves a task', file: 'examples/task.retest.ts', location },
  { type: 'test.started', ...scope, ...variant, name: 'archives a task', file: 'tests/archive.retest.ts', location, describePath: ['archive'], setup: true },
  { type: 'state.saved', ...scope, ...variant, state: 'signed-in', app: 'web', target: 'beta' },
  { type: 'state.restored', ...scope, ...variant, state: 'signed-in', app: 'web', target: 'beta' },
  { type: 'action.completed', ...scope, command: 'goto', pageUrl, durationMs: 40, location, session: 'page' },
  { type: 'action.completed', ...scope, stepId: 'step-1', command: 'fill', locator, pageUrl, durationMs: 8, valueLength: 17 },
  { type: 'action.completed', ...scope, ...variant, command: 'fill', locator: { by: 'label', text: 'Password' }, durationMs: 8, secret: 'password', session: 'web' },
  { type: 'action.completed', ...scope, ...variant, command: 'tap', locator: { by: 'role', role: 'button', name: 'Menu' }, durationMs: 30, session: 'mobile' },
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

const events: RetestEvent[] = [
  ...parentEvents.map((body): RetestEvent => ({ ...stamp, ...body })),
  ...childEvents.map((body): RetestEvent => ({ ...stamp, origin: 'child', ...body })),
  ...childEvents.map((body): RetestEvent => ({ ...stamp, origin: 'child', ...variant, ...body })),
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
    assert.deepEqual(issues(retestEventSchema, { ...sample('action.failed'), locator: { by: 'css', value: 'button' } }), [
      { path: '$.locator.by', message: 'expected one of "testId", "role", "label", "text", received "css"' },
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
    assert.deepEqual(issues(retestEventSchema, { ...sample('action.completed'), command: 'hover' }), [
      { path: '$.command', message: 'expected one of "goto", "fill", "click", "tap", received "hover"' },
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
      ['$.schemaVersion', '$.runId', '$.sequence', '$.time', '$.elapsedMs', '$.origin'],
    )
    assert.deepEqual(issues(childEventSchema, { ...childEvents[0], ...variant }), [
      { path: '$.variant', message: 'unknown key' },
      { path: '$.variantKey', message: 'unknown key' },
    ])
    const testFinished = without(sample('test.finished'), 'schemaVersion')
    assert.match(issues(childEventSchema, testFinished)[0]?.message ?? '', /^expected one of "step.started", /)
  })

  test('the JSON Schema has one closed object per event type', () => {
    const schema = toJsonSchema(retestEventSchema)
    assert.equal(schema.oneOf?.length, new Set(events.map((event) => event.type)).size)
    for (const option of schema.oneOf ?? []) {
      assert.equal(option.additionalProperties, false)
      for (const key of ['schemaVersion', 'type', 'runId', 'sequence', 'time', 'elapsedMs', 'origin']) {
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
    { kind: 'fill', locator: { by: 'label', text: 'Password' }, value: { secret: 'password' } },
    { kind: 'click', locator: { by: 'testId', value: 'save-task' } },
    { kind: 'tap', locator: { by: 'role', role: 'button', name: 'Menu', exact: false } },
    { kind: 'observe', locator },
    { kind: 'observe', locator: { by: 'text', text: 'Saved' } },
  ]
  const many = Array.from({ length: 101 }, (_, index) => ({ text: `Task ${index}`, visible: index % 2 === 0 }))
  const results: CommandResult[] = [
    { ok: true, kind: 'goto', url: pageUrl },
    { ok: true, kind: 'fill' },
    { ok: true, kind: 'click' },
    { ok: true, kind: 'tap' },
    { ok: true, kind: 'observe', observation: observationOf([{ text: 'Release checklist', visible: true }]) },
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
    assert.deepEqual(issues(pageCommandSchema, { kind: 'hover', locator }), [
      { path: '$.kind', message: 'expected one of "goto", "fill", "click", "tap", "observe", received "hover"' },
    ])
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
    assert.equal(
      describeCommand({ kind: 'fill', locator: { by: 'label', text: 'Password' }, value: { secret: 'password' } }),
      `getByLabel('Password').fill(secret("password"))`,
    )
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
    { type: 'command', id: 1, app: 'page', command: { kind: 'goto', url: '/' }, timeoutMs: 30_000 },
    { type: 'command', id: 2, app: 'page', command: { kind: 'click', locator }, location, timeoutMs: 0 },
    { type: 'command', id: 3, app: 'owner', command: { kind: 'observe', locator }, location, stepId: 'step-2', timeoutMs: 300 },
    { type: 'command', id: 4, app: 'member', command: { kind: 'fill', locator, value: { secret: 'password' } }, timeoutMs: 300 },
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
    assert.deepEqual(issues(childMessageSchema, { type: 'command', id: 1, command: { kind: 'goto', url: '/' }, timeoutMs: 1 }), [
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
    assert.deepEqual(issues(childMessageSchema, { type: 'command', id: 1.5, app: 'page', command: { kind: 'goto', url: '/' }, timeoutMs: 1 }), [
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
