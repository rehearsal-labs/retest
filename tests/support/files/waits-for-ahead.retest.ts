import { expect, test } from 'retest'

// Its first test lets the run start the next files' processes, which it does once a file's first test is over; its
// second holds its worker until ahead-signals.retest.ts has loaded a second time, which only a load ahead of its turn
// does while every worker is held.
test('lets the next files start', () => {
  expect(1).toBe(1)
})

test('waits for the next file to load', async () => {
  const answer = await fetch(`${process.env['SIGNALS_URL']}/loaded?times=2`)
  expect(await answer.text()).toBe('loaded')
})
