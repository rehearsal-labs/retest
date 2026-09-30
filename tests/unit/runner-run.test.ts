import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { childLogFile } from '../../src/protocol/run-folder.ts'
import { eventsOfType, runSupportFiles, supportFile, testNamed } from '../support/run-harness.ts'

describe('a passing run', async () => {
  const record = await runSupportFiles(['passing.retest.ts'], { fake: { saveDelayMs: 150 } })

  test('exits 0 with a complete result, written as returned', () => {
    assert.equal(record.result.exitCode, 0)
    assert.equal(record.result.status, 'passed')
    assert.equal(record.result.complete, true)
    assert.deepEqual(record.result.counts, { passed: 3, failed: 0, error: 0, notRun: 0, inconclusive: 0 })
    assert.deepEqual(record.written, record.result)
    assert.deepEqual(record.result.browser, { product: 'FakeChromium', version: '140.0.0.0', executablePath: '/fake/chromium' })
  })

  test('events run from run.started to run.finished in sequence', () => {
    const types = record.events.map((event) => event.type)
    assert.deepEqual(types.slice(0, 4), ['run.started', 'collection.completed', 'browser.started', 'test.started'])
    assert.equal(types.at(-1), 'run.finished')
    assert.equal(new Set(record.events.map((event) => event.runId)).size, 1)
    const run = eventsOfType(record.events, 'run.started')[0]
    assert.deepEqual(run?.files, [supportFile('passing.retest.ts')])
    assert.equal(run?.options.reporter, 'none')
  })

  test('launches one browser, gives each test a new page, and cleans every page and the browser up', () => {
    assert.equal(record.browsers.length, 1)
    const [browser] = record.browsers
    assert.equal(browser?.pages.length, 3)
    assert.ok(browser?.pages.every((page) => page.disposed))
    assert.equal(browser?.closed, true)
    assert.equal(browser?.launchOptions.logFile, join(record.folder, 'logs/browser.log'))
    assert.equal(browser?.launchOptions.headless, true)
  })

  test('the assertion looked again while the save was pending, and the click happened once', () => {
    assert.equal(record.browsers[0]?.pages[0]?.clicks, 1)
    const clicks = record.browsers[0]?.commands.filter((command) => command.kind === 'click')
    assert.equal(clicks?.length, 1)
    const [saved] = eventsOfType(record.events, 'assertion.passed')
    assert.ok((saved?.attempts ?? 0) > 1, `looked ${saved?.attempts} times`)
    assert.equal(saved?.pageUrl, 'http://127.0.0.1:4173/')
  })

  test('actions carry their locator, page and line, and a fill carries only the length of its value', () => {
    const actions = eventsOfType(record.events, 'action.completed')
    const fill = actions.find((event) => event.command === 'fill')
    assert.deepEqual(fill?.locator, { by: 'testId', value: 'task-title' })
    assert.equal(fill?.valueLength, 'Release checklist'.length)
    assert.deepEqual(fill?.location, { file: supportFile('passing.retest.ts'), line: 5, column: 40 })
    assert.equal(fill?.session, 'page')
    assert.ok(!record.lines.some((line) => line.includes('Release checklist') && line.includes('"action.')), 'no action event holds the typed value')
  })

  test("milestone 1's mode has no variants: no event or result carries one, and the browser names no app", () => {
    assert.ok(record.events.every((event) => !('variant' in event) && !('variantKey' in event)))
    assert.ok(record.result.files.flatMap((file) => file.tests).every((result) => result.variant === undefined && result.variantKey === undefined))
    assert.equal(record.result.browsers, undefined)
    const started = eventsOfType(record.events, 'browser.started')[0]
    assert.deepEqual([started?.app, started?.target], [undefined, undefined])
    assert.equal(eventsOfType(record.events, 'run.started')[0]?.options.browserPath, '/fake/chromium')
  })

  test('navigation keeps origin and path only', () => {
    const urls = eventsOfType(record.events, 'navigation').map((event) => event.url)
    assert.deepEqual(urls, ['http://127.0.0.1:4173/', 'http://127.0.0.1:4173/tasks'])
    assert.ok(!record.lines.some((line) => line.includes('draft=1') || line.includes('#top')))
  })

  test('steps nest, carry their events and pass their value back', () => {
    const steps = eventsOfType(record.events, 'step.started')
    assert.deepEqual(
      steps.map((event) => [event.name, event.parentStepId ?? null]),
      [
        ['outer', null],
        ['inner', 'step-1'],
      ],
    )
    const goto = eventsOfType(record.events, 'action.completed').find((event) => event.pageUrl?.endsWith('/tasks'))
    assert.equal(goto?.stepId, 'step-1')
    assert.deepEqual(
      eventsOfType(record.events, 'navigation').map((event) => [event.url, event.stepId ?? null]),
      [
        ['http://127.0.0.1:4173/', null],
        ['http://127.0.0.1:4173/tasks', 'step-1'],
      ],
    )
    assert.equal(testNamed(record.result, 'returns values from nested steps').assertionCount, 2)
  })

  test('a test option sets that test budget', () => {
    assert.equal(testNamed(record.result, 'reads each run of whitespace as one space').status, 'passed')
  })
})

