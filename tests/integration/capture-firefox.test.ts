import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { after } from 'node:test'
import { browserCaptureProof } from './capture-browser-proof.ts'
process.env['RETEST_TEST_ENGINE'] = 'firefox'
browserCaptureProof('firefox', 'screenshot-loop')

after(async () => {
  const endsAt = performance.now() + 1000
  let active: string[]
  let owned: string[]
  do {
    await nextTurn()
    active = process.getActiveResourcesInfo()
    owned = active.filter(type => ['TCPSocketWrap', 'TCPServerWrap', 'ProcessWrap', 'Timeout', 'FSEventWrap'].includes(type))
  } while (owned.length > 0 && performance.now() < endsAt)
  assert.deepEqual(owned, [], `Firefox capture close leaves no socket, server, child, timer or watcher: ${JSON.stringify(active)}`)
})
