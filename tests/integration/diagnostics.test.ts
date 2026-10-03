import type { TestContext } from 'node:test'
import type { ConsoleRecord, DiagnosticLine, DiagnosticRecord, DiagnosticsSummary, NetworkRequestRecord, RuntimeErrorRecord } from '../../src/protocol/diagnostics.ts'
import type { TestResult } from '../../src/protocol/result.ts'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { DIAGNOSTICS_WORDS, OPAQUE_TOKEN } from '../../fixtures/task-app/diagnostics-page.ts'
import { parseArtifact } from '../../src/diagnostics/artifact.ts'
import { openApp } from './browser-harness.ts'
import { budgets, configSource, eventsOf, filesHolding, finishRun, resultOf, runCli, runProject, startRun, testNamed, writeProject, type FinishedRun } from './cli-harness.ts'

// Console, runtime error and network capture on real Chrome, through `retest run`, from the task app's diagnostics
// pages: what each record says, how hops correlate, what the declared scope covers and leaves out, how secrets are
// kept out of every file, what a strict or required policy does, and how limits, cancellation and isolation behave.

const mainTest = `import { expect, test } from '@rehearsal-labs/retest'

test('emits every record', async ({ page }) => {
  await page.goto('/diagnostics')
  await expect(page.getByTestId('status')).toHaveText('Done')
  await expect(page).toHaveTitle('Diagnostics')
})
`

