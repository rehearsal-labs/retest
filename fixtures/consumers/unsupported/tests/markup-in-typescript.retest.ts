import { expect, test } from 'retest'
import { markup } from '../support/markup.ts'

test('imports a TypeScript file that holds JSX', async () => {
  expect(markup).toBeDefined()
})
