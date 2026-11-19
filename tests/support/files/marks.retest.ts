import { expect, test } from 'retest'

test('makes the mark', async () => {
  const answer = await fetch(`${process.env['SIGNALS_URL']}/mark`)
  expect(await answer.text()).toBe('marked')
})
