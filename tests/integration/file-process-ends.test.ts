import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openApp } from './browser-harness.ts'
import { childLog, childLogIfAny, configSource, eventsOf, isRunning, printedPids, resultOf, runProject, testNamed, writeProject } from './cli-harness.ts'

// How a test file's process ends once Retest asked it to close. On GitHub's Windows runner, Node 24.12 ended such a
// process with exit code 3221226505 (0xC0000409) in the lock tests, after the process had finished its work; why Node
// did is not established. Here a test file stands in for that by killing its own process: as it exits, after it said it
// had finished, which fails nothing; or on the request to close, before it could say so, which fails the file as any
// ending no test explains does. On Windows a process that kills itself ends with an exit code rather than a signal.
// A process can also be slow to go, as on a busy machine, and still be there when the grace for closing runs out: a
// test file stands in for that by blocking for good, after it said it had finished, which fails nothing, or on the
// request to close, before it could say so, which fails the file.

const endedBadly = '(signal SIGKILL|exit code \\d+)'

const killsItselfAsItExits = `import { expect, test } from 'retest'

process.on('exit', () => process.kill(process.pid, 'SIGKILL'))

test('passes before its process ends badly', () => {
  expect(1).toBe(1)
})
`

// The request to close reaches this listener right after Retest's own, which only queues the turn that says the file
// finished, so the process ends before it could say so.
const killsItselfOnClose = `import { expect, test } from 'retest'

process.on('message', (message) => {
  if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'close') process.kill(process.pid, 'SIGKILL')
})

test('passes before its process ends on the request to close', () => {
  expect(1).toBe(1)
})
`

// Blocking for good, so the process is still there when the grace runs out, whatever the machine's speed.
const block = 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)'

const heldAsItExits = `import { writeSync } from 'node:fs'
import { expect, test } from 'retest'

writeSync(1, \`pid \${process.pid}\\n\`)
process.on('exit', () => ${block})

test('passes before its process is held as it exits', () => {
  expect(1).toBe(1)
})
`

// As for killsItselfOnClose: Retest's own listener has only queued the turn that says the file finished.
const heldOnClose = `import { writeSync } from 'node:fs'
import { expect, test } from 'retest'

writeSync(1, \`pid \${process.pid}\\n\`)
process.on('message', (message) => {
  if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'close') ${block}
})

test('passes before its process is held on the request to close', () => {
  expect(1).toBe(1)
})
`

async function projectWith(t: TestContext, source: string): Promise<string> {
  const app = await openApp(t)
  return writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) } }`),
    'tests/ends.retest.ts': source,
  })
}

test('a process that ends badly as it exits, after it said it had finished, fails nothing, and its log says how it ended', async (t) => {
  const run = await runProject(t, await projectWith(t, killsItselfAsItExits))
  const outcome = resultOf(run)
  const why = { run: outcome.failure?.message, files: outcome.files.map((each) => [each.file, each.failure?.message]), stderr: run.stderr }
  assert.equal(run.exit.code, 0, JSON.stringify(why))
  assert.equal(testNamed(run, 'passes before its process ends badly').status, 'passed')
  assert.equal(outcome.files[0]?.failure, undefined)
  assert.deepEqual(eventsOf(run.events, 'file.failed'), [])
  const note = new RegExp(`^The process ended with ${endedBadly} after it had finished its work\\. No test was running, so nothing fails\\.$`, 'm')
  assert.match(childLog(run, 'tests/ends.retest.ts'), note)
})

test('a process that ends on the request to close, before it could say it had finished, fails its file', async (t) => {
  const run = await runProject(t, await projectWith(t, killsItselfOnClose))
  const outcome = resultOf(run)
  assert.equal(run.exit.code, 2, run.stderr)
  assert.equal(testNamed(run, 'passes before its process ends on the request to close').status, 'passed')
  const sentence = new RegExp(`^The process for tests/ends\\.retest\\.ts ended with ${endedBadly} while no test was running\\.$`)
  assert.match(outcome.files[0]?.failure?.message ?? '', sentence)
  assert.deepEqual(eventsOf(run.events, 'file.failed').map((event) => event.failure), [outcome.files[0]?.failure])
  assert.doesNotMatch(childLogIfAny(run, 'tests/ends.retest.ts'), /after it had finished its work/)
})

test('a process held from exiting after it said it had finished is ended by Retest, fails nothing, and its log says so', async (t) => {
  const run = await runProject(t, await projectWith(t, heldAsItExits))
  const outcome = resultOf(run)
  const why = { run: outcome.failure?.message, files: outcome.files.map((each) => [each.file, each.failure?.message]), stderr: run.stderr }
  assert.equal(run.exit.code, 0, JSON.stringify(why))
  assert.equal(testNamed(run, 'passes before its process is held as it exits').status, 'passed')
  assert.equal(outcome.files[0]?.failure, undefined)
  assert.deepEqual(eventsOf(run.events, 'file.failed'), [])
  const log = childLog(run, 'tests/ends.retest.ts')
  assert.match(log, /^The process had finished its work but had not exited within 1000 ms of being asked to close, so Retest ended it\. No test was running, so nothing fails\.$/m)
  const [pid] = printedPids(log)
  assert.ok(pid !== undefined, 'the test file printed its process id')
  assert.equal(isRunning(pid), false, 'Retest ended the held process')
})

test('a process held on the request to close, before it could say it had finished, is ended by Retest and fails its file', async (t) => {
  const run = await runProject(t, await projectWith(t, heldOnClose))
  const outcome = resultOf(run)
  assert.equal(run.exit.code, 2, run.stderr)
  assert.equal(testNamed(run, 'passes before its process is held on the request to close').status, 'passed')
  assert.equal(outcome.files[0]?.failure?.message, 'The process for tests/ends.retest.ts did not close within 1000 ms of being asked to, so Retest ended it.')
  assert.deepEqual(eventsOf(run.events, 'file.failed').map((event) => event.failure), [outcome.files[0]?.failure])
  const log = childLog(run, 'tests/ends.retest.ts')
  assert.doesNotMatch(log, /had finished its work/)
  const [pid] = printedPids(log)
  assert.ok(pid !== undefined, 'the test file printed its process id')
  assert.equal(isRunning(pid), false, 'Retest ended the held process')
})
