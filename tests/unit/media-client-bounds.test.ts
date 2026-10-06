import assert from 'node:assert/strict'
import { test } from 'node:test'
import { worker } from './media-client-fixtures.ts'

test('concurrent thumbnails to a stopped consumer obey the byte bound and name refusals', async t => {
  const limit = 2 * 1024 * 1024
  const media = await worker(t, 'stopped', { maxPendingBytes: limit })
  const jobs = Array.from({ length: 32 }, (_, index) => media.thumbnail({ output: `/fixture/thumb-${index}`, maxWidth: 8, maxHeight: 8, format: 'png' }, { format: 'png', bytes: Buffer.alloc(1024 * 1024) }, 100).then(() => assert.fail('stopped consumer answered'), (error: Error) => error.message))
  // These calls are concurrent, before drain or any request timeout can release admission.
  assert.ok(media.traffic.imageBytes <= limit, `admitted ${media.traffic.imageBytes} image bytes to a stopped consumer`)
  const errors = await Promise.all(jobs)
  assert.ok(errors.some(error => /thumbnail.*(byte limit|drain|pending)/i.test(error)), errors.join('\n'))
})

for (const kind of ['ready', 'start', 'frames', 'leftovers', 'release', 'watch'] as const) {
  test(`pending ${kind} requests have a count cap`, async t => {
    const media = await worker(t, 'stopped', { maxPendingRequests: 2 })
    const request = (index: number): Promise<unknown> => {
      if (kind === 'ready') return media.ready(100)
      if (kind === 'start') return media.record({ recordingId: `r${index}`, identity: { runId: 'run', attemptId: 'attempt', testId: 'test', app: 'web', sessionId: 'session' }, output: `/fixture/r${index}`, width: 8, height: 8, fps: 10, deadlineMs: 1000 }, 100)
      if (kind === 'frames') return media.frames(`r${index}`, { fromUs: 0, toUs: 1, maxFrames: 1, maxWidth: 8, maxHeight: 8 }, 100)
      if (kind === 'leftovers') return media.leftovers(`/fixture/r${index}`, { remove: false }, 100)
      if (kind === 'release') return media.release(`r${index}`, 100)
      return media.watch(`r${index}`, { maxWidth: 8, maxHeight: 8, maxFps: 1 }, () => undefined, 100)
    }
    const first = request(1).catch(() => undefined)
    const second = request(2).catch(() => undefined)
    await assert.rejects(request(3), /pending request limit/i)
    await Promise.all([first, second])
  })
}

test('timed-out starts remain bounded while their replies are abandoned', async t => {
  const media = await worker(t, 'stopped', { maxPendingRequests: 2 })
  for (let index = 0; index < 2; index++) {
    await assert.rejects(media.record({ recordingId: `r${index}`, identity: { runId: 'run', attemptId: 'attempt', testId: 'test', app: 'web', sessionId: 'session' }, output: `/fixture/r${index}`, width: 8, height: 8, fps: 10, deadlineMs: 1000 }, 5), /did not answer/)
  }
  await assert.rejects(media.record({ recordingId: 'refused', identity: { runId: 'run', attemptId: 'attempt', testId: 'test', app: 'web', sessionId: 'session' }, output: '/fixture/refused', width: 8, height: 8, fps: 10, deadlineMs: 1000 }, 100), /pending request limit/i)
})
