import type { Summary, Judgment } from '../../fixtures/evaluation-corpus/runner/score.ts'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, describe, test } from 'node:test'
import { promisify } from 'node:util'
import { readCorpus } from '../../fixtures/evaluation-corpus/runner/cases.ts'

// The corpus runner proven offline: `scripts/run-evaluation-corpus.ts` as a person runs it, against the four fake judges
// in fixtures/evaluation-corpus/judges, three repeats each. The fakes know nothing about images or text, so this proves
// the runner's path and the gate arithmetic, never how well any model judges. Each expectation is worked out from the
// case list's labels, not from what a fake answered.

const run = promisify(execFile)
const root = resolve(import.meta.dirname, '..', '..')
const config = join(root, 'fixtures', 'evaluation-corpus', 'judges', 'retest.config.ts')
const corpus = readCorpus()
const labels = new Map(corpus.cases.map((each) => [each.id, each.label]))
const scratch = mkdtempSync(join(tmpdir(), 'retest-corpus-test-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

type Ran = { exitCode: number; stdout: string; summary: Summary; judgments: Judgment[] }

async function runJudge(judge: string): Promise<Ran> {
  const out = join(scratch, judge)
  const command = [process.execPath, ['--conditions=retest-source', join(root, 'scripts', 'run-evaluation-corpus.ts'), '--config', config, '--judge', judge, '--out', out]] as const
  let exitCode = 0
  let stdout = ''
  try {
    stdout = (await run(command[0], command[1], { cwd: root, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 })).stdout
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error) || typeof error.code !== 'number') throw error
    exitCode = error.code
    stdout = 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : ''
  }
  const summary: Summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'))
  const judgments = readFileSync(join(out, 'judgments.jsonl'), 'utf8').trim().split('\n').map((line): Judgment => JSON.parse(line))
  return { exitCode, stdout, summary, judgments }
}

describe('the evaluation corpus runner, with fake judges', async () => {
  const perfect = await runJudge('perfect')
  const alwaysPass = await runJudge('always-pass')
  const flip = await runJudge('flip')
  const failing = await runJudge('error')
  const asked = (ran: Ran, caseId: string, repeat = 1): boolean => ran.judgments.some((judgment) => judgment.caseId === caseId && judgment.repeat === repeat && judgment.asked)
  // Text and screenshot cases are never capped by a frame rule, so what the judge answers is the check's verdict.
  const uncapped = corpus.cases.filter((each) => each.category !== 'frames' && asked(perfect, each.id))

  test('every case is judged once per repeat, in order', () => {
    for (const ran of [perfect, alwaysPass, flip, failing]) {
      assert.equal(ran.judgments.length, corpus.cases.length * 3)
      assert.deepEqual(ran.judgments.slice(0, corpus.cases.length).map((judgment) => judgment.caseId), corpus.cases.map((each) => each.id))
      assert.equal(ran.summary.cases, corpus.cases.length)
    }
  })

  test('the fixed offline script exercises the parent rules and matches the provisional baseline labels', () => {
    const wrong = perfect.judgments.filter((judgment) => judgment.verdict !== labels.get(judgment.caseId)?.verdict)
    assert.deepEqual(wrong.map((judgment) => `${judgment.caseId}: ${judgment.verdict}, ${judgment.reason ?? ''}`), [])
    assert.deepEqual([perfect.summary.overall.falsePasses, perfect.summary.overall.falseFailures, perfect.summary.repeatAgreement], [0, 0, 1])
    assert.equal(perfect.summary.gates.met, true)
    assert.equal(perfect.summary.gates.provisional, perfect.summary.labelsAwaitingReview > 0)
    assert.equal(perfect.exitCode, 0)
    assert.match(perfect.stdout, /gate {7}known critical failures never pass: met/)
  })

  test('a judge that passes everything is caught: every failed text and screenshot case is a false pass, and the gates are not met', () => {
    const expected = uncapped.filter((each) => each.label.verdict !== 'pass').map((each) => each.id)
    assert.ok(expected.length >= 10, `enough cases to catch it: ${expected.length}`)
    for (const id of expected) assert.ok(alwaysPass.summary.falsePassCases.includes(id), `${id} is a false pass`)
    assert.equal(alwaysPass.judgments.find((judgment) => judgment.caseId === 'frames-flash-absence')?.verdict, 'pass', 'an explicit never pass on complete capture reaches the scorer')
    assert.ok(alwaysPass.summary.falsePassCases.includes('frames-flash-absence'), 'the witnessed forbidden banner keeps this false pass critical')
    assert.equal(alwaysPass.summary.gates.criticalNeverPasses.met, false)
    assert.equal(alwaysPass.summary.gates.met, false)
    assert.equal(alwaysPass.exitCode, 1)
  })

  test('no pass counts for an unwitnessed seen claim, incomplete frames, or missing evidence', () => {
    for (const ran of [alwaysPass, flip]) {
      for (const judgment of ran.judgments.filter((each) => each.rule !== undefined)) assert.notEqual(judgment.verdict, 'pass', `${judgment.caseId}: ${judgment.rule}`)
    }
    assert.ok(alwaysPass.judgments.some((judgment) => judgment.rule === 'frames_incomplete'), 'a pass over incomplete frames was set aside')
    for (const id of ['frames-toast-wrong', 'frames-injection', 'frames-spinner-early']) {
      assert.equal(perfect.judgments.find((judgment) => judgment.caseId === id)?.verdict, 'inconclusive', id)
    }
    assert.ok(flip.judgments.some((judgment) => judgment.rule === 'seen_over_frames'), 'a seen failure was ruled inconclusive')
  })

  test('a judge that flips on the second repeat shows as repeat disagreement, and its wrong repeat fails the gate', () => {
    const flipped = uncapped.filter((each) => each.label.verdict !== 'inconclusive').map((each) => each.id)
    for (const id of flipped) assert.ok(flip.summary.disagreements.some((each) => each.caseId === id), `${id} disagrees across repeats`)
    assert.ok(flip.summary.repeatAgreement < 1)
    const firstAndThird = flip.judgments.filter((judgment) => judgment.repeat !== 2)
    for (const judgment of firstAndThird) assert.equal(judgment.verdict, labels.get(judgment.caseId)?.verdict, `${judgment.caseId} in repeat ${judgment.repeat}`)
    assert.equal(flip.summary.gates.met, false)
  })

  test('a judge that fails every call is an error on every case it was asked, never a pass, and the 90% gate is not met', () => {
    for (const judgment of failing.judgments) {
      if (judgment.asked) assert.equal(judgment.verdict, 'error', judgment.caseId)
      else assert.equal(judgment.verdict, perfect.judgments.find((each) => each.caseId === judgment.caseId && each.repeat === judgment.repeat)?.verdict, `${judgment.caseId}: decided without the judge, as before`)
    }
    assert.equal(failing.summary.overall.errors, failing.judgments.filter((judgment) => judgment.asked).length)
    assert.deepEqual([failing.summary.gates.criticalNeverPasses.met, failing.summary.gates.unambiguousCorrect.met, failing.exitCode], [true, false, 1])
  })

  test('latency and usage are counted for every call a judge answered', () => {
    const calls = perfect.judgments.filter((judgment) => judgment.asked)
    assert.equal(perfect.summary.latency.calls, calls.length)
    assert.equal(perfect.summary.usage.totalTokens, calls.length * 110)
    assert.deepEqual(perfect.summary.models, ['corpus-perfect'])
  })
})
