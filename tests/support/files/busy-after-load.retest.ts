import { writeSync } from 'node:fs'
import { expect, test } from '@rehearsal-labs/retest'

setTimeout(() => {
  writeSync(1, 'busy\n')
  for (;;) {
    // Never yields, so the process cannot take the request to close.
  }
}, 50)

test('waits its turn', () => {
  expect(1).toBe(1)
})
