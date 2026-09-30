import type { CommandResult } from '../../src/protocol/commands.ts'
import type { RetestEvent } from '../../src/protocol/events.ts'
import type { RunResult } from '../../src/protocol/result.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { retestEventSchema } from '../../src/protocol/events.ts'
import { runResultSchema } from '../../src/protocol/result.ts'
import { Redactor } from '../../src/runner/redactor.ts'

function runResult(fields: Partial<RunResult>): RunResult {
  return {
    schemaVersion: 1,
    runId: 'run',
    retestVersion: '0.0.0',
    startedAt: '',
    finishedAt: '',
    complete: true,
    status: 'passed',
    exitCode: 0,
    durationMs: 0,
    browser: null,
    counts: { passed: 0, failed: 0, error: 0, notRun: 0, inconclusive: 0 },
    files: [],
    ...fields,
  }
}

function taught(values: Record<string, string>): Redactor {
  const redactor = new Redactor()
  for (const [name, value] of Object.entries(values)) redactor.learn(name, value)
  return redactor
}

describe('Redactor', () => {
  test('passes text through until it learns a value', () => {
    const redactor = new Redactor()
    assert.equal(redactor.active, false)
    assert.equal(redactor.redact('hunter2 is here'), 'hunter2 is here')
    redactor.learn('password', 'hunter2')
    assert.equal(redactor.active, true)
    assert.equal(redactor.redact('hunter2 is here, hunter2 again'), '{{password}} is here, {{password}} again')
  })

  test('hides the longest value where values overlap, and ignores an empty one', () => {
    const redactor = taught({ short: 'abc', long: 'abcdef', empty: '' })
    assert.equal(redactor.redact('abcdef abc abcd'), '{{long}} {{short}} {{short}}d')
  })

  test('learns values read later, and names a value by its latest secret', () => {
    const redactor = taught({ code: '111' })
    redactor.learn('code', '222')
    redactor.learn('again', '111')
    assert.equal(redactor.redact('111 222'), '{{again}} {{code}}')
  })

  test('never reads its own placeholder as a value, so redacting twice changes nothing', () => {
    const redactor = taught({ password: 'pass' })
    assert.equal(redactor.redact(redactor.redact('pass')), '{{password}}')
  })

  test('hides a value that holds a placeholder rather than keeping the placeholder', () => {
    const redactor = taught({ password: 'pass', tricky: '{{password}}!' })
    assert.equal(redactor.redact('{{password}}! {{password}}'), '{{tricky}} {{password}}')
  })

  test('redacts the free text and the page URL of an event and never an identifier, even one that holds the value', () => {
    const redactor = taught({ password: 'xample' })
    const event: RetestEvent = {
      schemaVersion: 1,
      runId: 'run-xample',
      sequence: 3,
      time: '2026-09-30T12:00:00.000Z',
      elapsedMs: 10,
      origin: 'parent',
      type: 'action.failed',
      testId: 'tests/example.retest.ts > signs in as xample',
      attemptId: 'k3v9q0x2mb',
      variant: { xample: 'xample' },
      variantKey: 'xample=xample',
      stepId: 'step-xample',
      session: 'xample',
      command: 'fill',
      locator: { by: 'testId', value: 'xample-field' },
      pageUrl: 'http://xample.test/xample',
      durationMs: 5,
      location: { file: 'tests/example.retest.ts', line: 4, column: 3 },
      secret: 'xample',
      failure: {
        class: 'not_actionable',
        message: 'The field shows xample.',
        location: { file: 'tests/example.retest.ts', line: 4, column: 3 },
        details: { shown: 'xample', text: { text: 'said xample', truncated: false, length: 11 }, count: 1 },
      },
    }
    const redacted = redactor.redactFields(retestEventSchema, event)
    assert.deepEqual(redacted, {
      ...event,
      pageUrl: 'http://{{password}}.test/{{password}}',
      failure: {
        ...event.failure,
        message: 'The field shows {{password}}.',
        details: { shown: '{{password}}', text: { text: 'said {{password}}', truncated: false, length: 11 }, count: 1 },
      },
    })
  })

  test('redacts what an assertion expected and saw, and leaves its matcher and locator', () => {
    const redactor = taught({ password: 'hunter2' })
    const event: RetestEvent = {
      schemaVersion: 1,
      runId: 'run',
      sequence: 0,
      time: '',
      elapsedMs: 0,
      origin: 'child',
      type: 'assertion.passed',
      testId: 'tests/a.retest.ts > shows hunter2',
      attemptId: 'a',
      matcher: 'toHaveText',
      locator: { by: 'text', text: 'hunter2' },
      expected: { text: 'hunter2', truncated: false, length: 7 },
      actual: { text: 'hunter2!', truncated: false, length: 8 },
      attempts: 1,
      durationMs: 1,
    }
    const redacted = redactor.redactFields(retestEventSchema, event)
    assert.equal(redacted.type === 'assertion.passed' ? redacted.testId : undefined, 'tests/a.retest.ts > shows hunter2')
    assert.deepEqual(redacted.type === 'assertion.passed' ? [redacted.locator, redacted.expected?.text, redacted.actual?.text] : [], [
      { by: 'text', text: 'hunter2' },
      '{{password}}',
      '{{password}}!',
    ])
  })

  test('redacts the page text an answer carries to the test process, and nothing else in it', () => {
    const redactor = taught({ password: 'hunter2' })
    const observed: CommandResult = {
      ok: true,
      kind: 'observe',
      observation: { count: 2, visible: null, text: null, value: null, items: [{ text: 'hunter2', visible: true }, { text: 'plain', visible: false }], itemsTruncated: false },
    }
    assert.deepEqual(redactor.redactCommandResult(observed), {
      ...observed,
      observation: { ...observed.observation, items: [{ text: '{{password}}', visible: true }, { text: 'plain', visible: false }] },
    })
    const single: CommandResult = { ok: true, kind: 'observe', observation: { count: 1, visible: true, text: 'is hunter2', value: 'hunter2', items: [], itemsTruncated: false } }
    const redacted = redactor.redactCommandResult(single)
    assert.deepEqual(redacted.ok && redacted.kind === 'observe' ? [redacted.observation.text, redacted.observation.value] : [], ['is {{password}}', '{{password}}'])
    const moved: CommandResult = { ok: true, kind: 'goto', url: 'http://127.0.0.1/echo/hunter2' }
    assert.deepEqual(redactor.redactCommandResult(moved), { ...moved, url: 'http://127.0.0.1/echo/{{password}}' })
    assert.deepEqual(redactor.redactCommandResult({ ok: false, failure: { class: 'timeout', message: 'hunter2 was slow' } }), {
      ok: false,
      failure: { class: 'timeout', message: '{{password}} was slow' },
    })
  })

  test('redacts a result’s failures and leaves its files, ids, names and evidence paths', () => {
    const redactor = taught({ password: 'xample' })
    const result = runResult({
      failure: { class: 'usage', message: 'xample failed' },
      files: [
        {
          file: 'tests/example.retest.ts',
          collection: 'ok',
          tests: [
            {
              testId: 'tests/example.retest.ts > xample',
              name: 'xample',
              file: 'tests/example.retest.ts',
              location: { file: 'tests/example.retest.ts', line: 1, column: 1 },
              describePath: ['xample'],
              attemptId: 'a',
              status: 'failed',
              durationMs: 1,
              assertionCount: 1,
              failure: { class: 'check_failed', message: 'saw xample' },
              cleanupFailures: [{ class: 'cleanup_failed', message: 'xample stayed' }],
              evidence: [{ kind: 'screenshot', path: 'artifacts/xample-failure.png', app: 'xample' }],
            },
          ],
        },
      ],
    })
    const redacted = redactor.redactFields(runResultSchema, result)
    const [test] = redacted.files[0]?.tests ?? []
    assert.equal(redacted.failure?.message, '{{password}} failed')
    assert.deepEqual([test?.testId, test?.name, test?.describePath, test?.evidence], [
      'tests/example.retest.ts > xample',
      'xample',
      ['xample'],
      [{ kind: 'screenshot', path: 'artifacts/xample-failure.png', app: 'xample' }],
    ])
    assert.deepEqual([test?.failure?.message, test?.cleanupFailures?.[0]?.message], ['saw {{password}}', '{{password}} stayed'])
  })

  // Found by the milestone 2 verification: a page that put the value in its address wrote it percent-encoded, and
  // the redactor knew only the value as typed.
  test('hides a value in every form a URL gives it, and never a look-alike that decodes to something else', () => {
    const redactor = taught({ password: "it's a p@ss word/2" })
    const cases = [
      ["it's a p@ss word/2", 'the value as typed'],
      ["it's%20a%20p%40ss%20word%2F2", 'encodeURIComponent'],
      ["it's%20a%20p@ss%20word/2", 'encodeURI, and the URL standard writing a path'],
      ['it%27s+a+p%40ss+word%2F2', 'a form submission'],
      ["it%27s%20a%20p@ss%20word/2", "the URL standard writing a query, where ' is encoded"],
      ["it's%20a%20p@ss%20word/2#", 'a fragment, which encodes the space only'],
      ["it's%20a%20p%40ss%20word%2f2", 'lowercase hex'],
    ] as const
    for (const [written, how] of cases) {
      assert.equal(redactor.redact(`at ${written} here`), `at {{password}}${written.endsWith('#') ? '#' : ''} here`, how)
    }
    assert.equal(redactor.redact("it's a p@ss word/3 and it%27s+a+p%40ss+word%2F3"), "it's a p@ss word/3 and it%27s+a+p%40ss+word%2F3", 'another value stays')
    assert.equal(taught({ token: 'abcd-1234_ok' }).redact('abcd-1234_ok abcd%2D1234_ok'), '{{token}} abcd%2D1234_ok', 'only the forms a URL writes')
  })

  test('hides a value written into an address, in the navigation event, the page URL of an action and a check, and the addresses of apps', () => {
    const redactor = taught({ password: 'correct horse' })
    const stamp = { schemaVersion: 1, runId: 'run', sequence: 0, time: '', elapsedMs: 0, origin: 'parent' } as const
    const scope = { testId: 'tests/a.retest.ts > shows the path', attemptId: 'a' }
    const moved: RetestEvent = { ...stamp, type: 'navigation', ...scope, url: 'http://127.0.0.1:4173/echo/correct%20horse' }
    const acted: RetestEvent = { ...stamp, type: 'action.completed', ...scope, command: 'click', pageUrl: 'http://127.0.0.1:4173/echo/correct%20horse', durationMs: 1 }
    const checked: RetestEvent = {
      ...stamp,
      origin: 'child',
      type: 'assertion.passed',
      ...scope,
      matcher: 'toHaveText',
      expected: null,
      actual: null,
      attempts: 1,
      durationMs: 1,
      pageUrl: 'http://127.0.0.1:4173/echo/correct+horse',
    }
    const started: RetestEvent = { ...stamp, type: 'app.started', app: 'web', ready: 'http://127.0.0.1:3000/?token=correct%20horse', pid: 1, durationMs: 1 }
    const redacted = [moved, acted, checked, started].map((event) => redactor.redactFields(retestEventSchema, event))
    assert.deepEqual(
      redacted.map((event) => ('url' in event ? event.url : 'pageUrl' in event ? event.pageUrl : 'ready' in event ? event.ready : undefined)),
      ['http://127.0.0.1:4173/echo/{{password}}', 'http://127.0.0.1:4173/echo/{{password}}', 'http://127.0.0.1:4173/echo/{{password}}', 'http://127.0.0.1:3000/?token={{password}}'],
    )
    const run: RetestEvent = {
      ...stamp,
      type: 'run.started',
      retestVersion: '0.0.0',
      node: 'v24',
      platform: 'darwin-arm64',
      rootDir: '/work',
      files: ['tests/a.retest.ts'],
      options: { baseUrls: { web: 'http://correct%20horse@127.0.0.1:4173/' }, timeouts: { collection: 1, setup: 1, action: 1, navigation: 1, assertion: 1, test: 1, cleanup: 1 }, reporter: 'human' },
    }
    const recorded = redactor.redactFields(retestEventSchema, run)
    assert.deepEqual(recorded.type === 'run.started' ? recorded.options.baseUrls : undefined, { web: 'http://{{password}}@127.0.0.1:4173/' })
  })

  test('returns the same value while it knows no secret', () => {
    const result = runResult({})
    assert.equal(new Redactor().redactFields(runResultSchema, result), result)
    const failure = { class: 'timeout' as const, message: 'slow' }
    assert.equal(new Redactor().redactFailure(failure), failure)
  })
})

