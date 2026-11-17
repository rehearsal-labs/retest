import { writeSync } from 'node:fs'
import { expect, test } from '@rehearsal-labs/retest'

writeSync(1, `pid ${process.pid}\n`)

// Stands in for a process that is slow to go once it has told Retest it finished, as on a busy machine: its exit
// blocks for good, so it is still there when the grace runs out and Retest ends it.
process.on('exit', () => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
})

test('passes before its process is held from exiting', () => {
  expect(1).toBe(1)
})
