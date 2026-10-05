import type { CapturedFirefoxPage } from '../../src/browser/firefox/capture.ts'
import type { CapturedFrame, SourceGap } from '../../src/media/capture.ts'
import type { RecordIdentity } from '../../src/protocol/identity.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { FirefoxFrameSource } from '../../src/browser/firefox/capture.ts'
import { microsecondsSince } from '../../src/media/capture.ts'

const identity: RecordIdentity = { testId: 'capture', attemptId: 'a1', app: 'web', sessionId: 'a1:web' }
const bytes = Uint8Array.of(137, 80, 78, 71)
function page(): CapturedFirefoxPage & { lostReason: string | undefined; calls: number } {
  return { identity, lostReason: undefined, calls: 0, screenshot() { this.calls += 1; return Promise.resolve(bytes) } }
}

test('Firefox screenshots stay encoded and are stamped with their request span on the run clock', async () => {
  const target = page()
  const source = new FirefoxFrameSource(target, identity)
  const frames: CapturedFrame[] = []
  assert.deepEqual(source.availability(), { available: true, mode: 'screenshot-loop' })
  const begun = await source.start({ fps: 30, clock: microsecondsSince(performance.now()), deliver: (frame) => frames.push(frame), ended: () => assert.fail('capture must run'), timeoutMs: 1000 })
  assert.equal(begun.ok, true)
  const stats = await source.stop(1000)
  assert.equal(frames[0]?.bytes, bytes)
  assert.deepEqual(frames[0]?.identity, identity)
  assert.ok(frames[0]?.earliestUs !== undefined && frames[0].earliestUs <= frames[0].timestampUs)
  assert.deepEqual(stats.clockMapping, { timestamp: 'run-arrival', targetClock: 'not-used', imageRead: 'request-to-arrival' })
  assert.equal(target.calls, 1)
})

test('a foreign identity is refused without a screenshot', async () => {
  const target = page()
  const source = new FirefoxFrameSource(target, { ...identity, sessionId: 'other:web' })
  assert.equal(source.availability().available, false)
  assert.equal((await source.start({ fps: 10, clock: () => 0, deliver: () => assert.fail(), ended: () => assert.fail(), timeoutMs: 100 })).ok, false)
  assert.equal(target.calls, 0)
})

test('a suspended Firefox source notices page closure without asking for pixels', async () => {
  const target = page()
  const source = new FirefoxFrameSource(target, identity)
  const reasons: string[] = []
  const gaps: SourceGap[] = []
  await source.start({ fps: 30, clock: microsecondsSince(performance.now()), deliver: () => assert.fail('pixels are withheld'), ended: (reason) => reasons.push(reason), gap: (gap) => gaps.push(gap), withheld: () => true, timeoutMs: 1000 })
  target.lostReason = 'the page was closed'
  await sleep(80)
  const stats = await source.stop(1000)
  assert.equal(reasons.length, 1)
  assert.match(reasons[0] ?? '', /the page was closed/)
  assert.equal(target.calls, 0)
  assert.equal(stats.delivered, 0)
  assert.equal(gaps[0]?.reason, 'target_lost')
})
