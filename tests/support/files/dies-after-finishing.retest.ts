import { expect, test } from '@rehearsal-labs/retest'

// Stands in for Node failing while the process exits, as it can on Windows: the process has told Retest it finished,
// and then ends with no orderly exit. A kill rather than an abort, so no crash report is written for it.
process.on('exit', () => process.kill(process.pid, 'SIGKILL'))

test('passes before its process ends badly', () => {
  expect(1).toBe(1)
})
