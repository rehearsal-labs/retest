import { expect, test } from '@rehearsal-labs/retest'

console.log('loading the output file')

test('writes to stdout and stderr', () => {
  console.log('{"type":"not an event"}')
  console.error('a line on stderr')
  expect(1).toBe(1)
})
