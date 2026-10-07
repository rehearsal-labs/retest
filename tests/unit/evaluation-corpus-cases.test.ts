import type { CaseKind } from '../../fixtures/evaluation-corpus/runner/cases.ts'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { corpusFolder, readCorpus } from '../../fixtures/evaluation-corpus/runner/cases.ts'
import { heldFramesOf, readManifest } from '../../fixtures/evaluation-corpus/runner/evidence.ts'
import { parseArtifact } from '../../src/diagnostics/artifact.ts'
import { defaultEvaluationLimits } from '../../src/evaluation/budget.ts'
import { pngSize } from '../../src/evaluation/evidence.ts'

// The fixed corpus as files: enough cases of each kind, every label with its reason, and every piece of evidence a case
// names present and readable as what it claims. Nothing here asks a judge.

const corpus = readCorpus()
const kinds: readonly CaseKind[] = ['clear-pass', 'clear-failure', 'incomplete-evidence', 'clipped-content', 'plausible-wrong-text', 'missing-transient-event', 'prompt-injection']

describe('the evaluation corpus', () => {
  test('a seen error banner contradicts the absence requirement instead of being labelled undecided', () => {
    const labelled = corpus.cases.find((each) => each.id === 'frames-flash-absence')
    assert.ok(labelled !== undefined)
    assert.equal(labelled.label.verdict, 'fail')
    assert.equal(labelled.label.review, 'awaiting-founder')
    const manifest = readManifest('error-flash')
    assert.ok(manifest.frames.some((frame) => frame.shows.includes('error-banner')))
  })
  test('every requirement declares a kind, and the founder decisions resolve the disputed labels', () => {
    for (const each of corpus.cases) for (const requirement of Object.values(each.requirement)) assert.ok(['state', 'seen', 'never'].includes(requirement.kind), each.id)
    for (const id of ['frames-toast-wrong', 'frames-injection', 'frames-spinner-early']) {
      const each = corpus.cases.find((each) => each.id === id)
      assert.ok(each !== undefined)
      assert.ok(Object.values(each.requirement).every((criterion) => criterion.kind === 'seen'))
      assert.deepEqual([each.label.verdict, each.label.critical, each.label.review], ['inconclusive', true, 'reviewed'])
    }
    const saving = corpus.cases.find((each) => each.id === 'shot-chrome-saving')
    assert.ok(saving !== undefined)
    assert.equal(saving.requirement['saved']?.kind, 'state')
    assert.deepEqual([saving.label.verdict, saving.label.unambiguous, saving.label.review], ['fail', true, 'reviewed'])
  })

  test('holds at least 40 cases, at least ten each of text, screenshots and frame sequences', () => {
    assert.ok(corpus.cases.length >= 40, `${corpus.cases.length} cases`)
    for (const category of ['text', 'screenshot', 'frames'] as const) {
      const count = corpus.cases.filter((each) => each.category === category).length
      assert.ok(count >= 10, `${count} ${category} cases`)
    }
  })

  test('covers every kind the contract names, and each category has passes, failures and undecided cases', () => {
    for (const kind of kinds) assert.ok(corpus.cases.some((each) => each.kinds.includes(kind)), `a case probes ${kind}`)
    for (const category of ['text', 'screenshot', 'frames'] as const) {
      for (const verdict of ['pass', 'fail', 'inconclusive'] as const) assert.ok(corpus.cases.some((each) => each.category === category && each.label.verdict === verdict), `a ${category} case labelled ${verdict}`)
    }
  })

  test('every label says why, every critical case is one a pass would be wrong on, and labels awaiting review say so', () => {
    for (const each of corpus.cases) {
      assert.ok(each.label.why.trim().length > 20, `${each.id} says why`)
      if (each.label.critical) assert.notEqual(each.label.verdict, 'pass', `${each.id}: a critical case is never labelled pass`)
      if (each.label.verdict === 'fail') assert.equal(each.label.critical, true, `${each.id}: a known failure is critical`)
      assert.ok(each.source.trim().length > 0)
    }
    assert.ok(corpus.cases.filter((each) => each.label.unambiguous && each.label.verdict !== 'inconclusive').length >= 20, 'enough unambiguous pass and fail cases for the 90% gate to mean something')
  })

  test('every file a case names is present and reads as what it claims, within the default limits', () => {
    for (const each of corpus.cases) {
      for (const evidence of each.evidence) {
        if (evidence.kind === 'screenshot') {
          const data = new Uint8Array(readFileSync(join(corpusFolder, evidence.file)))
          const size = pngSize(data)
          assert.ok(size !== undefined, `${each.id}: ${evidence.file} is a PNG`)
          assert.ok(size.width <= defaultEvaluationLimits.maxImageWidth && size.height <= defaultEvaluationLimits.maxImageHeight && data.byteLength <= defaultEvaluationLimits.maxInputBytes)
        }
        if (evidence.kind === 'text') assert.ok(readFileSync(join(corpusFolder, evidence.file), 'utf8').trim().length > 0, `${each.id}: ${evidence.file} holds text`)
        if (evidence.kind === 'diagnostics') assert.ok(parseArtifact(readFileSync(join(corpusFolder, evidence.file), 'utf8'), evidence.file).ok, `${each.id}: ${evidence.file} is a diagnostics artifact`)
        if (evidence.kind === 'frames') {
          const manifest = readManifest(evidence.scene)
          for (const frame of manifest.frames) {
            const file = join(corpusFolder, 'captures', 'frames', evidence.scene, frame.file)
            assert.ok(existsSync(file), `${each.id}: ${frame.file}`)
            assert.deepEqual(pngSize(new Uint8Array(readFileSync(file))), { width: frame.width, height: frame.height }, `${each.id}: ${frame.file} is the size its manifest says`)
          }
          const held = heldFramesOf(evidence)
          const inside = (us: number): boolean => us >= manifest.clickUs + evidence.fromMs * 1000 && us <= manifest.clickUs + evidence.toMs * 1000
          assert.ok(held.frames.some((frame) => inside(frame.captureUs)), `${each.id}: the interval keeps at least one frame`)
          if (evidence.omit !== undefined) {
            const showing = evidence.omit.showing
            const taken = manifest.frames.filter((frame) => frame.shows.includes(showing) && inside(frame.captureUs))
            assert.ok(taken.length > 0, `${each.id}: frames showing ${showing} lie in the interval, so leaving them out changes the evidence`)
            assert.ok(!held.frames.some((frame) => manifest.frames.find((listed) => listed.frameId === frame.frameId)?.shows.includes(showing)), `${each.id}: no frame showing ${showing} is left`)
          }
        }
      }
    }
  })

  test('the native captures are the ones their sources name', () => {
    const sources: { captures: { file: string; sha256: string }[] } = JSON.parse(readFileSync(join(corpusFolder, 'captures', 'native', 'sources.json'), 'utf8'))
    for (const capture of sources.captures) {
      const data = readFileSync(join(corpusFolder, 'captures', 'native', capture.file))
      assert.equal(createHash('sha256').update(data).digest('hex'), capture.sha256, capture.file)
    }
  })
})
