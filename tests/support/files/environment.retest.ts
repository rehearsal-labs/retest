import { expect, test } from '@rehearsal-labs/retest'

test('prints its environment', () => {
  console.log(`environment ${JSON.stringify(Object.keys(process.env).sort())}`)
  expect(true).toBe(true)
})
