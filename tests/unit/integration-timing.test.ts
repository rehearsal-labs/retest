import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { defaultTimeouts, type Timeouts } from '../../src/protocol/timeouts.ts'

// An integration test that waits for an amount of time, or gives a step less time than a user gets, passes on a quick
// machine and fails on a slow one. This reads the integration sources, harnesses and the test files they write
// included, for three things it can name exactly: a real sleep (`delay(`, `sleep(`, `setTimeout(resolve`), a
// `budgets({ ... })` override below the default, and a `timeout:` or `timeoutMs:` below 5 seconds, the shortest budget
// a step gets by default. A line that says why, in a comment of its own after the code, is allowed. A budget passed as a
// bare number to a helper is not read: which argument is a budget cannot be told from the text.
//
// The files below had such lines without a reason when this check was written. Each count may only go down: a file
// that has fewer now must have its count lowered here, and one that has none is removed.

const known: Readonly<Record<string, number>> = {
  'agent-capacity.test.ts': 5,
  'agent-harness.ts': 1,
  'agent-identity.test.ts': 4,
  'agent-sessions.test.ts': 8,
  'browser-actions.test.ts': 2,
  'browser-dialogs.test.ts': 4,
  'browser-drag.test.ts': 6,
  'browser-files.test.ts': 5,
  'browser-harness.ts': 3,
  'browser-locators.test.ts': 1,
  'browser-navigation.test.ts': 2,
  'browser-popups.test.ts': 2,
  'browser-read-page.test.ts': 1,
  'browser-routes.test.ts': 1,
  'browser-screenshots.test.ts': 1,
  'browser-secrets.test.ts': 2,
  'browser-state.test.ts': 2,
  'capture-browser-proof.ts': 7,
  'capture-chromium.test.ts': 4,
  'capture-ios.test.ts': 5,
  'capture-macos.test.ts': 2,
  'cdp.test.ts': 1,
  'checks-on-leaving-page.test.ts': 1,
  'cli-commands.test.ts': 2,
  'cli-harness.ts': 3,
  'command-lanes.test.ts': 3,
  'cross-platform-service.test.ts': 6,
  'diagnostics-collector.test.ts': 4,
  'diagnostics-engines.test.ts': 4,
  'diagnostics.test.ts': 2,
  'dialogs.test.ts': 2,
  'drag.test.ts': 2,
  'electron-downloads.test.ts': 2,
  'electron-popups.test.ts': 3,
  'electron-web-flow.test.ts': 2,
  'electron.test.ts': 3,
  'evaluation-frames.test.ts': 9,
  'evaluation-handovers.test.ts': 2,
  'evaluation.test.ts': 1,
  'evidence-browsers.test.ts': 3,
  'evidence-diagnostics.test.ts': 4,
  'evidence-failures.test.ts': 5,
  'evidence-flows.test.ts': 3,
  'evidence-native.test.ts': 1,
  'evidence-pixel-artifacts.test.ts': 4,
  'evidence-queue.test.ts': 4,
  'files.test.ts': 4,
  'firefox-diagnostics.test.ts': 2,
  'firefox-driver.test.ts': 5,
  'firefox-files.test.ts': 4,
  'firefox-popups.test.ts': 4,
  'firefox-run-files.test.ts': 1,
  'frames.test.ts': 3,
  'layout-matchers.test.ts': 1,
  'm2-apps.test.ts': 1,
  'm2-doctor.test.ts': 1,
  'm2-emulation.test.ts': 1,
  'm2-guarantees.test.ts': 6,
  'm2-hooks.test.ts': 1,
  'm2-locators.test.ts': 1,
  'm2-matchers.test.ts': 2,
  'm2-secrets.test.ts': 2,
  'm2-servers.test.ts': 1,
  'm2-state.test.ts': 1,
  'm3-host-checks.test.ts': 4,
  'm3-observations.test.ts': 1,
  'm3-press.test.ts': 2,
  'matrix-lifecycle.test.ts': 3,
  'matrix-outcomes.test.ts': 2,
  'matrix-reporting.test.ts': 1,
  'matrix-selection.test.ts': 1,
  'matrix-targets.test.ts': 1,
  'native-capture-deadline-fixture.ts': 4,
  'native-diagnostics-wired.test.ts': 1,
  'native-diagnostics.test.ts': 2,
  'native-evaluation.test.ts': 1,
  'native-harness.ts': 1,
  'native-interaction.test.ts': 6,
  'native-ios-lifecycle.test.ts': 3,
  'native-macos-lifecycle.test.ts': 2,
  'participants-identity.test.ts': 1,
  'participants-preparation.test.ts': 1,
  'participants-session-limits.test.ts': 2,
  'playwright-compat.test.ts': 1,
  'popups.test.ts': 4,
  'record-identity.test.ts': 1,
  'recording-pixels.test.ts': 1,
  'reference-flow-engines.test.ts': 1,
  'reference-flow.test.ts': 1,
  'report-html.test.ts': 2,
  'routes.test.ts': 2,
  'run-interrupt.test.ts': 2,
  'screenshots.test.ts': 4,
  'service-teardown.ts': 2,
  'test-controls.test.ts': 4,
  'webkit-driver.test.ts': 7,
  'webkit-files.test.ts': 8,
  'webkit-popups.test.ts': 4,
  'windows-processes.test.ts': 10,
}

