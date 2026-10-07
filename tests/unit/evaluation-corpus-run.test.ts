import type { LoadedEvaluation } from '../../src/config/read-evaluation.ts'
import type { EvaluationRequest, EvaluatorSetup } from '../../src/evaluation/contract.ts'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import fakeCorpusJudge from '../../fixtures/evaluation-corpus/judges/fake-judges.ts'
import { readCorpus } from '../../fixtures/evaluation-corpus/runner/cases.ts'
import { runCorpus } from '../../fixtures/evaluation-corpus/runner/run.ts'
import { defaultEvaluationLimits } from '../../src/evaluation/budget.ts'
import { Judges } from '../../src/evaluation/judges.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { tempFolder } from '../support/temp-folder.ts'

const corpus = readCorpus()

test('the perfect fake has a fixed script independent of the labels being scored', async () => {
  const changed = structuredClone(corpus)
  const first = changed.cases[0]
  assert.ok(first !== undefined)
  first.label.verdict = 'fail'
  const file = join(tempFolder('corpus-script-'), 'cases.json')
  writeFileSync(file, JSON.stringify(changed))
  const judge = fakeCorpusJudge({ judge: 'perfect', options: { behaviour: 'perfect', cases: file }, credentials: {}, accepts: ['text'], signal: new AbortController().signal })
  const answer = await judge.evaluate({ requestId: `corpus-r1:${first.id}`, judge: 'perfect', criteria: [{ id: 'saved', requirement: 'Saved.' }], evidence: [{ id: 'e1', kind: 'text', text: 'Saved.' }], instructions: 'test', promptVersion: 'test', maxOutputTokens: 10, timeoutMs: 100, signal: new AbortController().signal })
  assert.equal(answer.criteria[0]?.verdict, 'pass', 'editing a label must not edit the fake answer as well')
})

test('a corpus stopped before dispatch makes no call, including after setup has started', async (t) => {
  for (const duringSetup of [false, true]) {
    const calls: EvaluationRequest[] = []
    const stop = new AbortController()
    const arrived = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const factory = async (_setup: EvaluatorSetup): Promise<unknown> => {
      arrived.resolve()
      if (duringSetup) await release.promise
      return { identity: { provider: 'fake', model: 'stopped', version: '1' }, evaluate: async (request: EvaluationRequest) => { calls.push(request); return { criteria: request.criteria.map(({ id }) => ({ id, verdict: 'pass', citations: ['e1'] })), justification: 'Passed.' } } }
    }
    const evaluation: LoadedEvaluation = { judges: new Map([['judge', { name: 'judge', adapter: { kind: 'factory', factory }, credentials: new Map(), options: {}, accepts: ['text'] }]]), defaultJudge: 'judge', limits: defaultEvaluationLimits, timeoutMs: 1000 }
    const redactor = new Redactor()
    const judges = new Judges({ evaluation, redactor, env: {} })
    t.after(() => judges.close(1000))
    if (!duringSetup) stop.abort()
    const running = runCorpus({ corpus: { ...corpus, cases: corpus.cases.filter((each) => each.id === 'text-saved') }, judges, judge: 'judge', repeats: 1, limits: defaultEvaluationLimits, timeoutMs: 1000, redactor, folder: tempFolder('corpus-stop-'), signal: stop.signal })
    if (duringSetup) { await arrived.promise; stop.abort(); release.resolve() }
    const judgments = await running
    assert.equal(calls.length, 0)
    assert.deepEqual(judgments.map((each) => [each.verdict, each.asked]), [['cancelled', false]])
  }
})

test('a corpus resolves function credentials before freezing diagnostics or text', async (t) => {
  const credential = 'Release checklist'
  const calls: EvaluationRequest[] = []
  const redactor = new Redactor()
  const factory = (_setup: EvaluatorSetup): unknown => ({ identity: { provider: 'fake', model: 'redacted', version: '1' }, evaluate: async (request: EvaluationRequest) => { calls.push(request); return { criteria: request.criteria.map(({ id }) => ({ id, verdict: 'pass', citations: ['e1'] })), justification: 'Passed.' } } })
  const evaluation: LoadedEvaluation = { judges: new Map([['judge', { name: 'judge', adapter: { kind: 'factory', factory }, credentials: new Map([['apiKey', { read: async () => credential }]]), options: {}, accepts: ['text'] }]]), defaultJudge: 'judge', limits: defaultEvaluationLimits, timeoutMs: 1000 }
  const judges = new Judges({ evaluation, redactor, env: {} })
  t.after(() => judges.close(1000))
  await runCorpus({ corpus: { ...corpus, cases: corpus.cases.filter((each) => each.id === 'text-saved') }, judges, judge: 'judge', repeats: 1, limits: defaultEvaluationLimits, timeoutMs: 1000, redactor, folder: tempFolder('corpus-secret-') })
  assert.equal(calls.length, 1)
  assert.doesNotMatch(JSON.stringify(calls), /Release checklist/)
})
