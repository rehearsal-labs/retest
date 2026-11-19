import { expect, test } from 'retest'
import { view } from '../support/view'

test('imports a JSX helper without its extension', async () => {
  expect(view).toBeDefined()
})
