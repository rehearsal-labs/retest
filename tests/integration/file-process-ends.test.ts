import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openApp } from './browser-harness.ts'
import { childLog, childLogIfAny, configSource, eventsOf, resultOf, runProject, testNamed, writeProject } from './cli-harness.ts'

// How a test file's process ends once Retest asked it to close. On GitHub's Windows runner, Node 24.12 ended such a
// process with exit code 3221226505 (0xC0000409) in the lock tests, after the process had finished its work; why Node
// did is not established. Here a test file stands in for that by killing its own process: as it exits, after it said it
// had finished, which fails nothing; or on the request to close, before it could say so, which fails the file as any
// ending no test explains does. On Windows a process that kills itself ends with an exit code rather than a signal.

const endedBadly = '(signal SIGKILL|exit code \\d+)'

const killsItselfAsItExits = `import { expect, test } from '@rehearsal-labs/retest'

process.on('exit', () => process.kill(process.pid, 'SIGKILL'))

test('passes before its process ends badly', () => {
  expect(1).toBe(1)
})
`

// The request to close reaches this listener right after Retest's own, which only queues the turn that says the file
// finished, so the process ends before it could say so.
const killsItselfOnClose = `import { expect, test } from '@rehearsal-labs/retest'

process.on('message', (message) => {
  if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'close') process.kill(process.pid, 'SIGKILL')
})

test('passes before its process ends on the request to close', () => {
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
