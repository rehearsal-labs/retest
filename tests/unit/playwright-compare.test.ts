import type { CompatibilityCase } from '../../fixtures/playwright-compat/cases.ts'
import type { RecordedStep, RecordedTest } from '../../fixtures/playwright-compat/operations-reporter.ts'
import type { Comparison, Observed } from '../../scripts/compare-playwright.ts'
import type { EventStamp, RetestEvent } from '../../src/protocol/events.ts'
import type { TestResult } from '../../src/protocol/result.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { compatibilityCases, unavailableCases } from '../../fixtures/playwright-compat/cases.ts'
import {
  comparisonHolds,
  integrityOf,
  intendedLine,
  judgeCase,
  packFile,
  pinnedPlaywright,
  playwrightFailureClass,
  playwrightObserved,
  playwrightValues,
  readPlaywrightReport,
  renderTable,
  retainedBetween,
  retestFailureClass,
  retestObserved,
  retestValues,
  runProblems,
} from '../../scripts/compare-playwright.ts'

const specFile = '/work/tests/tasks.spec.ts'
const source = `import { test, expect } from '@playwright/test'

test('saves', async ({ page }) => {
  await page.goto('/')
  await test.step('the saved title shows', async () => {
    await page.getByTestId('save').click()
    await expect(page.getByTestId('title')).toHaveText('Saved')
  })
})
`

const passing: CompatibilityCase = { id: 'T.1', file: 'tests/tasks.spec.ts', name: 'saves', outcome: { status: 'passed' }, support: { supported: true } }
const failing: CompatibilityCase = {
  ...passing,
  outcome: { status: 'failed', step: 'the saved title shows', operation: "toHaveText('Saved')", failure: 'assertion' },
}

function step(category: string, title: string, line: number | undefined, steps: RecordedStep[] = [], error?: string): RecordedStep {
  return { category, title, ...(line === undefined ? {} : { location: { file: specFile, line, column: 3 } }), ...(error === undefined ? {} : { error }), steps }
}

const assertionFailed = 'Error: expect(locator).toHaveText(expected) failed\n\nLocator:  getByTestId(\'title\')\nExpected: "Saved"\nReceived: "Save"\nTimeout:  1500ms\n\nCall log:\n  - Expect "toHaveText" with timeout 1500ms'

function recorded(status: string, failed: boolean): RecordedTest {
  return {
    file: specFile,
    title: 'saves',
    titlePath: ['', 'tests/tasks.spec.ts', 'saves'],
    status,
    errors: failed ? [{ message: `\u001b[31m${assertionFailed}\u001b[39m`, location: { file: specFile, line: 7, column: 45 } }] : [],
    steps: [
      step('hook', 'Before Hooks', undefined, [step('fixture', 'page', undefined, [step('pw:api', 'Create page', 3)])]),
      step('pw:api', 'Navigate to "/"', 4),
      step('test.step', 'the saved title shows', 5, [step('pw:api', 'Click', 6), step('expect', 'Expect "toHaveText"', 7, [], failed ? assertionFailed : undefined)], failed ? assertionFailed : undefined),
      step('hook', 'After Hooks', undefined, []),
    ],
  }
}

const stamp: EventStamp = { schemaVersion: 1, runId: 'run', sequence: 0, time: '2026-10-05T00:00:00.000Z', elapsedMs: 0, origin: 'parent' }
const scope = { testId: 'tests/tasks.spec.ts > saves', attemptId: 'attempt-1' }
const at = (line: number) => ({ file: 'tests/tasks.spec.ts', line, column: 3 })

function retestEvents(failed: boolean): RetestEvent[] {
  const assertion: RetestEvent = failed
    ? { ...stamp, ...scope, type: 'assertion.failed', matcher: 'toHaveText', expected: null, actual: null, attempts: 3, durationMs: 1500, location: at(7), failure: { class: 'check_failed', message: 'no' } }
    : { ...stamp, ...scope, type: 'assertion.passed', matcher: 'toHaveText', expected: null, actual: null, attempts: 1, durationMs: 4, location: at(7), judgedBy: 'parent' }
  return [
    { ...stamp, ...scope, type: 'action.completed', command: 'goto', durationMs: 20, location: at(4) },
    { ...stamp, ...scope, type: 'step.started', stepId: 'step-1', name: 'the saved title shows', location: at(5) },
    { ...stamp, ...scope, type: 'action.completed', command: 'click', durationMs: 20, location: at(6), stepId: 'step-1' },
    assertion,
    { ...stamp, ...scope, type: 'step.finished', stepId: 'step-1', status: failed ? 'failed' : 'passed', durationMs: 1600 },
    { ...stamp, testId: 'another test', attemptId: 'attempt-1', type: 'action.completed', command: 'click', durationMs: 20, location: at(9) },
  ]
}

