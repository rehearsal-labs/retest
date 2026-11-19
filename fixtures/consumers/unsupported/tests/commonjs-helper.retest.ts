import { expect, test } from 'retest'
import legacy from '../support/legacy.cts'

test('imports a CommonJS helper', async () => {
  expect(legacy).toBeDefined()
})
