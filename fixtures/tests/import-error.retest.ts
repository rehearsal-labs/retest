import { expect, test } from '@rehearsal-labs/retest'

const helper = './missing-helper.ts'
await import(helper)

test('is never collected', () => {
  expect(1).toBe(1)
})
