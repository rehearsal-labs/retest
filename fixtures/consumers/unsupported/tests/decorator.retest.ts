import { expect, test } from 'retest'
import { Tasks } from '../support/decorated.ts'

test('imports a class with a decorator', async () => {
  expect(new Tasks().count()).toBe(1)
})