async function project(t: TestContext, files: Readonly<Record<string, string>>, diagnostics?: string): Promise<{ root: string; url: string }> {
  const app = await openApp(t)
  const block = diagnostics === undefined ? '' : `, diagnostics: ${diagnostics}`
  const root = await writeProject(t, { 'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) }${block} }`), ...files })
  return { root, url: app.url }
}

/** Every line of a test's artifacts, read and checked against the diagnostics schema. */
function artifactLines(run: FinishedRun, result: TestResult): DiagnosticLine[] {
  return (result.diagnostics ?? []).flatMap((summary) => {
    assert.ok(summary.path !== undefined, `${summary.sessionId} names its artifact`)
    const reading = parseArtifact(readFileSync(join(run.output, summary.path), 'utf8'), summary.path)
    assert.ok(reading.ok, reading.ok ? '' : reading.problem)
    return reading.lines
  })
}

function records(lines: readonly DiagnosticLine[]): DiagnosticRecord[] {
  return lines.filter((line): line is DiagnosticRecord => line.type !== 'capture.started' && line.type !== 'capture.finished')
}

function consoleNamed(lines: readonly DiagnosticLine[], text: string): ConsoleRecord {
  const found = records(lines).find((line): line is ConsoleRecord => line.type === 'console' && line.text.text.includes(text))
  assert.ok(found !== undefined, `a console record says ${JSON.stringify(text)}`)
  return found
}

function requestTo(lines: readonly DiagnosticLine[], path: string): NetworkRequestRecord {
  const found = records(lines).find((line): line is NetworkRequestRecord => line.type === 'network.request' && new URL(line.url.replace(/…/g, '')).pathname === path)
  assert.ok(found !== undefined, `a request went to ${path}`)
  return found
}

function lifecycle(lines: readonly DiagnosticLine[], requestId: string): string[] {
  return records(lines).flatMap((line) => ('requestId' in line && line.type !== 'console' && line.requestId === requestId ? [line.type] : []))
}

function onlySummary(result: TestResult): DiagnosticsSummary {
  assert.equal(result.diagnostics?.length, 1, 'the test has one session')
  const [summary] = result.diagnostics ?? []
  assert.ok(summary !== undefined)
  return summary
}

test('a page with every kind of record leaves one artifact whose records say what happened, and the test passes', async (t) => {
  const { root, url } = await project(t, { 'tests/main.retest.ts': mainTest })
  const run = await runProject(t, root)
  assert.equal(run.exit.code, 0, run.stderr)
  const result = testNamed(run, 'emits every record')
  const summary = onlySummary(result)
  assert.equal(summary.app, 'web')
  assert.equal(summary.sessionId, `${result.attemptId}:web`)
  assert.equal(summary.console.state, 'complete', JSON.stringify(summary.console))
  assert.equal(summary.network.state, 'complete', JSON.stringify(summary.network))
  assert.deepEqual(summary.scope?.console.notCovered, ['out_of_process_frames', 'shared_workers', 'service_workers'])
  assert.deepEqual(summary.scope?.network.notCovered, ['out_of_process_frames', 'dedicated_workers', 'shared_workers', 'service_workers'])
  const lines = artifactLines(run, result)
  const [first] = lines
  const last = lines.at(-1)
  assert.equal(first?.type, 'capture.started')
  assert.equal(last?.type, 'capture.finished')

  // Each console level, as the browser named it, with its own severity, from the main frame.
  for (const [word, consoleType, level] of [
    [DIAGNOSTICS_WORDS.log, 'log', 'info'],
    [DIAGNOSTICS_WORDS.debug, 'debug', 'debug'],
    [DIAGNOSTICS_WORDS.info, 'info', 'info'],
    [DIAGNOSTICS_WORDS.warning, 'warning', 'warning'],
    [DIAGNOSTICS_WORDS.error, 'error', 'error'],
  ] as const) {
    const record = consoleNamed(lines, word)
    assert.deepEqual([record.consoleType, record.level, record.origin, record.frame], [consoleType, level, 'page', 'main'], word)
    assert.equal(record.url, `${url}/diagnostics`)
    assert.ok((record.line ?? 0) >= 1 && (record.column ?? 0) >= 1, 'a line and a column from 1')
  }
  assert.equal(consoleNamed(lines, DIAGNOSTICS_WORDS.log).text.text, `${DIAGNOSTICS_WORDS.log} 42 {saved: true, title: "Release checklist"} [1, 2, 3]`)
  for (const consoleType of ['table', 'count', 'assert', 'trace', 'dir']) {
    assert.ok(records(lines).some((line) => line.type === 'console' && line.consoleType === consoleType), `a ${consoleType} record keeps its type`)
  }
  assert.equal(records(lines).find((line): line is ConsoleRecord => line.type === 'console' && line.consoleType === 'dir')?.text.text, '{danger: (...)}', 'the getter is shown, not called')

  // Frames and workers as the scope says: the frame of the page's own origin and the worker's console are covered,
  // the frame of another site and the worker's own request are not.
  assert.equal(consoleNamed(lines, DIAGNOSTICS_WORDS.frame).frame, 'child')
  assert.equal(consoleNamed(lines, DIAGNOSTICS_WORDS.worker).origin, 'worker')
  assert.equal(consoleNamed(lines, `${DIAGNOSTICS_WORDS.workerFetched} 200`).origin, 'page', 'the worker did fetch')
  assert.equal(records(lines).some((line) => line.type === 'console' && line.text.text.includes(DIAGNOSTICS_WORDS.remoteFrame)), false)
  const dataRequests = records(lines).filter((line): line is NetworkRequestRecord => line.type === 'network.request' && line.url.startsWith(`${url}/diagnostics/data`))
  assert.equal(dataRequests.length, 3, 'the page, its own frame and the redirect fetched data; the worker and the other site are not covered')

  // Two runtime errors, each with its stack, and the token in the script's address gone from the stack.
  const errors = records(lines).filter((line): line is RuntimeErrorRecord => line.type === 'runtime_error')
  const uncaught = errors.find((error) => error.message.text.includes(DIAGNOSTICS_WORDS.uncaught))
  assert.ok(uncaught !== undefined)
  assert.equal(uncaught.kind, 'uncaught')
  assert.equal(uncaught.message.text, `Uncaught Error: ${DIAGNOSTICS_WORDS.uncaught}`)
  assert.equal(uncaught.stack[0]?.function, 'throwFromScript')
  assert.equal(uncaught.stack[0]?.url, `${url}/diagnostics/thrower.js?…`)
  assert.ok(errors.some((error) => error.kind === 'unhandled_rejection' && error.message.text.includes(DIAGNOSTICS_WORDS.rejection)))

  // A 404 and a 500 are responses with their statuses, finished; the closed port is a transport failure with no status.
  for (const [path, status] of [['/diagnostics/missing', 404], ['/diagnostics/broken', 500]] as const) {
    const request = requestTo(lines, path)
    assert.deepEqual(lifecycle(lines, request.requestId), ['network.request', 'network.response', 'network.finished'], path)
    const response = records(lines).find((line) => line.type === 'network.response' && line.requestId === request.requestId)
    assert.equal(response?.type === 'network.response' ? response.status : undefined, status)
  }
  const refused = requestTo(lines, '/diagnostics/refused')
  assert.deepEqual(lifecycle(lines, refused.requestId), ['network.request', 'network.failed'])
  const failure = records(lines).find((line) => line.type === 'network.failed' && line.requestId === refused.requestId)
  assert.equal(failure?.type === 'network.failed' ? failure.reason : undefined, 'net::ERR_CONNECTION_REFUSED')
  assert.equal(failure?.type === 'network.failed' ? failure.canceled : undefined, undefined, 'a refused connection is not a cancellation')

  // The successful fetch measured its duration and kept no query; the opaque token is in no record.
  const data = requestTo(lines, '/diagnostics/data')
  assert.equal(data.url, `${url}/diagnostics/data?…`)
  assert.equal(data.method, 'GET')
  assert.equal(data.resourceType, 'Fetch')
  const finished = records(lines).find((line) => line.type === 'network.finished' && line.requestId === data.requestId)
  assert.ok(finished?.type === 'network.finished' && finished.durationMs !== undefined && finished.durationMs > 0, 'a measured duration')
  assert.equal(filesHolding(run.output, OPAQUE_TOKEN).length, 0, 'no file holds the query token')

  // Two redirect hops, each a request and a response that names the next, ending in the final answer.
  const first302 = requestTo(lines, '/diagnostics/redirect/1')
  const firstResponse = records(lines).find((line) => line.type === 'network.response' && line.requestId === first302.requestId)
  assert.ok(firstResponse?.type === 'network.response')
  assert.equal(firstResponse.status, 302)
  const secondHop = records(lines).find((line): line is NetworkRequestRecord => line.type === 'network.request' && line.requestId === firstResponse.redirectedTo)
  assert.ok(secondHop !== undefined, 'the 302 names the next hop')
  assert.equal(secondHop.redirectedFrom, first302.requestId)
  assert.equal(new URL(secondHop.url).pathname, '/diagnostics/redirect/2')
  const secondResponse = records(lines).find((line) => line.type === 'network.response' && line.requestId === secondHop.requestId)
  assert.ok(secondResponse?.type === 'network.response')
  assert.equal(secondResponse.status, 307)
  const finalHop = records(lines).find((line): line is NetworkRequestRecord => line.type === 'network.request' && line.requestId === secondResponse.redirectedTo)
  assert.ok(finalHop !== undefined)
  assert.deepEqual([finalHop.redirectedFrom, finalHop.url], [secondHop.requestId, `${url}/diagnostics/data?…`])
  assert.deepEqual(lifecycle(lines, finalHop.requestId), ['network.request', 'network.response', 'network.finished'])

  // The request that never finished is marked pending when the attempt ended, with how far it got.
  const hang = requestTo(lines, '/diagnostics/hang')
  const pending = records(lines).find((line) => line.type === 'network.pending' && line.requestId === hang.requestId)
  assert.ok(pending?.type === 'network.pending')
  assert.equal(pending.reason, 'attempt_ended')
  assert.ok(['responded', 'receiving'].includes(pending.lastState), pending.lastState)

  // The worker's own script and the other site's document are handed outside the scope, not left pending.
  for (const [path, lastState] of [['/diagnostics/worker.js', 'requested'], ['/diagnostics/remote-frame', 'responded']] as const) {
    const handed = requestTo(lines, path)
    const mark = records(lines).find((line) => line.type === 'network.pending' && line.requestId === handed.requestId)
    assert.deepEqual(mark?.type === 'network.pending' ? [mark.reason, mark.lastState] : [], ['out_of_scope', lastState], path)
  }

  // Counts in the result agree with the records, and the expected HTTP errors failed nothing.
  assert.ok(summary.network.state === 'complete')
  const pendingUrls = records(lines).flatMap((line) => (line.type === 'network.pending' ? [records(lines).find((request) => request.type === 'network.request' && request.requestId === line.requestId)] : []))
  assert.deepEqual([summary.network.httpErrors, summary.network.transportFailures, summary.network.pending, summary.network.outOfScope], [2, 1, 1, 2], JSON.stringify(pendingUrls))
  assert.ok(summary.console.state === 'complete')
  assert.equal(summary.console.runtimeErrors, 2)
  assert.equal(result.status, 'passed')

  // The events name the artifact; the result rebuilt from them keeps it.
  const finishedEvent = eventsOf(run.events, 'diagnostics.finished')
  assert.deepEqual(finishedEvent.map((event) => event.diagnostics), [summary])
  const startedAt = run.events.findIndex((event) => event.type === 'diagnostics.started')
  assert.equal(eventsOf(run.events, 'diagnostics.started').length, 1)
  const firstNavigation = run.events.findIndex((event) => event.type === 'navigation')
  assert.ok(startedAt !== -1 && startedAt < firstNavigation, 'capture started before the first navigation')
})

test('the reports say how much was captured and where, never what a message said, and inspect shows the records', async (t) => {
  const { root } = await project(t, { 'tests/main.retest.ts': mainTest })
  const human = await runProject(t, root, { reporter: 'human' })
  assert.equal(human.exit.code, 0, human.stderr)
  assert.match(human.stdout, /Diagnostics +2 runtime errors · 2 console errors · 2 HTTP errors · 1 failed request · .*diagnostics\n/)
  for (const word of Object.values(DIAGNOSTICS_WORDS)) assert.equal(human.stdout.includes(word), false, `the human report never prints ${word}`)
  const agent = await runProject(t, root, { reporter: 'agent' })
  assert.match(agent.stdout, /\ndiagnostics: 2 runtime errors, 2 console errors, 2 HTTP errors, 1 failed request; .*diagnostics\n/)
  for (const word of Object.values(DIAGNOSTICS_WORDS)) assert.equal(agent.stdout.includes(word), false, `the agent report never prints ${word}`)

  const run = await runProject(t, root)
  const result = testNamed(run, 'emits every record')
  const shown = await runCli(t, ['inspect', run.output, '--test', result.testId], { cwd: root })
  assert.equal(shown.exit.code, 0, shown.stderr)
  assert.match(shown.stdout, /Diagnostics web +console \d+ entries, 2 errors, 1 warning, 2 runtime errors · network \d+ requests, 2 HTTP errors, 1 failed, 1 pending/)
  assert.match(shown.stdout, /console covers top level document, same process frames, dedicated workers; not out of process frames, shared workers, service workers/)
  assert.match(shown.stdout, new RegExp(`warning c\\d+ warning  ${DIAGNOSTICS_WORDS.warning}`))
  assert.match(shown.stdout, /GET +404 .*\/diagnostics\/missing/)
  assert.match(shown.stdout, /GET +failed .*\/diagnostics\/refused {2}net::ERR_CONNECTION_REFUSED/)
  assert.match(shown.stdout, /GET +302 → n\d+ .*\/diagnostics\/redirect\/1/)
  assert.match(shown.stdout, /\/diagnostics\/hang {2}pending, (responded|receiving), attempt ended/)
  assert.match(shown.stdout, /during goto/, 'a record names the action running when it came')
  const json = await runCli(t, ['inspect', run.output, '--test', result.testId, '--json'], { cwd: root })
  const report: unknown = JSON.parse(json.stdout)
  assert.ok(typeof report === 'object' && report !== null && 'diagnostics' in report && Array.isArray(report.diagnostics))
  assert.equal(report.diagnostics.length, 1)
})

const secretValue = 'correct horse "battery\\ staple'
// Long enough that Chrome cuts it in an object's preview, keeping its start and its end.
const longSecret = `long-${'k7Qm2xWp9Lr4Zt8N'.repeat(8)}-${'end'.repeat(3)}`

/** Every run of ten characters of a value: the parts a cut could leave behind. */
function windows(value: string): string[] {
  return Array.from({ length: value.length - 9 }, (_, index) => value.slice(index, index + 10))
}

const secretsTest = `import { expect, secret, test } from '@rehearsal-labs/retest'

test('leaks a secret everywhere a page can', async ({ page }) => {
  await page.goto('/diagnostics/secrets')
  await page.getByTestId('secret').fill(secret('password'))
  await page.getByTestId('token').fill(secret('token'))
  await page.getByTestId('send').click()
  await expect(page.getByTestId('status')).toHaveText('Sent')
})
`

test('a secret the page puts in messages, errors, queries, paths, headers, cookies and stacks reaches no file', async (t) => {
  const app = await openApp(t)
  const config = configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) }, secrets: { password: env('RETEST_DIAGNOSTICS_SECRET'), token: env('RETEST_DIAGNOSTICS_TOKEN') } }`)
  const secured = await writeProject(t, { 'retest.config.ts': config, 'tests/secrets.retest.ts': secretsTest })
  const env = { RETEST_DIAGNOSTICS_SECRET: secretValue, RETEST_DIAGNOSTICS_TOKEN: longSecret }
  const run = await runProject(t, secured, { env })
  assert.equal(run.exit.code, 0, run.stderr)
  const result = testNamed(run, 'leaks a secret everywhere a page can')
  const lines = artifactLines(run, result)
  assert.deepEqual(filesHolding(run.output, secretValue), [], 'no file in the run folder holds the secret, in any form a URL gives it')
  assert.deepEqual(filesHolding(run.output, JSON.stringify(secretValue).slice(1, -1)), [], 'nor in the form JSON escapes it')
  // Chrome cuts a long value in an object's preview, and a cut of Retest's own would have fallen in a function source;
  // no ten characters of either secret are left anywhere.
  for (const value of [secretValue, longSecret]) {
    const left = windows(value).filter((part) => filesHolding(run.output, part).length > 0)
    assert.deepEqual(left, [], `no part of a ${value.length}-character secret is left`)
  }
  const preview = consoleNamed(lines, 'note:')
  assert.equal(preview.text.text, '{token: (cut), note: (cut), quoted: "{{password}}"}')
  assert.equal(consoleNamed(lines, '() => ').text.text, `() => "${'z'.repeat(63)}{{token}}"`)
  assert.deepEqual(filesHolding(run.output, OPAQUE_TOKEN), [], 'no file holds a query value')
  const text = readFileSync(join(run.output, onlySummary(result).path ?? ''), 'utf8')
  for (const header of ['authorization', 'Bearer', 'x-api-key', 'set-cookie', 'cookie']) assert.equal(text.toLowerCase().includes(header.toLowerCase()), false, `the artifact holds no ${header}`)
  // The page's own words keep their place, with the secret written as its name.
  assert.equal(consoleNamed(lines, 'the secret is').text.text, 'the secret is {{password}}')
  assert.ok(records(lines).some((line) => line.type === 'runtime_error' && line.message.text === 'Uncaught Error: uncaught with {{password}}'))
  assert.ok(records(lines).some((line) => line.type === 'console' && line.consoleType === 'error' && line.text.text.startsWith('Error: failed with {{password}}')))
  const echo = records(lines).find((line): line is NetworkRequestRecord => line.type === 'network.request' && line.url.includes('/diagnostics/echo/'))
  assert.equal(echo?.url, `${app.url}/diagnostics/echo/{{password}}`)
  const thrower = records(lines).find((line): line is RuntimeErrorRecord => line.type === 'runtime_error' && line.message.text.includes(DIAGNOSTICS_WORDS.uncaught))
  assert.equal(thrower?.stack[0]?.url, `${app.url}/diagnostics/thrower.js?…`, 'the stack keeps the script, not its query')
  for (const report of ['human', 'agent'] as const) {
    const shown = await runProject(t, secured, { env, reporter: report })
    assert.equal(shown.stdout.includes(secretValue), false, `the ${report} report never prints the secret`)
  }
})

test('a declared strict policy fails a test that otherwise passed, in the parent, and names what matched', async (t) => {
  const runtime = await project(t, { 'tests/main.retest.ts': mainTest }, "{ strict: { runtimeErrors: true } }")
  const failed = await runProject(t, runtime.root)
  assert.equal(failed.exit.code, 1, failed.stderr)
  const result = testNamed(failed, 'emits every record')
  assert.equal(result.status, 'failed')
  assert.equal(result.failure?.class, 'host_check_failed')
  assert.match(result.failure?.message ?? '', /^The diagnostics policy failed the test: its pages had 2 runtime errors, and the policy allows none\. Records: \S+:web e1, e2 in diagnostics\/\S+\.jsonl\.$/)
  assert.deepEqual(result.failure?.details, { policy: 'diagnostics.strict', matches: 2 })
  assert.equal(result.assertionCount, 2, 'its own checks passed')
  assert.ok(result.evidence.length === 1, 'a failure screenshot was taken')
  const started = eventsOf(failed.events, 'diagnostics.started')[0]
  assert.deepEqual(started?.policy, { strict: { runtimeErrors: true } }, 'the events record the policy that judged the attempt')

  // Only what the allow list leaves counts: the 404 is allowed, the 500 is not.
  const http = await project(t, { 'tests/main.retest.ts': mainTest }, "{ strict: { httpErrors: true, allow: ['/diagnostics/missing'] } }")
  const httpRun = await runProject(t, http.root)
  assert.equal(httpRun.exit.code, 1, httpRun.stderr)
  const httpFailure = testNamed(httpRun, 'emits every record').failure
  const named = /Records: \S+:web (n\d+) in /.exec(httpFailure?.message ?? '')?.[1]
  assert.match(httpFailure?.message ?? '', /1 HTTP error response, and the policy allows none\./)
  const httpLines = artifactLines(httpRun, testNamed(httpRun, 'emits every record'))
  assert.equal(named, requestTo(httpLines, '/diagnostics/broken').requestId, 'the failure names the 500 by its id, not the allowed 404')

  // A policy's failure prints counts and ids in the reports, never a word the page wrote.
  for (const reporter of ['human', 'agent'] as const) {
    const shown = await runProject(t, runtime.root, { reporter })
    for (const word of Object.values(DIAGNOSTICS_WORDS)) assert.equal(shown.stdout.includes(word), false, `the ${reporter} report of a strict failure never prints ${word}`)
    assert.match(shown.stdout, /2 runtime errors, and the policy allows none\. Records: /)
  }

  // With every match allowed, the test passes.
  const allowed = await project(t, { 'tests/main.retest.ts': mainTest }, "{ strict: { runtimeErrors: true, transportFailures: true, allow: ['thrown from the script', 'rejected with nobody', '/diagnostics/refused'] } }")
  const allowedRun = await runProject(t, allowed.root)
  assert.equal(allowedRun.exit.code, 0, allowedRun.stderr)
})

test('a strict policy never replaces the failure a test already had', async (t) => {
  const failing = mainTest.replace("toHaveText('Done')", "toHaveText('Never')").replace("('emits every record'", "('fails its own check'")
  const { root } = await project(t, { 'tests/failing.retest.ts': failing }, "{ strict: { runtimeErrors: true } }")
  const run = await runProject(t, root, { timeouts: budgets({ assertion: 1500 }) })
  assert.equal(run.exit.code, 1, run.stderr)
  const result = testNamed(run, 'fails its own check')
  assert.equal(result.failure?.class, 'check_failed', 'the test keeps its own failure')
  assert.match(String(result.failure?.details?.['also'] ?? ''), /^host_check_failed: The diagnostics policy failed the test/)
})

test('without a policy, expected console errors and HTTP error responses fail nothing', async (t) => {
  const { root } = await project(t, { 'tests/main.retest.ts': mainTest })
  const run = await runProject(t, root)
  assert.equal(run.exit.code, 0, run.stderr)
  assert.equal(resultOf(run).status, 'passed')
})

const floodTest = (count: number, size: number, fetches: number): string => `import { expect, test } from '@rehearsal-labs/retest'

test('floods the console', async ({ page }) => {
  await page.goto('/diagnostics/flood?count=${count}&size=${size}&fetches=${fetches}')
  await expect(page.getByTestId('status')).toHaveText('Done')
})
`

test('records over the limits are dropped and counted, the capture is partial, and a required capture keeps the test from passing', async (t) => {
  const limits = '{ consoleEntries: 10, requests: 5 }'
  const lenient = await project(t, { 'tests/flood.retest.ts': floodTest(50, 20, 30) }, `{ limits: ${limits} }`)
  const passing = await runProject(t, lenient.root)
  assert.equal(passing.exit.code, 0, passing.stderr)
  const kept = testNamed(passing, 'floods the console')
  const summary = onlySummary(kept)
  assert.ok(summary.console.state === 'partial', JSON.stringify(summary.console))
  assert.equal(summary.console.entries, 10)
  assert.ok(summary.console.dropped >= 40, `dropped ${summary.console.dropped}`)
  assert.match(summary.console.reason, /^\d+ messages over the attempt's limits were dropped$/)
  assert.ok(summary.network.state === 'partial', JSON.stringify(summary.network))
  assert.equal(summary.network.requests, 5)
  assert.ok(summary.network.dropped >= 26)
  const lines = artifactLines(passing, kept)
  assert.equal(records(lines).filter((line) => line.type === 'console').length, 10)
  const requestIds = records(lines).filter((line) => line.type === 'network.request').map((line) => ('requestId' in line ? line.requestId : ''))
  assert.equal(requestIds.length, 5)
  for (const requestId of requestIds) assert.notEqual(lifecycle(lines, requestId).at(-1), 'network.request', `${requestId} keeps its later records`)
  assert.equal(lines.at(-1)?.type, 'capture.finished')

  const strict = await project(t, { 'tests/flood.retest.ts': floodTest(50, 20, 30) }, `{ requireComplete: true, limits: ${limits} }`)
  const refused = await runProject(t, strict.root)
  assert.equal(refused.exit.code, 2, refused.stderr)
  const result = testNamed(refused, 'floods the console')
  assert.equal(result.status, 'error')
  assert.equal(result.failure?.class, 'reporting_failed')
  assert.match(result.failure?.message ?? '', /^The diagnostics policy requires complete capture, and it was not complete: \S+:web console was partial: .*; \S+:web network was partial/)
})

test('a strict policy whose console capture overflowed before the error says it could not judge, and never passes', async (t) => {
  const flood = floodTest(30, 20, 0).replace('fetches=0', 'fetches=0&throws=1')
  const { root } = await project(t, { 'tests/flood.retest.ts': flood }, '{ strict: { runtimeErrors: true }, limits: { consoleEntries: 10 } }')
  const run = await runProject(t, root)
  assert.equal(run.exit.code, 2, run.stderr)
  const result = testNamed(run, 'floods the console')
  assert.deepEqual([result.status, result.failure?.class], ['error', 'reporting_failed'])
  assert.match(result.failure?.message ?? '', /^The diagnostics policy could not judge the test: .*:web console was partial: \d+ messages over the attempt's limits were dropped\.$/)
  assert.equal(records(artifactLines(run, result)).some((line) => line.type === 'runtime_error'), false, 'the error itself was dropped at the limit')
})

test('an oversized message is cut, with its length kept, and counted as cut; the byte limit drops what does not fit', async (t) => {
  const { root } = await project(t, { 'tests/flood.retest.ts': floodTest(1, 20_000, 0) })
  const run = await runProject(t, root)
  assert.equal(run.exit.code, 0, run.stderr)
  const result = testNamed(run, 'floods the console')
  const message = records(artifactLines(run, result)).find((line): line is ConsoleRecord => line.type === 'console')
  assert.deepEqual([message?.text.truncated, message?.text.length, message?.text.text.length], [true, 20_000, 4096])
  const summary = onlySummary(result)
  assert.ok(summary.console.state === 'complete' && summary.console.truncated === 1)

  const bytes = await project(t, { 'tests/flood.retest.ts': floodTest(20, 400, 0) }, '{ limits: { consoleBytes: 3000 } }')
  const byteRun = await runProject(t, bytes.root)
  const byteSummary = onlySummary(testNamed(byteRun, 'floods the console'))
  assert.ok(byteSummary.console.state === 'partial' && byteSummary.console.dropped > 0 && byteSummary.console.bytes <= 3000, JSON.stringify(byteSummary.console))
})

const markerTest = (names: readonly string[]): string => `import { expect, test } from '@rehearsal-labs/retest'
${names.map((name) => `
test('marks ${name}', async ({ page }) => {
  await page.goto('/diagnostics/marker/${name}')
  await expect(page.getByTestId('status')).toHaveText('Done')
})
`).join('')}`

function assertOwnMarker(run: FinishedRun, result: TestResult, marker: string): void {
  const lines = artifactLines(run, result)
  const texts = records(lines).flatMap((line) => (line.type === 'console' ? [line.text.text] : []))
  const paths = records(lines).flatMap((line) => (line.type === 'network.request' ? [new URL(line.url).pathname] : []))
  assert.deepEqual(texts, [`marker ${marker}`], `${result.name} holds only its own message`)
  assert.deepEqual(paths, [`/diagnostics/marker/${marker}`, `/diagnostics/marker/${marker}/data`], `${result.name} holds only its own requests`)
  assert.ok(records(lines).every((line) => line.attemptId === result.attemptId && line.sessionId === `${result.attemptId}:web`))
}

test('two files at once in one browser, each test after another in its pool, keep every record with its own attempt', async (t) => {
  const { root } = await project(t, { 'tests/a.retest.ts': markerTest(['alpha', 'bravo', 'charlie']), 'tests/b.retest.ts': markerTest(['delta', 'echo', 'foxtrot']) })
  for (let round = 0; round < 2; round += 1) {
    const run = await runProject(t, root, { args: ['--workers', '2', '--browsers', '1'] })
    assert.equal(run.exit.code, 0, run.stderr)
    assert.equal(eventsOf(run.events, 'browser.started').length, 1, 'one browser served both files')
    for (const marker of ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']) assertOwnMarker(run, testNamed(run, `marks ${marker}`), marker)
  }
})

test('two apps of one test, two contexts at once, each keep their own records in an artifact named with the app', async (t) => {
  const app = await openApp(t)
  const base = JSON.stringify(app.url)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { owner: chrome({ baseUrl: ${base} }), member: chrome({ baseUrl: ${base} }) } }`),
    'tests/two.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'

