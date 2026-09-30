import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'
import { openApp } from './browser-harness.ts'
import {
  budgets,
  childLog,
  eventsOf,
  exampleFile,
  isRunning,
  onlyEvent,
  onlyTest,
  printedPids,
  resultOf,
  runRetest,
  scenario,
} from './cli-harness.ts'

// Collection is bounded by its budget, then the child has a second to go before it is killed.
const collectionBoundMs = 8000

test('empty selection: a missing file stops before any run starts, exits 2 and names the file', async (t) => {
  const run = await runRetest(t, { files: [scenario('does-not-exist')] })

  assert.equal(run.exit.code, 2)
  assert.match(run.stderr, /fixtures\/tests\/does-not-exist\.retest\.ts does not exist\./)
  assert.equal(run.stdout, '')
  assert.equal(existsSync(run.output), false, 'no run folder was made')
})

test('empty selection: a file with no tests exits 2, opens no browser and says why', async (t) => {
  const run = await runRetest(t, { files: [scenario('no-tests')] })

  assert.equal(run.exit.code, 2)
  const result = resultOf(run)
  assert.deepEqual([result.status, result.complete, result.counts.passed], ['error', false, 0])
  assert.match(onlyEvent(run.events, 'collection.failed').failure.message, /no-tests\.retest\.ts has no tests\./)
  assert.equal(result.failure?.class, 'collection_failed')
  assert.match(result.failure?.message ?? '', /no-tests\.retest\.ts/)
  assert.deepEqual(eventsOf(run.events, 'browser.started'), [])
})

test('collection error: a failed import ends the file unsuccessfully within a bound and exits 2', async (t) => {
  const run = await runRetest(t, { files: [scenario('import-error')] })

  assert.equal(run.exit.code, 2)
  const failed = onlyEvent(run.events, 'collection.failed')
  assert.equal(failed.failure.class, 'collection_failed')
  assert.match(failed.failure.message, /missing-helper\.ts/)
  assert.deepEqual(eventsOf(run.events, 'test.started'), [])
  assert.equal(resultOf(run).files[0]?.collection, 'failed')
  assert.ok(run.durationMs < collectionBoundMs, `took ${run.durationMs} ms`)
})

test('collection hang: an endless loop at the top of a file is stopped by the collection budget and exits 2', async (t) => {
  const file = scenario('top-level-loop')
  const run = await runRetest(t, { files: [file], timeouts: budgets({ collection: 1000 }) })

  assert.equal(run.exit.code, 2)
  const failed = onlyEvent(run.events, 'collection.failed')
  assert.equal(failed.failure.class, 'collection_failed')
  assert.match(failed.failure.message, /took longer than 1000 ms/)
  assert.ok(run.durationMs < collectionBoundMs, `took ${run.durationMs} ms`)
  const [pid] = printedPids(childLog(run, file))
  assert.ok(pid !== undefined, 'the looping file printed its process id')
  assert.equal(isRunning(pid), false, 'the looping process was ended')
})

test('missing browser: an executable that is not there is a setup failure, never a pass, and exits 2', async (t) => {
  const app = await openApp(t)
  const run = await runRetest(t, { files: [exampleFile], baseUrl: app.url, browser: '/nonexistent/chromium' })

  assert.equal(run.exit.code, 2)
  const result = resultOf(run)
  assert.deepEqual([result.status, result.browser, result.counts.passed], ['error', null, 0])
  assert.deepEqual(eventsOf(run.events, 'browser.started'), [])
  const skipped = onlyTest(run)
  assert.equal(skipped.status, 'not_run')
  assert.equal(skipped.failure?.class, 'setup_failed')
  assert.match(skipped.failure?.message ?? '', /No browser at \/nonexistent\/chromium\./)
  assert.equal(app.submissions(), 0)
})

test('missing browser: an executable that is not a browser is a setup failure that names it', async (t) => {
  const app = await openApp(t)
  const run = await runRetest(t, { files: [exampleFile], baseUrl: app.url, browser: process.execPath })

  assert.equal(run.exit.code, 2)
  const skipped = onlyTest(run)
  assert.deepEqual([skipped.status, skipped.failure?.class], ['not_run', 'setup_failed'])
  assert.ok(skipped.failure?.message.includes(`${process.execPath} exited`), skipped.failure?.message)
})
