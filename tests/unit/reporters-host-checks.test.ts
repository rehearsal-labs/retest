import type { RetestEvent } from '../../src/protocol/events.ts'
import type { Failure } from '../../src/protocol/failures.ts'
import type { RunResult } from '../../src/protocol/result.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createAgentReporter } from '../../src/reporters/agent.ts'
import { createHumanReporter } from '../../src/reporters/human.ts'
import { capture, plain } from './reporters-fixtures.ts'
import {
  bodyFailureRun,
  cartUrl,
  checkoutProject,
  hostCheckFailureRun,
  hostCheckResult,
  hostChecksPassRun,
  offThanks,
  placesOrder,
} from './reporters-host-check-fixtures.ts'

const root = checkoutProject()
const runFolder = '.retest/runs/2026-09-30T09-15-00.000Z'
const inspect = `npx retest inspect ${runFolder} --test "tests/checkout.retest.ts > places an order"`
const screenshot = `${runFolder}/artifacts/checkout-places-an-order-web-failure.png`

function human(events: RetestEvent[], options: { color?: boolean; result?: RunResult } = {}): string {
  const stdout = capture()
  const reporter = createHumanReporter({ stdout, stderr: capture(), color: options.color ?? false, runFolder })
  for (const event of events) reporter.onEvent(event)
  reporter.onRunEnd(options.result ?? hostCheckResult(events))
  return stdout.text
}

function agent(events: RetestEvent[], result: RunResult = hostCheckResult(events)): string {
  const stdout = capture()
  const reporter = createAgentReporter({ stdout, runFolder })
  for (const event of events) reporter.onEvent(event)
  reporter.onRunEnd(result)
  return stdout.text
}

function card(report: string): string {
  return report.slice(report.indexOf('  ✗ tests/checkout.retest.ts › places an order'), report.indexOf('  Tests'))
}

// The checks the runner writes, with the test's failure replaced, as a folder read without its events has them.
function withFailure(events: RetestEvent[], change: (event: Extract<RetestEvent, { type: 'test.finished' }>) => RetestEvent): RetestEvent[] {
  return events.map((event) => (event.type === 'test.finished' ? change(event) : event))
}

describe('host checks in the human report', () => {
  test('passing checks are quiet: one summary row, aligned with the others', () => {
    const report = human(hostChecksPassRun(root))
    assert.match(report, /\n {4}✓ places an order {2}900 ms\n\n/)
    assert.doesNotMatch(report, /host check|Host check failed|Not run/)
    assert.match(
      report,
      new RegExp(`\\n {2}Tests {8}1 passed\\n {2}Checks {7}1 passed\\n {2}Host checks {2}3 passed\\n {2}Time {9}1\\.2s\\n {2}Output {7}${runFolder}\\n {2}Exit {9}0\\n\\n$`),
    )
  })

  test('each failed check is a block of its own: which check, on which app, what it expected and what the page showed', () => {
    assert.equal(
      card(human(hostCheckFailureRun(root))),
      [
        '  ✗ tests/checkout.retest.ts › places an order  11s',
        '',
        '    Host check failed  address on web',
        '    Expected         http://127.0.0.1:4173/thanks',
        '    Page             http://127.0.0.1:4173/cart',
        '    Waited           5s, looked 14 times, limit 5s',
        '',
        '    Host check failed  text named "order confirmed" on web',
        '    Expected         "Order placed"',
        '    Page             http://127.0.0.1:4173/cart, text not found',
        '    Waited           5s, looked 14 times, limit 5s',
        '',
        '    tests/checkout.retest.ts:3:1',
        "      1 │ import { expect, test } from '@rehearsal-labs/retest'",
        '      2 │',
        "    › 3 │ test('places an order', async ({ page }) => {",
        "      4 │   await page.goto('/cart')",
        '',
        `    Screenshot       ${screenshot}`,
        `    Inspect          ${inspect}`,
        '',
        '',
      ].join('\n'),
    )
  })

  // The command line gives no host checks, so no command it could print runs a host's test again as it ran.
  test('a run with host checks prints no rerun command, and its card points to inspect', () => {
    const report = human(hostCheckFailureRun(root))
    assert.doesNotMatch(report, /Rerun|retest run/)
    assert.ok(report.includes(`\n    Inspect          ${inspect}\n`), report)
  })

  test('the summary counts the checks, worst first', () => {
    assert.match(human(hostCheckFailureRun(root)), /\n {2}Tests {8}1 failed\n {2}Checks {7}1 passed\n {2}Host checks {2}2 failed · 1 passed\n/)
  })

  test('a body that failed lists every check as not run, after its own failure', () => {
    const shown = card(human(bodyFailureRun(root)))
    assert.match(
      shown,
      /\n {4}Waited {11}5s for toHaveText, looked 3 times, limit 5s\n\n {4}Not run {10}host check address on web: http:\/\/127\.0\.0\.1:4173\/thanks\n {4}Not run {10}host check text named "order confirmed" on web: "Order placed"\n {4}Not run {10}host check text on web: no "Error", any case\n\n {4}tests\/checkout\.retest\.ts:7:3\n/,
    )
    assert.doesNotMatch(shown, /Host check failed/)
    assert.match(human(bodyFailureRun(root)), /\n {2}Host checks {2}3 not run\n/)
  })

  test('a result read without its events still shows the failed checks, with their messages', () => {
    const events = hostCheckFailureRun(root)
    const shown = card(human(events.filter((event) => !('testId' in event)), { result: hostCheckResult(events) }))
    assert.match(
      shown,
      /^ {2}✗ [^\n]+\n\n {4}Host check failed {2}address on web\n {4}The page was at http:\/\/127\.0\.0\.1:4173\/cart, not http:\/\/127\.0\.0\.1:4173\/thanks\.\n {4}Expected {9}http:\/\/127\.0\.0\.1:4173\/thanks\n\n {4}Host check failed {2}text named "order confirmed" on web\n {4}The page did not show "Order placed"\.\n {4}Expected {9}"Order placed"\n\n/,
    )
    assert.doesNotMatch(shown, /Page {13}|Waited/)
  })

  test('also is left out when the blocks show it, and kept when it says more', () => {
    const events = hostCheckFailureRun(root)
    assert.doesNotMatch(human(events), /\n {4}also /)
    const cleanup = 'cleanup_failed: The browser context did not close within 10000 ms.'
    const more = withFailure(events, (event) => {
      const also = `${String(event.failure?.details?.['also'])}\n${cleanup}`
      return { ...event, failure: { ...offThanks, details: { also } } }
    })
    assert.match(human(more), /\n {4}Waited {11}5s, looked 14 times, limit 5s\n {4}also {13}"host_check_failed: The page did not show \\"Order placed\\"\.\\ncleanup_failed: The browser context did not close within 10000 ms\."\n\n {4}Host check failed {2}text/)
  })

  test('the details the runner writes for a failed check are not printed again under its block', () => {
    const events = withFailure(hostCheckFailureRun(root), (event) => {
      const details = { ...event.failure?.details, expected: 'http://127.0.0.1:4173/thanks', received: cartUrl, attempts: 14, timeoutMs: 5000 }
      return { ...event, failure: { ...offThanks, details } }
    })
    const shown = card(human(events))
    assert.doesNotMatch(shown, /\n {4}(expected|received|attempts|timeoutMs) /)
    assert.match(shown, /\n {4}Page {13}http:\/\/127\.0\.0\.1:4173\/cart\n/)
  })

  test('a check that could not read the page keeps its message, since the page it saw says nothing of why', () => {
    const lost: Failure = { class: 'session_lost', message: 'The browser closed while the check read the page.' }
    const events = hostCheckFailureRun(root).map((event): RetestEvent => {
      if (event.type === 'host_check.failed' && event.check.kind === 'address') return { ...event, failure: lost }
      return event.type === 'test.finished' ? { ...event, status: 'error', failure: lost } : event
    })
    assert.match(
      card(human(events)),
      /\n {4}Browser lost {5}address on web\n {4}The browser closed while the check read the page\.\n {4}Expected {9}http:\/\/127\.0\.0\.1:4173\/thanks\n {4}Page {13}http:\/\/127\.0\.0\.1:4173\/cart\n/,
    )
  })

  test('colours only when asked, with the same words', () => {
    const coloured = human(hostCheckFailureRun(root), { color: true })
    assert.ok(coloured.includes('\u001b[31m\u001b[1mHost check failed\u001b[22m\u001b[39m  address on web\n'), coloured)
    assert.equal(plain(coloured), human(hostCheckFailureRun(root)))
  })
})

