import { expect, test } from '@rehearsal-labs/retest'

// Holds its worker until marks.retest.ts has run, so that file goes to the other worker.
test('waits for the mark', async () => {
  const answer = await fetch(`${process.env['SIGNALS_URL']}/marked`)
  expect(await answer.text()).toBe('marked')
})
