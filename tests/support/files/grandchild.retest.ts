import { spawn } from 'node:child_process'
import { expect, test } from '@rehearsal-labs/retest'

// A test file that starts a process with its own stdio, as a test that starts a server from its file would, and
// leaves it running: the grandchild holds the test file's output pipes after the test file itself has gone.
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' })
console.log(`grandchild pid ${grandchild.pid}`)

test('passes and leaves a process behind', () => {
  expect(1).toBe(1)
})
