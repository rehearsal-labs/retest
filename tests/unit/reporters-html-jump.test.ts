import type { RecordingClock } from '../../src/protocol/recording.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { jumpScript } from '../../src/reporters/html/jump-script.ts'

const clock: RecordingClock = { capture: 'run_us', videoZeroUs: 500_000, durationUs: 4_000_000, shortened: [{ captureUs: 3_000_000, shortenedByUs: 1_000_000 }], shortenedCount: 1 }

function playback(mapping: RecordingClock | null = clock, recordingId = 'rec-1') {
  const clicks: (() => void)[] = []
  const loads: (() => void)[] = []
  const note = { textContent: '' }
  const button: { dataset: { elapsedMs: string; jumpApp?: string }; addEventListener: (type: string, listener: () => void) => void } = {
    dataset: { elapsedMs: '3500' },
    addEventListener(type, listener) { assert.equal(type, 'click'); clicks.push(listener) },
  }
  const video = { currentTime: 0.25, duration: 4, readyState: 1, addEventListener(type: string, listener: () => void) { assert.equal(type, 'loadedmetadata'); loads.push(listener) } }
  const section = {
    dataset: { recordingId },
    querySelector(selector: string) {
      if (selector === 'video') return video
      assert.equal(selector, '[data-jump-note]')
      return note
    },
  }
  const root = { querySelectorAll(selector: string) {
    if (selector === '[data-recording-id]') return [section]
    assert.equal(selector, '[data-jump-step]')
    return [button]
  } }
  const data = { version: 1, tests: [{ elementId: 'test-1', recordings: [{ recordingId, app: 'web', clock: mapping }] }] }
  const document = { getElementById(id: string) {
    if (id === 'retest-recording-clocks') return { textContent: JSON.stringify(data) }
    assert.equal(id, 'test-1')
    return root
  } }
  runInNewContext(jumpScript, { document })
  return { video, button, note, click() { for (const listener of clicks) listener() }, loaded() { for (const listener of loads) listener() } }
}

test('the fixed script seeks from run milliseconds, subtracting only shortened gaps up to that moment', () => {
  const player = playback()
  player.click()
  assert.equal(player.video.currentTime, 2)
  player.button.dataset.elapsedMs = '2500.5'
  player.click()
  assert.equal(player.video.currentTime, 2.0005, 'sub-millisecond event timing is preserved')
  player.button.dataset.elapsedMs = '3000'
  player.click()
  assert.equal(player.video.currentTime, 1.5, 'a gap applies at its following frame timestamp')
})

test('seek clamps inside both the recording interval and the actual playable interval', () => {
  const player = playback()
  player.button.dataset.elapsedMs = '0'
  player.click()
  assert.equal(player.video.currentTime, 0)
  player.button.dataset.elapsedMs = '10000'
  player.click()
  assert.equal(player.video.currentTime, 4)
  player.video.duration = 2.75
  player.click()
  assert.equal(player.video.currentTime, 2.75)
})

for (const [label, mapping] of [
  ['absent', null],
  ['truncated gaps', { ...clock, shortenedCount: 2 }],
  ['unordered gaps', { ...clock, shortened: [{ captureUs: 3_000_000, shortenedByUs: 1_000_000 }, { captureUs: 2_000_000, shortenedByUs: 500_000 }], shortenedCount: 2 }],
  ['impossible shortening', { ...clock, shortened: [{ captureUs: 3_000_000, shortenedByUs: 4_000_000 }] }],
  ['empty interval', { ...clock, durationUs: 0 }],
  ['unsafe timestamp', { ...clock, videoZeroUs: Number.MAX_SAFE_INTEGER + 1 }],
] satisfies [string, RecordingClock | null][]) test(`a ${label} clock mapping leaves the video untouched and names the refusal`, () => {
  const player = playback(mapping)
  player.click()
  assert.equal(player.video.currentTime, 0.25)
  assert.equal(player.note.textContent, 'Cannot jump to a step: the recording clock mapping is incomplete.')
})

test('a named app step seeks only its own recording, and hostile recording ids are equality data', () => {
  const player = playback(clock, '</script><script>alert(1)</script>" ] #test-2')
  player.button.dataset.jumpApp = 'other'
  player.click()
  assert.equal(player.video.currentTime, 0.25)
  player.button.dataset.jumpApp = 'web'
  player.click()
  assert.equal(player.video.currentTime, 2)
})

test('metadata loading keeps the latest requested step and an unavailable interval never seeks', () => {
  const player = playback()
  player.video.readyState = 0
  player.click()
  assert.equal(player.video.currentTime, 0.25)
  player.button.dataset.elapsedMs = '1000'
  player.click()
  player.video.readyState = 1
  player.loaded()
  assert.equal(player.video.currentTime, 0.5)
  player.video.duration = Number.NaN
  player.click()
  assert.equal(player.video.currentTime, 0.5)
  assert.equal(player.note.textContent, 'Cannot jump to a step: the video interval is unavailable.')
})
