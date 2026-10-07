import type { EvaluationRecord } from '../../src/protocol/evaluation.ts'
import type { TestResult } from '../../src/protocol/result.ts'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { fakeCalls } from '../support/fake-evaluator.ts'
import { runProject, tempProject } from '../support/project.ts'

// `test.evaluate` with the evidence and criteria this lane adds, through a real test file process and the runner's own
// parent path, with the fake browser and the fake judge: a recording by step or by length, diagnostics by part, and a
// requirement that something does not appear. The run here records nothing and gives the checks no diagnostics, so
// each check says so by name; what is shown is that the test file's words reach the parent as the selectors the parent
// acts on, and that every mistake is refused in the test file before anything is sent.

const fakeJudge = fileURLToPath(new URL('../support/fake-evaluator.ts', import.meta.url))
const tag = 'evidence-api'

const config = `import { chromium, defineConfig } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173', executablePath: '/fake/chromium' }) },
  evaluation: {
    judges: {
      visual: { adapter: ${JSON.stringify(fakeJudge)}, options: { tag: '${tag}' }, accepts: ['text', 'images', 'frames'] },
      words: { adapter: ${JSON.stringify(fakeJudge)}, options: { tag: '${tag}-words' }, accepts: ['text'] },
    },
    defaultJudge: 'visual',
    timeoutMs: 2000,
  },
})
`

const tests = `import { test } from '@rehearsal-labs/retest'

test('a recorded step', async () => {
  await test.evaluate({ requirement: { pass: 'The notification appears.' }, evidence: { recording: { step: 'save' } } })
})

test('a length of recording', async () => {
  await test.evaluate({ requirement: { pass: 'The notification appears.' }, evidence: { app: 'web', recording: { lastMs: 1500 } } })
})

test('diagnostics by part', async () => {
  await test.evaluate({ judge: 'words', requirement: { pass: 'No request failed.' }, evidence: { diagnostics: ['network', 'console'] } })
})

test('an absence beside a sentence, over text', async () => {
  await test.evaluate({ requirement: { pass: 'The banner says saved.', calm: { requirement: 'No error is shown.', absence: true } }, evidence: { text: 'Saved.', label: 'banner' } })
})

test('an absence over frames', async () => {
  await test.evaluate({ requirement: { calm: { requirement: 'No error banner appears.', absence: true } }, evidence: { recording: { step: 'save' } } })
})

test('explicit kinds over frames', async () => {
  await test.evaluate({ requirement: { end: { kind: 'state', requirement: 'Saved.' }, toast: { kind: 'seen', requirement: 'A toast appears.' }, calm: { kind: 'never', requirement: 'No error appears.' } }, evidence: { recording: { step: 'save' } } })
})

test('an unknown criterion kind', async () => {
  await test.evaluate({ requirement: { calm: { kind: 'sometimes', requirement: 'x' } }, evidence: { recording: { step: 'save' } } })
})

test('a kind with an absence marker', async () => {
  await test.evaluate({ requirement: { calm: { kind: 'seen', requirement: 'x', absence: true } }, evidence: { recording: { step: 'save' } } })
})

test('a recording with both a step and a length', async () => {
  await test.evaluate({ requirement: 'x', evidence: { recording: { step: 'save', lastMs: 100 } } })
})

test('a length that is not whole', async () => {
  await test.evaluate({ requirement: 'x', evidence: { recording: { lastMs: 1.5 } } })
})

test('a part it does not know', async () => {
  await test.evaluate({ requirement: 'x', evidence: { diagnostics: ['console', 'storage'] } })
})

test('a part twice', async () => {
  await test.evaluate({ requirement: 'x', evidence: { diagnostics: ['console', 'console'] } })
})

test('an absence without its mark', async () => {
  await test.evaluate({ requirement: { calm: { requirement: 'No error.', absence: false } }, evidence: { text: 'Saved.' } })
})

test('an absence with another key', async () => {
  await test.evaluate({ requirement: { calm: { requirement: 'No error.', absence: true, weight: 2 } }, evidence: { text: 'Saved.' } })
})
`

