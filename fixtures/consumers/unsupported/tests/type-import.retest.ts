import { expect, test } from 'retest'
import { Title } from '../support/types.ts'

test('imports a type without the type keyword', async () => {
  const title: Title = 'Release checklist'
  expect(title).toBe('Release checklist')
})
