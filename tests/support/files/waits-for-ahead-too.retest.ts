import { expect, test } from 'retest'

// The same as waits-for-ahead.retest.ts, for a second worker.
test('also lets the next files start', () => {
  expect(1).toBe(1)
})

test('also waits for the next file to load', async () => {
  const answer = await fetch(`${process.env['SIGNALS_URL']}/loaded?times=2`)
  expect(await answer.text()).toBe('loaded')
})