describe('test.evaluate with frames, diagnostics and absence', async () => {
  const root = tempProject({ 'retest.config.ts': config, 'tests/evidence.retest.ts': tests })
  const record = await runProject(root, { files: ['tests/evidence.retest.ts'] })
  const results = new Map<string, TestResult>(record.result.files.flatMap((file) => file.tests).map((each) => [each.name, each]))
  const evaluation = (name: string): EvaluationRecord | undefined => results.get(name)?.evaluations?.[0]
  const calls = fakeCalls.filter((call) => call.tag === tag || call.tag === `${tag}-words`)

  test('a recorded step reaches the parent as a step of the app, which says the run records nothing', () => {
    const checked = evaluation('a recorded step')
    assert.deepEqual([checked?.verdict, checked?.failure?.class], ['error', 'evaluation_error'])
    assert.match(checked?.reason ?? '', /The run does not record web, so the check has no frames of it\. Record web to judge its frames\./)
    assert.deepEqual([checked?.evidence[0]?.kind, checked?.evidence[0]?.status], ['frames', 'unavailable'])
  })

  test('a length of recording reaches the parent too', () => {
    const checked = evaluation('a length of recording')
    assert.equal(checked?.verdict, 'error')
    assert.match(checked?.reason ?? '', /The run does not record web/)
  })

  test('diagnostics by part reach the parent in the order console, network, and a run that gives none leaves the check undecided', () => {
    const checked = evaluation('diagnostics by part')
    assert.deepEqual([checked?.verdict, checked?.evidence[0]?.kind, checked?.evidence[0]?.include, checked?.evidence[0]?.status], ['inconclusive', 'diagnostics', ['console', 'network'], 'unavailable'])
    assert.match(checked?.reason ?? '', /The console and network records of web are not available, so the check has none to judge/)
    assert.equal(results.get('diagnostics by part')?.status, 'inconclusive')
  })

  test('an absence over text is sent to the judge marked, and judged', () => {
    const checked = evaluation('an absence beside a sentence, over text')
    assert.equal(checked?.verdict, 'pass')
    assert.deepEqual(checked?.criteria.map(({ id, absence }) => [id, absence]), [['pass', undefined], ['calm', true]])
    const sent = calls.find((call) => call.criteria.some((criterion) => criterion.id === 'calm' && criterion.requirement === 'No error is shown.'))
    assert.deepEqual(sent?.criteria, [{ id: 'pass', requirement: 'The banner says saved.' }, { id: 'calm', requirement: 'No error is shown.', absence: true }])
  })

  test('an absence over frames is marked in the record, whatever else stops the check', () => {
    const checked = evaluation('an absence over frames')
    assert.deepEqual(checked?.criteria.map(({ id, absence }) => [id, absence]), [['calm', true]])
    assert.notEqual(checked?.verdict, 'pass')
  })

  test('all explicit kinds reach the parent without being read from their wording', () => {
    const checked = evaluation('explicit kinds over frames')
    assert.equal(checked?.verdict, 'error', 'the run has no recording')
    assert.deepEqual(checked?.criteria.map(({ id, kind }) => [id, kind]), [['end', 'state'], ['toast', 'seen'], ['calm', 'never']])
  })

  test('each mistake is refused in the test file by name, and nothing of it reaches a judge', () => {
    const refused: [string, RegExp][] = [
      ['an unknown criterion kind', /takes the requirement of calm as \{ requirement, kind: 'state', 'seen' or 'never' \}/],
      ['a kind with an absence marker', /takes the requirement of calm as \{ requirement, kind: 'state', 'seen' or 'never' \}/],
      ['a recording with both a step and a length', /test\.evaluate\(\) takes a recording as \{ step \} naming a step of the test, or \{ lastMs \}/],
      ['a length that is not whole', /takes a recording as \{ step \}/],
      ['a part it does not know', /test\.evaluate\(\) takes evidence as .*\{ diagnostics: 'console', 'network' or both, app\? \}/],
      ['a part twice', /\{ diagnostics: 'console', 'network' or both, app\? \}/],
      ['an absence without its mark', /takes the requirement of calm as text, or as \{ requirement, absence: true \}/],
      ['an absence with another key', /takes the requirement of calm as text, or as \{ requirement, absence: true \}/],
    ]
    for (const [name, message] of refused) {
      const result = results.get(name)
      assert.equal(result?.failure?.class, 'usage', name)
      assert.match(result?.failure?.message ?? '', message, name)
      assert.deepEqual(result?.evaluations ?? [], [], `${name}: no check reached the parent`)
    }
    assert.equal(calls.length, 1, 'only the text check was sent to a judge')
  })
})
