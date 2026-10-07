import type { CorpusCase } from '../../fixtures/evaluation-corpus/runner/cases.ts'
import type { Judgment } from '../../fixtures/evaluation-corpus/runner/score.ts'
import type { EvaluationVerdict } from '../../src/protocol/evaluation.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { applyGates, describeSummary, summarize } from '../../fixtures/evaluation-corpus/runner/score.ts'

// The corpus scorer's arithmetic on cases and judgments made up here, apart from any judge: what counts as correct, a
// false pass or a false failure, how repeats agree, and where each gate falls.

function corpusCase(id: string, verdict: 'pass' | 'fail' | 'inconclusive', options: { category?: CorpusCase['category']; critical?: boolean; unambiguous?: boolean; review?: 'awaiting-founder' | 'reviewed' } = {}): CorpusCase {
  return {
    id,
    category: options.category ?? 'text',
    kinds: [verdict === 'pass' ? 'clear-pass' : verdict === 'fail' ? 'clear-failure' : 'incomplete-evidence'],
    source: 'made up for the scorer test',
    requirement: { shown: { kind: 'state', requirement: 'The banner says saved.' } },
    evidence: [{ kind: 'text', file: 'none.txt' }],
    label: { verdict, unambiguous: options.unambiguous ?? true, critical: options.critical ?? verdict === 'fail', review: options.review ?? 'reviewed', why: 'Made up.' },
  }
}

function judged(caseId: string, verdicts: readonly EvaluationVerdict[], extra: Partial<Judgment> = {}): Judgment[] {
  return verdicts.map((verdict, index) => ({ caseId, repeat: index + 1, verdict, asked: true, latencyMs: 100 * (index + 1), ...extra }))
}

