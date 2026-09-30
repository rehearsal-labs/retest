import '../../../src/api/registry.ts?second-copy'
import { expect, test } from '@rehearsal-labs/retest'

test('never collected', () => {
  expect(1).toBe(1)
})