test('two apps at once', { apps: ['owner', 'member'] }, async ({ owner, member }) => {
  await owner.goto('/diagnostics/marker/alpha')
  await member.goto('/diagnostics/marker/bravo')
  await expect(owner.getByTestId('status')).toHaveText('Done')
  await expect(member.getByTestId('status')).toHaveText('Done')
})
`,
  })
  const run = await runProject(t, root)
  assert.equal(run.exit.code, 0, run.stderr)
  const result = testNamed(run, 'two apps at once')
  assert.deepEqual(result.diagnostics?.map((summary) => [summary.app, summary.sessionId]), [['owner', `${result.attemptId}:owner`], ['member', `${result.attemptId}:member`]])
  for (const [app, marker] of [['owner', 'alpha'], ['member', 'bravo']] as const) {
    const summary = result.diagnostics?.find((entry) => entry.app === app)
    assert.ok(summary?.path?.endsWith('.jsonl') === true && summary.path.includes(`-${app}-`), summary?.path)
    const reading = parseArtifact(readFileSync(join(run.output, summary.path), 'utf8'), summary.path)
    assert.ok(reading.ok)
    const texts = records(reading.lines).flatMap((line) => (line.type === 'console' ? [line.text.text] : []))
    assert.deepEqual(texts, [`marker ${marker}`], `${app} holds only its own page's message`)
    assert.ok(records(reading.lines).every((line) => line.app === app))
  }
})