const folder = fileURLToPath(new URL('../integration/', import.meta.url))

const sleep = /\bdelay\(|\bsleep\(|setTimeout\(\s*resolve\b|setTimeout\(\s*\(\)\s*=>\s*resolve\(/
const budgetsCall = /budgets\(\{([^}]*)\}\)/g
const budgetPair = /(\w+):\s*([\d_]+)\b/g
const stepTimeout = /\b(?:timeout|timeoutMs):\s*([\d_]+)\b/g
// A comment after the code on the same line, not the `//` of an address.
const reason = /\S\s+\/\/\s/

const shortestStepMs = defaultTimeouts.assertion

function isBudget(name: string): name is keyof Timeouts {
  return Object.hasOwn(defaultTimeouts, name)
}

function milliseconds(text: string): number {
  return Number(text.replaceAll('_', ''))
}

/** Why a line is held to the rule, or undefined for a line that is not. */
function timing(line: string): string | undefined {
  if (sleep.test(line)) return 'a real sleep'
  for (const call of line.matchAll(budgetsCall)) {
    for (const [, name = '', value = ''] of (call[1] ?? '').matchAll(budgetPair)) {
      if (isBudget(name) && milliseconds(value) < defaultTimeouts[name]) return `${name} below its default of ${defaultTimeouts[name]} ms`
    }
  }
  for (const [, value = ''] of line.matchAll(stepTimeout)) {
    if (milliseconds(value) < shortestStepMs) return `a step budget below ${shortestStepMs} ms`
  }
  return undefined
}

/** Each integration source's lines held to the rule that give no reason, by file name. */
function unexplained(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const name of readdirSync(folder).filter((each) => each.endsWith('.ts')).sort()) {
    const lines = readFileSync(join(folder, name), 'utf8').split('\n')
    const held = lines.flatMap((line, index) => {
      const what = timing(line)
      return what === undefined || reason.test(line) ? [] : [`line ${index + 1}: ${what}`]
    })
    if (held.length > 0) found.set(name, held)
  }
  return found
}

test('an integration test adds no real sleep and no budget below the default without a reason on its line', () => {
  const found = unexplained()
  const problems: string[] = []
  for (const [name, lines] of found) {
    const allowed = known[name] ?? 0
    if (lines.length > allowed) problems.push(`${name} has ${lines.length} of these lines, and ${allowed} are known: ${lines.join('; ')}`)
    if (lines.length < allowed) problems.push(`${name} has ${lines.length} of these lines now, fewer than the ${allowed} known: lower its count here`)
  }
  for (const name of Object.keys(known)) {
    if (!found.has(name)) problems.push(`${name} has none of these lines now: remove it from the known list`)
  }
  assert.deepEqual(problems, [])
})

test('the rule names a real sleep, a short budgets() override and a short step budget, and lets a line with its reason pass', () => {
  assert.equal(timing('  await delay(200)'), 'a real sleep')
  assert.equal(timing("  while (busy()) await new Promise((resolve) => setTimeout(resolve, 20))"), 'a real sleep')
  assert.equal(timing('  const run = await runProject(t, root, { timeouts: budgets({ assertion: 1500 }) })'), 'assertion below its default of 5000 ms')
  assert.equal(timing("  await page.getByTestId('x').click({ timeout: 300 })"), 'a step budget below 5000 ms')
  assert.equal(timing('  const run = await runProject(t, root, { timeouts: budgets({ assertion: 25_000 }) })'), undefined)
  assert.equal(timing("  await page.goto('http://127.0.0.1:4000/')"), undefined)
  assert.ok(reason.test("  await page.getByTestId('x').click({ timeout: 300 }) // the click is meant to run out of time"))
  assert.ok(!reason.test("  await page.goto('http://127.0.0.1:4000/')"))
})
