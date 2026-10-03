import { expect, test } from '@rehearsal-labs/retest'
import { view } from '../support/view.tsx'

test('imports a JSX helper', async () => {
  expect(view).toBeDefined()
})