describe('RedactedStream', () => {
  test('holds back a chunk that ends partway into a value until the next chunk says', () => {
    const stream = taught({ password: 'hunter2' }).stream()
    assert.equal(stream.write('log in with hun'), 'log in with ')
    assert.equal(stream.write('ter2 now'), '{{password}} now')
    assert.equal(stream.end(), '')
  })

  test('lets a held tail go once it turns out not to be a value, and gives what is left at the end', () => {
    const stream = taught({ password: 'hunter2' }).stream()
    assert.equal(stream.write('a hun'), 'a ')
    assert.equal(stream.write('dred'), 'hundred')
    assert.equal(stream.write(' hunt'), ' ')
    assert.equal(stream.end(), 'hunt')
  })

  test('finds a value cut across many chunks, and the longer of two that share a start', () => {
    const stream = taught({ short: 'ab', long: 'abcd' }).stream()
    const written = ['a', 'b', 'c', 'd', ' a', 'b!'].map((chunk) => stream.write(chunk)).join('') + stream.end()
    assert.equal(written, '{{long}} {{short}}!')
  })

  test('passes chunks straight through when no value is known', () => {
    const stream = new Redactor().stream()
    assert.equal(stream.write('hun'), 'hun')
    assert.equal(stream.end(), '')
  })
})