test('a run stopped while a request hangs keeps what it captured, marks the request interrupted, and exits 130', async (t) => {
  const { root } = await project(t, {
    'tests/pending.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'

test('waits on a request that never ends', async ({ page }) => {
  await page.goto('/diagnostics/pending')
  await expect(page.getByTestId('status')).toHaveText('Never')
})
`,
  })
  const started = await startRun(t, { files: [], cwd: root, browser: false, timeouts: budgets({ assertion: 20_000, test: 30_000 }) })
  await started.retest.waitForEvent('observation')
  started.retest.signal('SIGINT')
  const run = await finishRun(started)
  assert.equal(run.exit.code, 130, run.stderr)
  const result = testNamed(run, 'waits on a request that never ends')
  assert.equal(result.failure?.class, 'interrupted')
  const summary = onlySummary(result)
  assert.equal(summary.console.state, 'complete')
  const lines = artifactLines(run, result)
  assert.equal(consoleNamed(lines, 'waiting for the hanging request').origin, 'page')
  const hang = requestTo(lines, '/diagnostics/hang')
  const pending = records(lines).find((line) => line.type === 'network.pending' && line.requestId === hang.requestId)
  assert.equal(pending?.type === 'network.pending' ? pending.reason : undefined, 'run_interrupted')
  assert.equal(lines.at(-1)?.type, 'capture.finished')
})

test('capture turned off records nothing, writes no artifact, and every result says it was disabled', async (t) => {
  const { root } = await project(t, { 'tests/main.retest.ts': mainTest }, '{ capture: false }')
  const run = await runProject(t, root)
  assert.equal(run.exit.code, 0, run.stderr)
  const summary = onlySummary(testNamed(run, 'emits every record'))
  assert.deepEqual([summary.console, summary.network, summary.path], [{ state: 'disabled' }, { state: 'disabled' }, undefined])
  assert.equal(existsSync(join(run.output, 'diagnostics')), false)
  assert.equal(eventsOf(run.events, 'diagnostics.started').length, 0)
})

test('a page with nothing to say leaves a complete, empty console capture, which reads apart from an unavailable one', async (t) => {
  const { root } = await project(t, {
    'tests/quiet.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'

test('stays quiet', async ({ page }) => {
  await page.goto('/diagnostics/quiet')
  await expect(page.getByTestId('quiet')).toBeVisible()
})
`,
  })
  const run = await runProject(t, root)
  assert.equal(run.exit.code, 0, run.stderr)
  const summary = onlySummary(testNamed(run, 'stays quiet'))
  assert.deepEqual(summary.console, { state: 'complete', entries: 0, errors: 0, warnings: 0, runtimeErrors: 0, handledLater: 0, dropped: 0, truncated: 0, bytes: 0 })
  assert.ok(summary.network.state === 'complete' && summary.network.requests === 1, 'only the document')
  assert.ok(summary.path !== undefined && existsSync(join(run.output, summary.path)), 'an artifact with its markers')
})