function retestResult(failed: boolean): TestResult {
  return {
    ...scope,
    name: 'saves',
    file: 'tests/tasks.spec.ts',
    location: at(3),
    status: failed ? 'failed' : 'passed',
    durationMs: 1700,
    assertionCount: 1,
    evidence: [],
    ...(failed
      ? {
          failure: {
            class: 'check_failed',
            message: "getByTestId('title') has text \"Save\", expected \"Saved\".",
            location: at(7),
            details: { expected: { text: 'Saved', truncated: false, length: 5 }, received: { text: 'Save', truncated: false, length: 4 }, attempts: 7, timeoutMs: 1500 },
          },
        }
      : {}),
  }
}

describe('reading how each runner ended a case', () => {
  test("Playwright's steps give its actions, checks and steps in the spec, without fixtures, and its failure as an assertion in its step", () => {
    const observed = playwrightObserved(recorded('failed', true))
    assert.deepEqual(observed.operations, [
      { kind: 'action', line: 4, title: 'Navigate to "/"' },
      { kind: 'step', line: 5, title: 'the saved title shows' },
      { kind: 'action', line: 6, title: 'Click' },
      { kind: 'assertion', line: 7, title: 'Expect "toHaveText"' },
    ])
    assert.deepEqual([observed.status, observed.failure, observed.step], [
      'failed',
      { class: 'assertion', line: 7, message: 'Error: expect(locator).toHaveText(expected) failed', values: { expected: ['Saved'], received: ['Save'] } },
      'the saved title shows',
    ])
    assert.equal(playwrightObserved(recorded('timedOut', false)).status, 'timed_out')
  })

  test("Retest's events give the same operations for the test's own attempt, and its failure as an assertion in its step", () => {
    const observed = retestObserved(retestResult(true), retestEvents(true))
    assert.deepEqual(observed.operations.map(({ kind, line }) => [kind, line]), [['action', 4], ['step', 5], ['action', 6], ['assertion', 7]])
    assert.deepEqual([observed.status, observed.failure?.class, observed.failure?.line, observed.step], ['failed', 'assertion', 7, 'the saved title shows'])
    assert.deepEqual(observed.failure?.values, { expected: ['Saved'], received: ['Save'] })
  })

  test("a failed check's values are read from each runner's own record, a list from Playwright's diff and Retest's list, a cut value not at all", () => {
    const listed = [
      'Error: expect(locator).toHaveText(expected) failed',
      '',
      "Locator: getByTestId('item-title')",
      'Timeout: 1500ms',
      '- Expected  - 1',
      '+ Received  + 1',
      '',
      '  Array [',
      '    "Write release notes",',
      '-   "Order name badges",',
      '+   "Order badges",',
      '  ]',
      '',
      'Call log:',
      '  - Expect "toHaveText"',
    ].join('\n')
    assert.deepEqual(playwrightValues(listed), { expected: ['Write release notes', 'Order name badges'], received: ['Write release notes', 'Order badges'] })
    assert.deepEqual(playwrightValues('Error: expect(locator).toBeHidden() failed\n\nExpected: hidden\nReceived: visible'), { expected: ['hidden'], received: ['visible'] })
    assert.deepEqual(playwrightValues('Error: expect(locator).toHaveCount(expected) failed\n\nExpected: 3\nReceived: 0'), { expected: ['3'], received: ['0'] })
    assert.deepEqual(playwrightValues('Error: expect(locator).toHaveText(expected) failed\n\nExpected: "  Saved   now "\nReceived: ""'), { expected: ['Saved now'], received: [''] })
    assert.equal(playwrightValues('TypeError: x is not a function'), undefined)
    const text = (value: string, truncated = false) => ({ text: value, truncated, length: value.length })
    assert.deepEqual(retestValues({ expected: text('["Write release notes","Order name badges"]'), received: text('["Write release notes","Order badges"]') }), {
      expected: ['Write release notes', 'Order name badges'],
      received: ['Write release notes', 'Order badges'],
    })
    assert.deepEqual(retestValues({ expected: text('3'), received: text('0') }), { expected: ['3'], received: ['0'] })
    assert.equal(retestValues({ expected: text('Saved', true), received: text('Save') }), undefined)
    assert.equal(retestValues(undefined), undefined)
  })

  test('failure classes: an expect is an assertion, several matches are ambiguous, and Retest keeps its own names but check_failed', () => {
    assert.equal(playwrightFailureClass('Error: expect(locator).not.toBeVisible() failed'), 'assertion')
    assert.equal(playwrightFailureClass('Error: expect(page).toHaveURL(expected) failed'), 'assertion')
    assert.equal(playwrightFailureClass('Error: expect(received).toBe(expected) // Object.is equality'), 'assertion')
    assert.equal(playwrightFailureClass("Error: locator.click: Error: strict mode violation: getByRole('button') resolved to 2 elements"), 'ambiguous')
    assert.equal(playwrightFailureClass('Test timeout of 30000ms exceeded.'), 'timeout')
    assert.equal(playwrightFailureClass('TypeError: x is not a function'), 'error')
    assert.equal(retestFailureClass('check_failed'), 'assertion')
    assert.equal(retestFailureClass('unsupported'), 'unsupported')
  })

  test('a report that is not what the reporter writes is refused', () => {
    assert.deepEqual(readPlaywrightReport(JSON.stringify([recorded('passed', false)])), [recorded('passed', false)])
    assert.throws(() => readPlaywrightReport('{}'), /not a list/)
    assert.throws(() => readPlaywrightReport('[{"title":"saves"}]'), /missing a field/)
  })
})

