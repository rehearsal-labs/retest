import assert from 'node:assert/strict'
import { test } from 'node:test'
import { frameStore } from '../../fixtures/evaluation-corpus/runner/frame-store.ts'

const frame = (captureUs: number) => ({ frameId: `f${captureUs}`, captureUs, format: 'png' as const, bytes: Uint8Array.of(1), width: 40, height: 30 })
const request = { fromUs: 0, toUs: 1000, maxFrames: 10, maxWidth: 100, maxHeight: 100 }

test('the corpus store keeps a short known capture gap even below the quiet threshold', async () => {
  const store = frameStore({ frames: [frame(100), frame(150), frame(900)], frameIntervalUs: 300, captureGaps: [{ fromUs: 120, toUs: 130, reason: 'pixels_withheld' }] })
  const answer = await store.frames(request, 1000)
  assert.equal(answer.stretchesFound, 2)
  assert.deepEqual(answer.stretches.map(({ fromUs, toUs, captureGaps }) => [fromUs, toUs, captureGaps]), [[100, 150, ['pixels_withheld']], [150, 900, []]])
})

test('the corpus store includes a quiet stretch equal to the requested threshold and an empty interval shorter than it', async () => {
  const store = frameStore({ frames: [frame(100), frame(900)], frameIntervalUs: 300 })
  const answer = await store.frames({ ...request, minGapUs: 800 }, 1000)
  assert.deepEqual(answer.stretches.map(({ fromUs, toUs }) => [fromUs, toUs]), [[100, 900]])
  const empty = await frameStore({ frames: [], frameIntervalUs: 300 }).frames({ ...request, toUs: 10 }, 1000)
  assert.deepEqual(empty.stretches.map(({ fromUs, toUs }) => [fromUs, toUs]), [[0, 10]])
})