test("a response a service worker answered says so, and the worker's own messages are not captured", async (t) => {
  const { root } = await project(t, {
    'tests/worker.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'

test('reads a page the worker answered', async ({ page }) => {
  await page.goto('/diagnostics/worker-scope/register')
  await expect(page.getByTestId('worker')).toHaveText('Ready')
  await page.goto('/diagnostics/worker-scope/page')
  await expect(page.getByTestId('answer')).toHaveText('${DIAGNOSTICS_WORDS.workerPage}')
})
`,
  })
  const run = await runProject(t, root)
  assert.equal(run.exit.code, 0, run.stderr)
  const result = testNamed(run, 'reads a page the worker answered')
  const lines = artifactLines(run, result)
  const document = requestTo(lines, '/diagnostics/worker-scope/page')
  const answered = records(lines).find((line) => line.type === 'network.response' && line.requestId === document.requestId)
  assert.equal(answered?.type === 'network.response' ? answered.serviceWorker : undefined, true)
  const registered = requestTo(lines, '/diagnostics/worker-scope/register')
  const fromServer = records(lines).find((line) => line.type === 'network.response' && line.requestId === registered.requestId)
  assert.equal(fromServer?.type === 'network.response' ? fromServer.serviceWorker : undefined, false)
  assert.equal(consoleNamed(lines, DIAGNOSTICS_WORDS.workerPage).origin, 'page', "the worker's page is the test's page")
  assert.equal(records(lines).some((line) => line.type === 'console' && line.text.text.includes(DIAGNOSTICS_WORDS.serviceWorker)), false, "the worker's own message is not captured")
  assert.deepEqual(onlySummary(result).scope?.console.notCovered.includes('service_workers'), true)
})
