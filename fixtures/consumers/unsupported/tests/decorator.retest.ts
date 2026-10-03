import { expect, test } from '@rehearsal-labs/retest'
import { Tasks } from '../support/decorated.ts'

test('imports a class with a decorator', async () => {
  expect(new Tasks().count()).toBe(1)
})
