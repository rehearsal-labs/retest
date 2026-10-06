import assert from 'node:assert/strict'
import { test } from 'node:test'
import { processesRunningExecutable } from '../integration/reference-flow-processes.ts'

test('flow cleanup identifies real Xcode processes and leaves another worker\'s fake xcodebuild and arguments outside its claim', () => {
  const executable = '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild'
  const real = { pid: 1001, command: `${executable} test-without-building -xctestrun /owned/run.xctestrun` }
  const entries = [
    real,
    { pid: 66212, command: '/bin/sh /tmp/retest-native-fake-1G1wnb/bin/xcodebuild test-without-building -xctestrun /tmp/fake/run.xctestrun' },
    { pid: 66217, command: '/usr/bin/node tests/unit/native-fake-tool.ts xcodebuild test-without-building' },
    { pid: 1002, command: `/usr/bin/node --eval ${executable}` },
    { pid: 1003, command: `${executable}-other test-without-building` },
  ]
  assert.deepEqual(processesRunningExecutable(entries, executable), [real])
  assert.deepEqual(processesRunningExecutable([{ pid: 1004, command: executable }], executable), [{ pid: 1004, command: executable }])
})
