import { expect, test } from '@rehearsal-labs/retest'
import legacy from '../support/legacy.cts'

test('imports a CommonJS helper', async () => {
  expect(legacy).toBeDefined()
})
