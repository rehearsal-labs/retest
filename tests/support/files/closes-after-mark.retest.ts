import { existsSync } from 'node:fs'
import { expect, test } from '@rehearsal-labs/retest'

// After its test, its process cannot take the request to close until the marker named by SIGNALS_MARK exists, which
// marks.retest.ts makes once its own test runs.
test('leaves a wait for the mark behind', () => {
  const marker = process.env['SIGNALS_MARK'] ?? ''
  setTimeout(() => {
    while (!existsSync(marker)) {
      // Never yields until the marker is there.
    }
  }, 10)
  expect(1).toBe(1)
})
