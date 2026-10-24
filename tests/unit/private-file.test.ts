import assert from 'node:assert/strict'
import { test } from 'node:test'
import { keepFolderToUser, runOwnedTool } from '../../src/shared/private-file.ts'
import { windowsOnly } from '../support/platform-skip.ts'
import { tempFolder } from '../support/temp-folder.ts'

// The Windows tools that keep a folder to its user run through the launch seam and are waited for; how each ended is
// the detail of the failure a person reads. Node stands in for them here.

test('on macOS and Linux a folder is kept to its user by its mode, and nothing runs', async () => {
  await keepFolderToUser(tempFolder('private-'), 'darwin')
  await keepFolderToUser(tempFolder('private-'), 'linux')
})

test('a tool that ends with 0 is done, and what it printed is given back', { skip: windowsOnly('the tools run through retest-supervisor on Windows') }, async () => {
  const output: string[] = []
  assert.equal(await runOwnedTool(process.execPath, ['-e', "process.stdout.write('S-1-5-21-1-1001')"], { output }), undefined)
  assert.deepEqual(output, ['S-1-5-21-1-1001'])
})

test('a tool that fails is named by its exit code and its first line', { skip: windowsOnly('the tools run through retest-supervisor on Windows') }, async () => {
  assert.equal(await runOwnedTool(process.execPath, ['-e', "process.stderr.write('Access is denied.\\nmore\\n'); process.exit(5)"]), 'ended with exit code 5: Access is denied.')
})

test('a tool that outlasts its time is ended and says so', { skip: windowsOnly('the tools run through retest-supervisor on Windows') }, async () => {
  const started = performance.now()
  assert.equal(await runOwnedTool(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { timeoutMs: 1000 }), 'did not finish within 1000 ms and was ended')
  assert.ok(performance.now() - started < 10_000, 'the run returned once the tool was ended')
})