describe('judging a case', () => {
  test('the line of an intended failure is its check after the line that opens its step', () => {
    assert.equal(intendedLine(source, failing.outcome), 7)
    assert.equal(intendedLine(source, passing.outcome), undefined)
    assert.equal(intendedLine(source, { status: 'failed', step: 'no such step', operation: 'x', failure: 'assertion' }), undefined)
  })

  test('two passes through the same file and operations are equivalent', () => {
    const verdict = judgeCase({ testCase: passing, source, playwright: playwrightObserved(recorded('passed', false)), retest: retestObserved(retestResult(false), retestEvents(false)), sameFile: true })
    assert.deepEqual([verdict.equivalent, verdict.problems], [true, []])
  })

  test('an intended failure counts only at its step, its line and as an assertion, from both runners', () => {
    const playwright = playwrightObserved(recorded('failed', true))
    const retest = retestObserved(retestResult(true), retestEvents(true))
    assert.equal(judgeCase({ testCase: failing, source, playwright, retest, sameFile: true }).equivalent, true)
    const elsewhere: Observed = { ...retest, failure: { class: 'assertion', line: 6, message: 'no', values: { expected: ['Saved'], received: ['Save'] } } }
    const atLine6 = judgeCase({ testCase: failing, source, playwright, retest: elsewhere, sameFile: true })
    assert.deepEqual([atLine6.equivalent, atLine6.playwrightAsDeclared, atLine6.retestAsDeclared], [false, true, false])
    assert.match(atLine6.problems.join(' '), /Retest ended it failed: assertion at line 6 in "the saved title shows", where the case fails as an assertion at line 7/)
  })

  test('an intended failure at the intended check is equivalent only when both checks expected and received the same values', () => {
    const playwright = playwrightObserved(recorded('failed', true))
    const retest = retestObserved(retestResult(true), retestEvents(true))
    const verdict = judgeCase({ testCase: failing, source, playwright, retest, sameFile: true })
    assert.deepEqual([verdict.equivalent, verdict.sameValues], [true, true])
    // Retest read a stale text and failed at the same line, in the same step, as an assertion: not the same failure.
    const stale: Observed = { ...retest, failure: { class: 'assertion', line: 7, message: 'other', values: { expected: ['Saved'], received: ['Sav'] } } }
    const otherValues = judgeCase({ testCase: failing, source, playwright, retest: stale, sameFile: true })
    assert.deepEqual([otherValues.equivalent, otherValues.retestAsDeclared, otherValues.sameValues], [false, true, false])
    assert.match(otherValues.problems.join(' '), /The two checks failed on different values: Playwright expected \["Saved"\] and received \["Save"\], Retest expected \["Saved"\] and received \["Sav"\]\./)
    const unread: Observed = { ...retest, failure: { class: 'assertion', line: 7, message: 'other' } }
    assert.match(judgeCase({ testCase: failing, source, playwright, retest: unread, sameFile: true }).problems.join(' '), /Retest's failure names no expected and received values/)
  })

  test('an unsupported refusal is never an equivalent failure, even at the intended line', () => {
    const retest: Observed = { ...retestObserved(retestResult(true), retestEvents(true)), status: 'error', failure: { class: 'unsupported', line: 7, message: 'expect().toHaveText(…, { ignoreCase }) is not supported yet' } }
    const verdict = judgeCase({ testCase: failing, source, playwright: playwrightObserved(recorded('failed', true)), retest, sameFile: true })
    assert.equal(verdict.equivalent, false)
    assert.match(verdict.problems.join(' '), /Retest refused it as unsupported at line 7/)
  })

  test('a run that skipped a check, or read other bytes, did not retain the case', () => {
    const playwright = playwrightObserved(recorded('passed', false))
    const retest = retestObserved(retestResult(false), retestEvents(false))
    const skipped: Observed = { ...retest, operations: retest.operations.slice(0, 3) }
    assert.deepEqual(retainedBetween(true, playwright, skipped), { same: false, difference: 'Operation 4: Playwright ran a check at line 7, Retest ran nothing more.' })
    assert.deepEqual(retainedBetween(false, playwright, retest), { same: false, difference: 'The two runners read different bytes for the spec.' })
    const verdict = judgeCase({ testCase: passing, source, playwright, retest: skipped, sameFile: true })
    assert.deepEqual([verdict.equivalent, verdict.playwrightAsDeclared, verdict.retestAsDeclared], [false, true, true])
  })

  test('a case Playwright did not end as declared is the corpus at fault, and is never equivalent', () => {
    const playwright: Observed = { status: 'failed', failure: { class: 'ambiguous', line: 6, message: 'strict mode violation' }, operations: [] }
    const verdict = judgeCase({ testCase: passing, source, playwright, retest: retestObserved(retestResult(false), retestEvents(false)), sameFile: true })
    assert.deepEqual([verdict.equivalent, verdict.playwrightAsDeclared], [false, false])
  })
})

describe('the comparison as a whole', () => {
  const verdictFor = (testCase: CompatibilityCase, equivalent: boolean) =>
    judgeCase({
      testCase,
      source,
      playwright: playwrightObserved(recorded('passed', false)),
      retest: equivalent ? retestObserved(retestResult(false), retestEvents(false)) : { status: 'error', failure: { class: 'unsupported', line: 4, message: 'refused' }, operations: [] },
      sameFile: true,
    })
  type RetestRun = Comparison['retest']['run']
  const cleanFailure: Partial<RetestRun> = { exitCode: 2, runFailure: 'cleanup_failed: Closing the run’s browsers failed.' }
  const comparison = (verdicts: Comparison['verdicts'], retestRun: Partial<RetestRun> = {}): Comparison => ({
    playwright: { version: '1.63.0', packages: [], run: { command: [], exitCode: 1, signal: null, collected: verdicts.length, retried: 0, skipped: 0, logFolder: '/logs/playwright' } },
    retest: {
      version: '0.0.0',
      commit: 'abc1234',
      changed: false,
      run: { command: [], exitCode: 1, signal: null, collected: verdicts.length, retried: 0, skipped: 0, logFolder: '/logs/retest', ...retestRun },
    },
    browser: { product: 'Chrome', version: '154', executablePath: '/chrome' },
    node: 'v24.12.0',
    files: [],
    verdicts,
    workFolder: '/work',
  })
  const gap: CompatibilityCase = { ...passing, id: 'T.2', support: { supported: false, gap: 'Retest refuses it.' } }

  test('holds when every claimed case is equivalent and every declared gap is still one, and not otherwise', () => {
    assert.equal(comparisonHolds(comparison([verdictFor(passing, true), verdictFor(gap, false)])), true)
    assert.equal(comparisonHolds(comparison([verdictFor(passing, false)])), false, 'a claimed case that differs')
    assert.equal(comparisonHolds(comparison([verdictFor(gap, true)])), false, 'a declared gap that has closed')
  })

  test("does not hold when Retest's run failed outside any test, or the runs exit otherwise, however the cases went", () => {
    const verdicts = [verdictFor(passing, true), verdictFor(gap, false)]
    assert.deepEqual(runProblems(comparison(verdicts)), [])
    const failedRun = comparison(verdicts, cleanFailure)
    assert.equal(comparisonHolds(failedRun), false)
    assert.deepEqual(runProblems(failedRun), ["Retest's run itself failed, outside any test: cleanup_failed: Closing the run’s browsers failed.", 'Retest exited with 2, and Playwright with 1.'])
    assert.equal(comparisonHolds(comparison(verdicts, { exitCode: 0 })), false, 'another exit code alone')
    assert.equal(comparisonHolds(comparison(verdicts, { runFailure: 'cleanup_failed: left a browser.' })), false, 'a run failure alone, with the same exit code')
    assert.equal(comparisonHolds(comparison(verdicts, { exitCode: null, signal: 'SIGKILL' })), false, 'a run ended by a signal')
  })

  test('the table lists every case, the cases not in the corpus, and the reason a case differs', () => {
    const table = renderTable(comparison([verdictFor(passing, true), verdictFor(gap, false)], cleanFailure))
    assert.match(table, /^# Playwright compatibility\n/)
    assert.match(table, /\| T\.1 \| saves \| passes \| passed \| passed \| yes \|  \| yes \|/)
    assert.match(table, /\| T\.2 \| saves \| passes \| passed \| error: unsupported at line 4 \| no \|  \| no, declared gap \|/)
    assert.match(table, /- T\.2, saves\. Declared gap: Retest refuses it\. Retest refused it as unsupported at line 4: refused/)
    for (const unavailable of unavailableCases) assert.ok(table.includes(`| ${unavailable.id} |`), unavailable.id)
    assert.match(table, /- Exit codes: Playwright 1, Retest 2\./)
    assert.match(table, /- The runs as wholes do not agree, so the comparison fails: Retest's run itself failed, outside any test: cleanup_failed: Closing the run’s browsers failed\. Retest exited with 2, and Playwright with 1\./)
    assert.match(table, /- Declared gaps: \d+ of \d+ cases: 1 in the corpus, of which still gaps 1, and the \d+ cases not in the corpus\./)
  })
})

describe('the pinned Playwright', () => {
  test("each pinned package's tarball is named as npm pack names it and checked against the registry's form of its checksum", () => {
    assert.deepEqual(pinnedPlaywright.packages.map((entry) => packFile(entry.name)), ['playwright-test-1.63.0.tgz', 'playwright-1.63.0.tgz', 'playwright-core-1.63.0.tgz'])
    assert.equal(integrityOf(Buffer.from('')), 'sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==')
  })
})

describe('the corpus', () => {
  test('every case names a test its spec holds, and every intended failure names a check inside its step', () => {
    for (const testCase of compatibilityCases) {
      const text = readFileSync(new URL(`../../fixtures/playwright-compat/${testCase.file}`, import.meta.url), 'utf8')
      assert.ok(text.includes(`test('${testCase.name}'`), `${testCase.id} is in ${testCase.file}`)
      if (testCase.outcome.status === 'failed') assert.ok(intendedLine(text, testCase.outcome) !== undefined, `${testCase.id} names a check in its step`)
    }
    const variants = compatibilityCases.filter((testCase) => testCase.variantOf !== undefined)
    assert.equal(compatibilityCases.length + unavailableCases.length - variants.length, 43, 'the starter and the 41 workflow cases')
    assert.deepEqual(variants.map((testCase) => testCase.variantOf), ['F4.1', 'F5.1', 'F7.1', 'F7.3', 'F9.3'], 'each select a workflow case names by label, written again with the bare text')
    for (const variant of variants) {
      assert.ok(compatibilityCases.some((testCase) => testCase.id === variant.variantOf), `${variant.id} writes again a case of the corpus`)
      assert.equal(variant.support.supported, false, `${variant.id} is a declared gap`)
      const text = readFileSync(new URL(`../../fixtures/playwright-compat/${variant.file}`, import.meta.url), 'utf8')
      const body = text.slice(text.indexOf(`test('${variant.name}'`))
      assert.match(body.slice(0, body.indexOf('\n})')), /selectOption\('[^']+'\)/, `${variant.id} names an option by its text alone`)
    }
    assert.equal(new Set(compatibilityCases.map((testCase) => testCase.id)).size, compatibilityCases.length)
  })
})
