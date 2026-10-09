import type { Hello } from '../../src/media/protocol.ts'
import type { EventBody } from '../../src/protocol/events.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mediaTarget, mediaVersion } from '../../src/cli/install/media-pins.ts'
import { RunMedia } from '../../src/runner/run-media.ts'
import { newRunFolder } from '../support/run-harness.ts'
import { unpinnedMedia } from '../support/unpinned-host.ts'
import { fakeMediaStarter } from './runner-recording-fakes.ts'

for (const [name, fields, message] of [
  ['version', { version: '99.99.99' }, /99\.99\.99.*expected 0\.1\.0/],
  ['target', { build: { target: 'another-host', profile: 'release' } }, /another-host.*expected/],
  // A machine with no pinned target refuses every greeting for that alone; only the version is checked before it.
  ['profile', { build: { target: mediaTarget() ?? 'aarch64-apple-darwin', profile: 'debug' } }, /debug.*expected.*release/],
] as const) {
  test(`the live runner refuses the wrong media ${name} by name before encoder readiness`, { skip: name === 'version' ? false : unpinnedMedia }, async () => {
    const fake = fakeMediaStarter()
    const events: EventBody[] = []
    let readyCalls = 0
    const media = new RunMedia({ location: { executable: '/fake/retest-media' }, start: async (location, budget) => {
      const process = await fake.start(location, budget)
      const hello: Hello = { ...process.hello, ...fields }
      Object.defineProperty(process, 'hello', { value: hello })
      const ready = process.ready.bind(process)
      process.ready = timeout => { readyCalls++; return ready(timeout) }
      return process
    }, emit: event => void events.push(event), timeouts: { start: 100, close: 100, leftovers: 100 }, runFolder: newRunFolder() })
    try {
      const acquired = await media.acquire()
      assert.ok(!acquired.ok)
      assert.equal(acquired.code, 'media_unavailable')
      assert.match(acquired.message, message)
      assert.ok(acquired.message.includes('/fake/retest-media'))
      assert.equal(readyCalls, 0)
      assert.equal(events.some(event => event.type === 'media.started'), false)
      assert.equal(fake.started[0]?.closes, 1)
      assert.ok(!(await media.acquire()).ok)
      assert.equal(fake.started.length, 1)
    } finally { assert.equal(await media.close(), undefined) }
  })
}

test('the live runner accepts the pinned host release greeting with one start', { skip: unpinnedMedia }, async () => {
  const fake = fakeMediaStarter()
  // An accepted start also reads this process's own start from the host through the metadata worker, whose first
  // reading starts its thread: about 35 ms on a Mac, while on a hosted x64 runner the case ran out of a 100 ms budget.
  // The fake answers at once, so this budget bounds that one host reading.
  const media = new RunMedia({ location: { executable: '/fake/retest-media' }, start: async (location, budget) => {
    const process = await fake.start(location, budget)
    Object.defineProperty(process, 'hello', { value: { ...process.hello, version: mediaVersion, build: { target: mediaTarget(), profile: 'release' } } })
    return process
  }, emit: () => undefined, timeouts: { start: 5000, close: 100, leftovers: 100 }, runFolder: newRunFolder() })
  try {
    for (const acquired of [await media.acquire(), await media.acquire()]) assert.ok(acquired.ok, acquired.ok ? '' : `${acquired.code}: ${acquired.message}`)
    assert.equal(fake.started.length, 1)
  } finally { assert.equal(await media.close(), undefined) }
})
