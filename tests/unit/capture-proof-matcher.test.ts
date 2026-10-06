import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchVideo } from '../integration/capture-proof.ts'

const picture = (value: number) => ({ width: 1, height: 1, pixels: Uint8Array.of(value) })
const times = { timestampsUs: [1000, 101000], fps: 10 }

test('identical source images still require the mapped frame to follow timestamp order', () => {
  const frames = [picture(100), picture(100)]
  assert.deepEqual(matchVideo(frames, frames, ['1', '2'], times).unmapped, [])
  assert.deepEqual(matchVideo(frames, frames, ['2', '1'], times).unmapped, [0, 1])
})

test('a brightness tie inside the unchanged threshold uses timestamp order', () => {
  const frames = [picture(100), picture(125)]
  const matched = matchVideo([picture(100), picture(125)], frames, ['1', '2'], times)
  assert.deepEqual(matched.unmapped, [])
  assert.ok(matched.matched.every(entry => entry.nearestOther === undefined || entry.own < entry.nearestOther))
})

test('a tie between distinguishable sources keeps the strict rejection', () => {
  const matched = matchVideo([picture(125), picture(125)], [picture(50), picture(200)], ['1', '2'], times)
  assert.deepEqual(matched.unmapped, [])
  assert.ok(matched.matched.every(entry => entry.nearestOther !== undefined && entry.own >= entry.nearestOther))
})

test('a closer indistinguishable source cannot be excused by timestamp order', () => {
  const matched = matchVideo([picture(149)], [picture(100), picture(125)], ['1'], times)
  assert.equal(matched.matched[0]?.own, 1)
  assert.equal(matched.matched[0]?.nearestOther, 0)
})

test('the comparison boundary stays at 48 and does not excuse a 49-level source difference', () => {
  const tied = matchVideo([picture(124)], [picture(100), picture(148)], ['1'], times)
  assert.equal(tied.matched[0]?.nearestOther, undefined)
  const distinguishable = matchVideo([picture(124)], [picture(100), picture(149)], ['1'], times)
  assert.equal(distinguishable.matched[0]?.nearestOther, 0)
})

test('the later source wins when two identical sources have the same output tick', () => {
  const frames = [picture(100), picture(100)]
  const sameTick = { timestampsUs: [1000, 41000], fps: 10 }
  assert.deepEqual(matchVideo([picture(100)], frames, ['2'], sameTick).unmapped, [])
  assert.deepEqual(matchVideo([picture(100)], frames, ['1'], sameTick).unmapped, [0])
})