describe('host checks in the agent report', () => {
  test('one line per failed check, with what it expected and what the page showed, then the next command; passing checks add nothing', () => {
    assert.equal(
      agent(hostCheckFailureRun(root)),
      [
        'retest: 1 failed (1) in 11.3s, exit 1',
        'fail tests/checkout.retest.ts:3 places an order',
        `  host_check_failed address on web expected http://127.0.0.1:4173/thanks, page ${cartUrl}`,
        '  waited 5003ms, looked 14 times, limit 5000ms',
        `  host_check_failed text named "order confirmed" on web expected "Order placed", page ${cartUrl}, text not found`,
        '  waited 5003ms, looked 14 times, limit 5000ms',
        `  screenshot ${screenshot}`,
        `next: npx retest inspect ${runFolder} --test "${placesOrder}" --json`,
        '',
      ].join('\n'),
    )
    assert.equal(agent(hostChecksPassRun(root)), `retest: 1 passed (1) in 1.2s, exit 0\nnext: npx retest inspect ${runFolder} --json\n`)
  })

  test('a body that failed lists each check it kept from running', () => {
    const lines = agent(bodyFailureRun(root)).split('\n')
    assert.deepEqual(lines.slice(5, 9), [
      '  not run host check address on web: http://127.0.0.1:4173/thanks',
      '  not run host check text named "order confirmed" on web: "Order placed"',
      '  not run host check text on web: no "Error", any case',
      `  screenshot ${screenshot}`,
    ])
  })
})

describe('the proxy a browser started with', () => {
  test('the line names the server and the bypass rules', () => {
    assert.match(
      human(hostChecksPassRun(root)),
      /\n {2}started web=chrome {2}Chrome 154\.0\.7195\.41 · proxy http:\/\/127\.0\.0\.1:8080 · bypass <-loopback>, \*\.internal\n/,
    )
  })

  test('never shows a user name or password, even in a server address that carries one', () => {
    const events = hostChecksPassRun(root).map((event) =>
      event.type === 'browser.started' && event.target !== undefined
        ? { ...event, target: { ...event.target, proxy: { server: 'http://ada:hunter22@127.0.0.1:8080' } } }
        : event,
    )
    const report = human(events)
    assert.match(report, /· proxy http:\/\/127\.0\.0\.1:8080\/\n/)
    assert.doesNotMatch(report, /ada|hunter22/)
  })
})