describe('a failing run', async () => {
  const record = await runSupportFiles(['failing.retest.ts'])

  test('exits 1, and every test reached a verdict', () => {
    assert.equal(record.result.exitCode, 1)
    assert.equal(record.result.status, 'failed')
    assert.equal(record.result.complete, true)
  })

  test('each failure has its class, line and an honest message', () => {
    const cases: [string, string, number][] = [
      ['shows the wrong text', 'check_failed', 6],
      ['finds nothing', 'not_found', 10],
      ['finds two', 'ambiguous', 14],
      ['stays hidden', 'check_failed', 18],
      ['compares values', 'check_failed', 22],
      ['clicks what is not there', 'not_found', 26],
    ]
    for (const [name, kind, line] of cases) {
      const failure = testNamed(record.result, name).failure
      assert.equal(failure?.class, kind, name)
      assert.equal(failure?.location?.line, line, name)
    }
    assert.match(testNamed(record.result, 'shows the wrong text').failure?.message ?? '', /has text "Draft", expected "Release checklist"\. Compared whole text/)
  })

  test('a failed test keeps a screenshot in the run folder, named in its result', () => {
    const failed = testNamed(record.result, 'shows the wrong text')
    const [shot] = failed.evidence
    assert.ok(shot)
    assert.ok(existsSync(join(record.folder, shot.path)))
    const captured = eventsOfType(record.events, 'evidence.captured').find((event) => event.testId === failed.testId)
    assert.equal(captured?.path, shot.path)
  })

  test('assertion events carry expected, actual, attempts and the budget', () => {
    const failed = eventsOfType(record.events, 'assertion.failed').find((event) => event.matcher === 'toHaveText')
    assert.equal(failed?.expected?.text, 'Release checklist')
    assert.equal(failed?.actual?.text, 'Draft')
    assert.equal(failed?.timeoutMs, 300)
    assert.ok((failed?.attempts ?? 0) >= 3)
  })
})

describe('work the test did not finish', async () => {
  const record = await runSupportFiles([
    'unawaited.retest.ts',
    'concurrent.retest.ts',
    'no-assertions.retest.ts',
    'throws.retest.ts',
    'misuse.retest.js',
    'outside-scope.retest.ts',
  ])
  const failure = (name: string): { class: string; message: string } | undefined => testNamed(record.result, name).failure

  test('an assertion never awaited fails the test', () => {
    assert.equal(failure('never awaits an assertion')?.class, 'not_awaited')
  })

  test('a failed assertion nobody awaited, or one the test caught, still fails it', () => {
    assert.equal(failure('lets a failed assertion go unawaited')?.class, 'not_found')
    assert.equal(failure('catches a failed assertion')?.class, 'not_found')
  })

  test('an action still running, or never awaited, fails the test', () => {
    assert.match(failure('returns while an action runs')?.message ?? '', /was still running when the test returned/)
    assert.match(failure('never awaits an action')?.message ?? '', /was never awaited/)
  })

  test('a rejection nobody handled fails the test with the original error', () => {
    assert.equal(failure('leaves a rejection unhandled')?.message, 'RangeError: nobody handled this')
  })

  test('two commands at once fail with both lines named', () => {
    assert.match(failure('sends two actions at once')?.message ?? '', /^Line 4 .* was still running when line 5 .*Add await on line 4\.$/)
    assert.match(failure('checks while an action runs')?.message ?? '', /^Line 10 .* line 11 /)
    assert.equal(testNamed(record.result, 'checks two things at once').status, 'passed')
  })

  test('a test without assertions fails', () => {
    assert.equal(failure('only acts')?.class, 'no_assertions')
  })

  test('test code that throws fails with its error and line', () => {
    const thrown = testNamed(record.result, 'throws from test code').failure
    assert.equal(thrown?.message, 'TypeError: The fixture data was wrong.')
    assert.equal(thrown?.location?.line, 5)
    assert.equal(failure('declares a test inside a test')?.class, 'usage')
  })

  test('a Retest call that fails outside any test fails the test that was running', () => {
    assert.deepEqual(failure('runs while another test is declared'), {
      class: 'usage',
      message: 'test() registers tests while retest loads a test file. Run the file with retest run.',
    })
    assert.deepEqual(failure('runs while a check fails outside it'), { class: 'usage', message: 'expect() can only run inside a test.' })
  })

  test('misuse from JavaScript names the fix', () => {
    assert.equal(failure('passes a promise to expect')?.message, 'Await the promise before expect().')
    assert.equal(failure('calls toBe on a locator')?.message, 'toBe is for values. Use toHaveText or toBeVisible on a locator.')
    assert.equal(failure('calls toBeVisible on a value')?.message, 'toBeVisible is for locators. Use toBe on a value.')
    assert.equal(failure('fills a number')?.message, 'fill() takes a string, received 42.')
  })

  test('the other tests in a file keep running after a failure', () => {
    assert.equal(record.result.counts.notRun, 0)
    assert.equal(record.result.exitCode, 1)
  })
})

describe('test output', async () => {
  const record = await runSupportFiles(['output.retest.ts'])

  test('goes to the file log and to onOutput, never into events', () => {
    const log = readFileSync(join(record.folder, childLogFile(supportFile('output.retest.ts'))), 'utf8')
    assert.equal(log, 'loading the output file\n{"type":"not an event"}\na line on stderr\n')
    assert.deepEqual(
      record.output.map((chunk) => chunk.stream),
      ['stdout', 'stdout', 'stderr'],
    )
    assert.ok(record.output.every((chunk) => chunk.file === supportFile('output.retest.ts')))
    assert.ok(!record.lines.some((line) => line.includes('not an event')))
    assert.equal(record.result.exitCode, 0)
  })
})
