import type { TestContext } from 'node:test'
import type { FinishedRun, StartedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { retestEventSchema } from '../../src/protocol/events.ts'
import { browserLogFile } from '../../src/protocol/run-folder.ts'
import { openApp, waitForGroupEnd } from './browser-harness.ts'
import {
  budgets,
  childLog,
  completeLines,
  eventsOf,
  exampleFile,
  finishRun,
  inspectJson,
  onlyEvent,
  onlyTest,
  parseLine,
  profilesIn,
  readFinishedRun,
  resultOf,
  runRetest,
  scenario,
  startRun,
} from './cli-harness.ts'

test('reporter integrity: test output and page logs never reach the JSONL stream, and the run folder keeps them', async (t) => {
  const app = await openApp(t, { mode: 'noisy' })
  const file = scenario('output')
  const run = await runRetest(t, { files: [file], baseUrl: app.url })

  assert.equal(run.exit.code, 0)
  assert.ok(run.stdout.endsWith('\n'), 'stdout ends with a whole line')
  const printed = completeLines(run.stdout).map((line, index) => parseLine(retestEventSchema, line, `stdout line ${index + 1}`))
  assert.deepEqual(printed, run.events, 'stdout carries exactly the events in events.jsonl')
  assert.equal(printed.at(-1)?.type, 'run.finished')
  for (const text of ['printed while the file loads', 'a line the test printed', 'from the task app']) {
    assert.equal(run.stdout.includes(text), false, `stdout does not carry "${text}"`)
  }
  const log = childLog(run, file)
  for (const text of [
    'printed while the file loads',
    'a line the test printed on stdout',
    'a line the test printed on stderr',
    '"type":"test.finished","status":"passed"',
  ]) {
    assert.ok(log.includes(text), `the file log keeps "${text}"`)
  }
  assert.ok(existsSync(join(run.output, browserLogFile)), 'the browser log is in the run folder')
})

test('reporter integrity: a JSONL reader that goes away makes the run unsuccessful, and the stored result says so', async (t) => {
  const app = await openApp(t)
  const started = await startRun(t, { files: [exampleFile], baseUrl: app.url })
  await started.retest.waitForEvent('run.started')
  started.retest.closeStdout()
  const run = await finishRun(started)

  assert.equal(run.exit.code, 2)
  const result = resultOf(run)
  assert.deepEqual([result.status, result.exitCode], ['error', 2], 'result.json records the exit code the command returned')
  assert.match(run.stderr, /stdout|output/i, 'stderr says why the command failed')
})

test('reporter integrity: a reader that closes stderr leaves the report on stdout and its exit code alone', async (t) => {
  const app = await openApp(t)
  const started = await startRun(t, { files: [scenario('output')], baseUrl: app.url, reporter: 'human' })
  started.retest.closeStderr()
  const run = await finishRun(started)

  assert.equal(run.exit.code, 0)
  const result = resultOf(run)
  assert.deepEqual([result.status, result.exitCode], ['passed', 0])
  assert.match(run.stdout, /\n {2}Exit {4}0\n/, 'stdout carries the whole report')
})

// A run caught while its assertion waits on a save the app answers only after a minute.
async function startMidTest(t: TestContext): Promise<StartedRun & { browserPid: number }> {
  const app = await openApp(t, { mode: 'delayed', delayMs: 60_000 })
  const timeouts = budgets({ assertion: 30_000, test: 40_000 })
  const started = await startRun(t, { files: [exampleFile], baseUrl: app.url, timeouts })
  const browser = await started.retest.waitForEvent('browser.started')
  await started.retest.waitForEvent('action.completed', (event) => event.command === 'click')
  return { ...started, browserPid: browser.pid }
}

// SIGKILL leaves Retest no moment to clean up. Its test file process and the browser end on their own once
// their pipes close; the browser profile stays behind.
async function killMidTest(t: TestContext): Promise<FinishedRun & { tmp: string }> {
  const started = await startMidTest(t)
  started.retest.signal('SIGKILL')
  const run = await readFinishedRun(started)
  await waitForGroupEnd(started.retest.pid, 5000)
  await waitForGroupEnd(started.browserPid, 10_000)
  assert.equal(profilesIn(started.retest.tmp).length, 1, 'the killed run left its profile')
  return { ...run, tmp: started.retest.tmp }
}

test('report interruption: a run killed mid-test is inspected as incomplete, never as a pass', async (t) => {
  const run = await killMidTest(t)

  assert.deepEqual(run.exit, { code: null, signal: 'SIGKILL' })
  assert.equal(run.result, undefined, 'a killed run leaves no result.json')
  assert.deepEqual(eventsOf(run.events, 'run.finished'), [])
  const inspected = await inspectJson(t, run.output)
  assert.equal(inspected.exit.code, 0)
  assert.deepEqual([inspected.result.complete, inspected.result.status, inspected.result.exitCode], [false, 'error', 2])
  assert.equal(inspected.result.counts.passed, 0)
  assert.equal(inspected.result.files[0]?.tests[0]?.status, 'error')
  assert.deepEqual(inspected.result.failure, { class: 'interrupted', message: 'The run stopped before it finished.' })
  assert.match(inspected.stderr, /result\.json is missing/)
})

test('report interruption: the profile a killed run left is retained when the next run starts', async (t) => {
  const killed = await killMidTest(t)
  const retained = profilesIn(killed.tmp)
  assert.ok(retained.length > 0)
  const app = await openApp(t)
  const next = await runRetest(t, { files: [exampleFile], baseUrl: app.url, tmp: killed.tmp })

  assert.equal(next.exit.code, 0)
  assert.deepEqual(profilesIn(killed.tmp), retained)
})

test('interrupt: SIGINT stops the run, releases the browser, records an interrupted run and exits 130', async (t) => {
  const started = await startMidTest(t)
  started.retest.signal('SIGINT')
  const run = await finishRun(started)

  assert.equal(run.exit.code, 130)
  const result = resultOf(run)
  assert.deepEqual([result.status, result.exitCode, result.complete], ['interrupted', 130, false])
  assert.equal(onlyEvent(run.events, 'run.finished').exitCode, 130)
  const stopped = onlyTest(run)
  assert.deepEqual([stopped.status, stopped.failure?.class], ['error', 'interrupted'])
  assert.match(run.stderr, /Stopping/)
})
