import '../../../src/api/registry.ts?second-copy'
import { expect, test } from 'retest'

test('never collected', () => {
  expect(1).toBe(1)
})
