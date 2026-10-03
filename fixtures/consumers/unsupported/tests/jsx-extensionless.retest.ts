import { expect, test } from '@rehearsal-labs/retest'
import { view } from '../support/view'

test('imports a JSX helper without its extension', async () => {
  expect(view).toBeDefined()
})