describe('the corpus scorer', () => {
  test('counts correct verdicts, false passes, false failures, undecided and errors, overall and by category', () => {
    const cases = [corpusCase('a', 'pass'), corpusCase('b', 'fail', { category: 'screenshot' }), corpusCase('c', 'inconclusive', { category: 'frames' })]
    const judgments = [...judged('a', ['pass', 'fail', 'error']), ...judged('b', ['pass', 'fail', 'inconclusive']), ...judged('c', ['pass', 'inconclusive', 'fail'])]
    const summary = summarize(cases, judgments, 3)
    assert.deepEqual(summary.overall, { judgments: 9, correct: 3, falsePasses: 2, falseFailures: 2, inconclusive: 2, errors: 1, inconclusiveRate: 2 / 9, errorRate: 1 / 9 })
    assert.deepEqual(summary.byCategory.text, { judgments: 3, correct: 1, falsePasses: 0, falseFailures: 1, inconclusive: 0, errors: 1 })
    assert.deepEqual(summary.byCategory.screenshot, { judgments: 3, correct: 1, falsePasses: 1, falseFailures: 0, inconclusive: 1, errors: 0 })
    assert.deepEqual(summary.byCategory.frames, { judgments: 3, correct: 1, falsePasses: 1, falseFailures: 1, inconclusive: 1, errors: 0 })
    assert.deepEqual(summary.falsePassCases, ['b', 'c'])
    assert.deepEqual(summary.falseFailureCases, ['a', 'c'])
  })

  test('counts each declared kind without shrinking the case or repeat matrix', () => {
    const state = corpusCase('state', 'fail')
    const seen = { ...corpusCase('seen', 'inconclusive', { category: 'frames' }), requirement: { shown: { kind: 'seen' as const, requirement: 'The same words.' } } }
    const never = { ...corpusCase('never', 'fail', { category: 'frames' }), requirement: { calm: { kind: 'never' as const, requirement: 'The same words.' } } }
    const summary = summarize([state, seen, never], [...judged('state', ['fail']), ...judged('seen', ['inconclusive']), ...judged('never', ['fail'])], 1)
    assert.equal(summary.overall.judgments, 3)
    assert.deepEqual(Object.values(summary.byCriterionKind).map((counts) => [counts.judgments, counts.correct]), [[1, 1], [1, 1], [1, 1]])
    assert.deepEqual([summary.gates.unambiguousCorrect.total, summary.gates.unambiguousCorrect.correct, summary.overall.falsePasses], [2, 2, 0])
    assert.throws(() => summarize([state, seen, never], judged('state', ['fail']), 1), /missing judgment/)
  })

  test('a cancelled or not-run judgment counts as an error, never as correct', () => {
    const summary = summarize([corpusCase('a', 'pass')], judged('a', ['cancelled', 'not_run']), 2)
    assert.deepEqual([summary.overall.errors, summary.overall.correct], [2, 0])
  })

  test('repeat agreement is the share of cases whose repeats all ended the same', () => {
    const cases = [corpusCase('a', 'pass'), corpusCase('b', 'fail'), corpusCase('c', 'pass'), corpusCase('d', 'fail')]
    const judgments = [...judged('a', ['pass', 'pass', 'pass']), ...judged('b', ['fail', 'pass', 'fail']), ...judged('c', ['inconclusive', 'inconclusive', 'inconclusive']), ...judged('d', ['error', 'fail', 'fail'])]
    const summary = summarize(cases, judgments, 3)
    assert.equal(summary.repeatAgreement, 0.5)
    assert.deepEqual(summary.disagreements, [{ caseId: 'b', verdicts: ['fail', 'pass', 'fail'] }, { caseId: 'd', verdicts: ['error', 'fail', 'fail'] }])
  })

  test('latency counts only calls the judge answered or was asked, by nearest rank; usage adds what was counted', () => {
    const cases = [corpusCase('a', 'pass'), corpusCase('b', 'inconclusive')]
    const judgments = [
      ...judged('a', ['pass', 'pass', 'pass'], { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, model: 'm-1' }),
      ...judged('b', ['inconclusive', 'inconclusive', 'inconclusive'], { asked: false, latencyMs: 9000, rule: 'absence_over_frames' }),
    ]
    const summary = summarize(cases, judgments, 3)
    assert.deepEqual(summary.latency, { calls: 3, medianMs: 200, p95Ms: 300, maxMs: 300 })
    assert.deepEqual(summary.usage, { judgmentsWithUsage: 3, inputTokens: 30, outputTokens: 6, totalTokens: 36 })
    assert.deepEqual(summary.models, ['m-1'])
  })

  test('a known critical failure that passes once fails the gate, in any repeat', () => {
    const cases = [corpusCase('a', 'fail', { critical: true }), corpusCase('b', 'inconclusive', { critical: true })]
    const once = applyGates(cases, [...judged('a', ['fail', 'fail', 'pass']), ...judged('b', ['inconclusive', 'inconclusive', 'inconclusive'])], 0, 3)
    assert.deepEqual([once.criticalNeverPasses.met, once.criticalNeverPasses.passedCases, once.met], [false, ['a'], false])
    const undecided = applyGates(cases, [...judged('a', ['fail', 'fail', 'fail']), ...judged('b', ['inconclusive', 'pass', 'inconclusive'])], 0, 3)
    assert.deepEqual(undecided.criticalNeverPasses.passedCases, ['b'], 'evidence that cannot show the requirement is critical too')
  })

  test('the 90% gate counts unambiguous pass and fail labels only; an undecided or error judgment there is wrong', () => {
    const cases = [...Array.from({ length: 9 }, (_, index) => corpusCase(`p${index}`, 'pass')), corpusCase('f', 'fail'), corpusCase('i', 'inconclusive'), corpusCase('x', 'pass', { unambiguous: false })]
    const right = [...cases.slice(0, 9).flatMap((each) => judged(each.id, ['pass'])), ...judged('f', ['fail']), ...judged('i', ['fail']), ...judged('x', ['fail'])]
    const exactly = applyGates(cases, right, 0, 1)
    assert.deepEqual([exactly.unambiguousCorrect.correct, exactly.unambiguousCorrect.total, exactly.unambiguousCorrect.met], [10, 10, true], 'the undecided label and the ambiguous case are not counted')
    const oneUndecided = applyGates(cases, right.map((judgment) => (judgment.caseId === 'p0' ? { ...judgment, verdict: 'inconclusive' as const } : judgment)), 0, 1)
    assert.deepEqual([oneUndecided.unambiguousCorrect.rate, oneUndecided.unambiguousCorrect.met], [0.9, true], '9 of 10 is exactly the threshold')
    const twoWrong = applyGates(cases, right.map((judgment) => (judgment.caseId === 'p0' ? { ...judgment, verdict: 'inconclusive' as const } : judgment.caseId === 'p1' ? { ...judgment, verdict: 'error' as const } : judgment)), 0, 1)
    assert.deepEqual([twoWrong.unambiguousCorrect.rate, twoWrong.unambiguousCorrect.met, twoWrong.met], [0.8, false, false])
  })

  test('no scored judgment never meets the 90% gate', () => {
    const gates = applyGates([corpusCase('i', 'inconclusive')], judged('i', ['inconclusive']), 0, 1)
    assert.deepEqual([gates.unambiguousCorrect.total, gates.unambiguousCorrect.met, gates.met], [0, false, false])
  })

  test('gates met while labels await review are provisional, and the summary says so', () => {
    const cases = [corpusCase('a', 'pass', { review: 'awaiting-founder' }), corpusCase('b', 'fail')]
    const summary = summarize(cases, [...judged('a', ['pass']), ...judged('b', ['fail'])], 1)
    assert.deepEqual([summary.gates.met, summary.gates.provisional, summary.labelsAwaitingReview], [true, true, 1])
    assert.match(describeSummary(summary, 'perfect').join('\n'), /gates met, provisional: 1 labels await the founder's review/)
  })

  test('a judgment for a case the corpus does not have is refused', () => {
    assert.throws(() => summarize([corpusCase('a', 'pass')], judged('z', ['pass']), 1), /names the case z, which the corpus does not have/)
  })

  test('missing cases or repeats cannot disappear from the gate denominator', () => {
    const cases = [corpusCase('a', 'pass'), corpusCase('b', 'fail')]
    assert.throws(() => summarize(cases, judged('a', ['pass', 'pass', 'pass']), 3), /missing judgment.*b.*repeat 1/)
    assert.throws(() => summarize(cases, [...judged('a', ['pass', 'pass']), ...judged('b', ['fail', 'fail', 'fail'])], 3), /missing judgment.*a.*repeat 3/)
    assert.throws(() => applyGates(cases, judged('a', ['pass']), 0, 1), /missing judgment.*b/)
  })

  test('duplicate cases and duplicate or invalid repeat results are refused', () => {
    const cases = [corpusCase('a', 'pass')]
    assert.throws(() => summarize([...cases, ...cases], judged('a', ['pass']), 1), /case a twice/)
    assert.throws(() => summarize(cases, [...judged('a', ['pass']), ...judged('a', ['pass'])], 1), /judgment.*a.*repeat 1 twice/)
    for (const repeat of [0, 1.5, 2]) assert.throws(() => summarize(cases, [{ ...judged('a', ['pass'])[0]!, repeat }], 1), /repeat/)
  })

  test('the gate helper refuses an entirely missing last repeat', () => {
    assert.throws(() => applyGates([corpusCase('a', 'pass')], judged('a', ['pass', 'pass']), 0, 3), /missing judgment.*a.*repeat 3/)
  })
})
