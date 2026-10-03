import type { RetestEvent } from '../../src/protocol/events.ts'
import type { RunResult } from '../../src/protocol/result.ts'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, test } from 'node:test'
import { createAgentReporter } from '../../src/reporters/agent.ts'
import { createHumanReporter } from '../../src/reporters/human.ts'
import { rebuildResult } from '../../src/store/rebuild-result.ts'
import { runProject, tempProject } from '../support/project.ts'
import { eventsOfType, testNamed } from '../support/run-harness.ts'
import { capture, plain } from './reporters-fixtures.ts'

// Runs through the real runner and test file processes, with the fake browser.

const config = `import { chromium, defineConfig } from '@rehearsal-labs/retest'
export default defineConfig({
  apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173', executablePath: '/fake/chromium' }) },
  locks: ['inbox', 'account'],
})
`

// A passing test that opens its page and checks a value, so it needs nothing of the page's contents.
const passes = (name: string): string => `test('${name}', async () => {
  expect(1).toBe(1)
})`

function human(events: readonly RetestEvent[], result: RunResult): string {
  const stdout = capture()
  const reporter = createHumanReporter({ stdout, stderr: capture(), color: false, runFolder: 'run' })
  for (const event of events) reporter.onEvent(event)
  reporter.onRunEnd(result)
  return plain(stdout.text)
}

function agent(events: readonly RetestEvent[], result: RunResult): string {
  const stdout = capture()
  const reporter = createAgentReporter({ stdout, runFolder: 'run' })
  for (const event of events) reporter.onEvent(event)
  reporter.onRunEnd(result)
  return stdout.text
}

describe('a run with skipped tests', () => {
  const skipping = `import { expect, test } from '@rehearsal-labs/retest'
${passes('runs')}
test.skip('waits for a fix', async ({ page }) => {
  await expect(page.getByTestId('never-there')).toBeVisible()
})
test.describe.skip('archive', (test) => {
  ${passes('archives')}
  test.describe('bulk', (test) => {
    ${passes('archives all')}
  })
})
`

  test('a skipped test is its own status, never a pass, and starts nothing', async () => {
    const record = await runProject(tempProject({ 'retest.config.ts': config, 'tests/a.retest.ts': skipping }), { files: ['tests/a.retest.ts'] })
    const { result, events } = record
    assert.equal(result.exitCode, 0)
    assert.equal(result.status, 'passed')
    assert.equal(result.complete, true)
    assert.deepEqual(result.counts, { passed: 1, failed: 0, error: 0, notRun: 0, inconclusive: 0, skipped: 3 })
    const statuses = result.files.flatMap((file) => file.tests).map((each) => [each.name, each.status, each.durationMs, each.assertionCount])
    assert.deepEqual(statuses, [
      ['runs', 'passed', statuses[0]?.[2], 1],
      ['waits for a fix', 'skipped', 0, 0],
      ['archives', 'skipped', 0, 0],
      ['archives all', 'skipped', 0, 0],
    ])
    const skippedIds = new Set(result.files.flatMap((file) => file.tests).filter((each) => each.status === 'skipped').map((each) => each.testId))
    assert.deepEqual(eventsOfType(events, 'test.started').filter((event) => skippedIds.has(event.testId)), [], 'no skipped test started')
    assert.deepEqual(
      eventsOfType(events, 'test.finished').filter((event) => skippedIds.has(event.testId)).map((event) => [event.status, event.failure]),
      [
        ['skipped', undefined],
        ['skipped', undefined],
        ['skipped', undefined],
      ],
    )
    const listed = eventsOfType(events, 'collection.completed')[0]?.tests.map((each) => [each.name, each.skip])
    assert.deepEqual(listed, [
      ['runs', undefined],
      ['waits for a fix', true],
      ['archives', true],
      ['archives all', true],
    ])
    assert.equal(record.browsers.flatMap((browser) => browser.pages).length, 1, 'only the test that ran opened a page')
    assert.deepEqual(rebuildResult(events).counts, result.counts, 'a run folder without its result reads the same counts')

    const report = human(events, result)
    assert.match(report, /○ waits for a fix {2}skipped/)
    assert.match(report, /○ archive › bulk › archives all {2}skipped/)
    assert.match(report, /Tests +1 passed · 3 skipped/)
    assert.match(agent(events, result), /^retest: 1 passed, 3 skipped \(4\) in [^,]+, exit 0\n/)
  })

  test('a run whose every selected test is skipped checked nothing, and exits 2 saying so', async () => {
    const record = await runProject(tempProject({ 'retest.config.ts': config, 'tests/a.retest.ts': skipping }), {
      files: ['tests/a.retest.ts'],
      selection: { grep: 'archive' },
    })
    assert.equal(record.result.exitCode, 2)
    assert.deepEqual(record.result.failure, { class: 'usage', message: 'Every selected test is skipped, so no test ran.' })
    assert.deepEqual(record.result.counts, { passed: 0, failed: 0, error: 0, notRun: 0, inconclusive: 0, skipped: 2 })
    assert.equal(record.browsers.length, 0, 'no browser started for skipped tests')
  })
})

describe('a run with test.only', () => {
  const files = {
    'retest.config.ts': config,
    'tests/a.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'
test.only('focused', async () => {
  expect(1).toBe(1)
})
${passes('left out')}
`,
    'tests/b.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'
${passes('also left out')}
test.describe.only('block', (test) => {
  ${passes('inside the block')}
})
`,
  }

  test('keeps only the marked tests in every file, and the events, result and reports say the run was narrowed', async () => {
    const record = await runProject(tempProject(files), { files: ['tests/a.retest.ts', 'tests/b.retest.ts'] })
    const { result, events } = record
    assert.equal(result.exitCode, 0, JSON.stringify(result.failure))
    assert.deepEqual(result.files.flatMap((file) => file.tests).map((each) => [each.name, each.status]), [
      ['focused', 'passed'],
      ['inside the block', 'passed'],
    ])
    // A declaration's column is where its call's last name starts, as for every test and block.
    const narrowed = { only: [{ file: 'tests/a.retest.ts', line: 2, column: 6 }, { file: 'tests/b.retest.ts', line: 5, column: 15 }], kept: 2, collected: 4 }
    assert.deepEqual(result.narrowed, narrowed)
    const [event] = eventsOfType(events, 'run.narrowed')
    assert.deepEqual(event === undefined ? undefined : { only: event.only, kept: event.kept, collected: event.collected }, narrowed)
    assert.deepEqual(rebuildResult(events).narrowed, narrowed, 'a run folder without its result still says it was narrowed')
    const warning = 'test.only at tests/a.retest.ts:2 and tests/b.retest.ts:5 keeps 2 of 4 tests, so the run checks less than the suite.'
    const report = human(events, result)
    assert.ok(report.includes(`! ${warning}`), report)
    assert.match(report, /Exit +0 · narrowed by test\.only/)
    const short = agent(events, result)
    assert.match(short, /^retest: 2 passed \(2\) in [^,]+, exit 0, narrowed by test\.only\nwarning: test\.only at /)
    assert.ok(short.includes(`warning: ${warning}\n`))
  })

  test('a run that forbids it fails before any test runs, naming each place, and starts no browser', async () => {
    const record = await runProject(tempProject(files), {
      files: ['tests/a.retest.ts', 'tests/b.retest.ts'],
      forbidOnly: 'CI is set: remove test.only, or pass --allow-only to run it anyway.',
    })
    const { result, events } = record
    assert.equal(result.exitCode, 2)
    assert.equal(result.failure?.class, 'usage')
    assert.equal(
      result.failure?.message,
      'test.only leaves out the rest of the suite, and this run refuses it: tests/a.retest.ts:2, tests/b.retest.ts:5. CI is set: remove test.only, or pass --allow-only to run it anyway.',
    )
    assert.equal(result.narrowed, undefined)
    assert.deepEqual(eventsOfType(events, 'test.started'), [])
    assert.deepEqual(eventsOfType(events, 'run.narrowed'), [])
    assert.equal(record.browsers.length, 0)
    assert.equal(result.counts.passed + result.counts.failed, 0)
  })

  test('without only in the files, a run that forbids it runs as usual', async () => {
    const record = await runProject(tempProject({ 'retest.config.ts': config, 'tests/a.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'\n${passes('plain')}\n` }), {
      files: ['tests/a.retest.ts'],
      forbidOnly: 'CI is set.',
    })
    assert.equal(record.result.exitCode, 0)
  })
})

describe('locks in a run', () => {
  // The tests signal through files in the project, so each wait is decided by the order of events, not by timing: a
  // holder keeps its lock until the unit test releases it, and a waiter asks only once the holder holds.
  const signals = `import { existsSync, writeFileSync } from 'node:fs'
const signal = (name) => new URL(\`../signals/\${name}\`, import.meta.url)
const raise = (name) => writeFileSync(signal(name), '')
const waitFor = async (name) => {
  while (!existsSync(signal(name))) await new Promise((resolve) => setTimeout(resolve, 20))
}
`
  const testFile = (body: string): string => `import { expect, test } from '@rehearsal-labs/retest'\n${signals}\n${body}\n`

  async function waitForFile(path: string): Promise<void> {
    const end = performance.now() + 20_000
    while (!existsSync(path)) {
      assert.ok(performance.now() < end, `${path} appeared`)
      await sleep(20)
    }
  }

  test('two tests that hold one lock never run at the same time across workers, and the waiter records its wait', async () => {
    const files = {
      'retest.config.ts': config,
      'signals/.keep': '',
      'tests/a.retest.ts': testFile(`test('first holder', { locks: ['inbox'], timeout: 20000 }, async () => {
  raise('held')
  await waitFor('release')
  expect(1).toBe(1)
})`),
      'tests/b.retest.ts': testFile(`test('waits until the inbox is held', { timeout: 20000 }, async () => {
  await waitFor('held')
  expect(1).toBe(1)
})
test('second holder', { locks: ['inbox'] }, async () => {
  expect(1).toBe(1)
})`),
      'tests/c.retest.ts': testFile(`test('other lock', { locks: ['account'], timeout: 20000 }, async () => {
  await waitFor('held')
  raise('other-done')
  expect(1).toBe(1)
})`),
    }
    const root = tempProject(files)
    const running = runProject(root, { files: ['tests/a.retest.ts', 'tests/b.retest.ts', 'tests/c.retest.ts'], workers: 3 })
    await waitForFile(join(root, 'signals/other-done'))
    // The second holder asks for the inbox soon after it is held; the first holds it a good while longer.
    await sleep(1200)
    writeFileSync(join(root, 'signals/release'), '')
    const { result, events } = await running
    assert.equal(result.exitCode, 0, JSON.stringify(result.failure))
    const acquired = eventsOfType(events, 'lock.acquired')
    assert.deepEqual(acquired.map((event) => event.locks).sort(), [['account'], ['inbox'], ['inbox']])
    const held = (name: string): { from: number; to: number; waitedMs: number; heldBy: string[] | undefined } => {
      const testId = testNamed(result, name).testId
      const lock = acquired.find((event) => event.testId === testId)
      const finished = eventsOfType(events, 'test.finished').find((event) => event.testId === testId)
      assert.ok(lock !== undefined && finished !== undefined)
      return { from: lock.elapsedMs, to: finished.elapsedMs, waitedMs: lock.waitedMs, heldBy: lock.heldBy }
    }
    const first = held('first holder')
    const second = held('second holder')
    assert.ok(second.from >= first.to, `the second holder took the inbox at ${second.from} ms, after the first ended at ${first.to} ms`)
    assert.ok(second.waitedMs > 0, `the second holder waited ${second.waitedMs} ms`)
    assert.deepEqual(second.heldBy, [testNamed(result, 'first holder').testId])
    const other = held('other lock')
    assert.ok(other.to < first.to, 'a test that holds another lock ran and ended while the first held the inbox')
    const report = human(events, result)
    assert.match(report, /second holder {2}(\d+ ms|[\d.]+s)\n {6}holds lock inbox, after waiting (\d+ ms|[\d.]+s)\n/, 'the human report shows the wait under the test')
    assert.match(report, /first holder {2}(\d+ ms|[\d.]+s)\n {6}holds lock inbox\n/, 'a test that did not wait shows only the lock it held')
  })

  test('a test is not charged for the time it waits for a lock', async () => {
    const budgetMs = 500
    const files = {
      'retest.config.ts': config,
      'signals/.keep': '',
      'tests/a.retest.ts': testFile(`test('long holder', { locks: ['inbox'], timeout: 20000 }, async () => {
  raise('held')
  await waitFor('release')
  expect(1).toBe(1)
})`),
      'tests/b.retest.ts': testFile(`test('waits until the inbox is held', { timeout: 20000 }, async () => {
  await waitFor('held')
  expect(1).toBe(1)
})
test('short budget', { locks: ['inbox'], timeout: ${budgetMs} }, async () => {
  expect(1).toBe(1)
})`),
    }
    const root = tempProject(files)
    const running = runProject(root, { files: ['tests/a.retest.ts', 'tests/b.retest.ts'], workers: 2 })
    await waitForFile(join(root, 'signals/held'))
    // More than three times the waiter's budget, so its wait is far past its budget however the machine is loaded.
    await sleep(budgetMs * 3 + 600)
    writeFileSync(join(root, 'signals/release'), '')
    const record = await running
    assert.equal(record.result.exitCode, 0, JSON.stringify(record.result.failure))
    const short = testNamed(record.result, 'short budget')
    assert.equal(short.status, 'passed')
    const wait = eventsOfType(record.events, 'lock.acquired').find((event) => event.testId === short.testId)
    assert.ok(wait !== undefined && wait.waitedMs > budgetMs, `the test waited ${wait?.waitedMs} ms, longer than its ${budgetMs} ms budget, and passed`)
    assert.ok(short.durationMs < budgetMs, `its own time was ${short.durationMs} ms`)
  })
})

describe('per-call timeouts in a run', () => {
  test('a call that shortens its action budget fails within it, and its event records the time it set', async () => {
    const files = {
      'retest.config.ts': config,
      'tests/a.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'
test('gives up early', async ({ page }) => {
  await page.getByTestId('missing').click({ timeout: 150 })
})
test('keeps the budget', async ({ page }) => {
  await page.getByTestId('save-task').click({ timeout: 60000 })
  await expect(page.getByTestId('save-task')).toBeVisible()
})
`,
    }
    const record = await runProject(tempProject(files), { files: ['tests/a.retest.ts'], timeouts: { action: 500 } })
    const early = testNamed(record.result, 'gives up early')
    assert.equal(early.status, 'failed')
    assert.equal(early.failure?.class, 'not_found')
    assert.equal(early.failure?.message, "getByTestId('missing') matched no element in 150 ms.")
    const failed = eventsOfType(record.events, 'action.failed')
    assert.deepEqual(failed.map((event) => [event.command, event.timeoutMs]), [['click', 150]])
    const completed = eventsOfType(record.events, 'action.completed').filter((event) => event.testId === testNamed(record.result, 'keeps the budget').testId)
    assert.deepEqual(completed.map((event) => [event.command, event.timeoutMs]), [['click', 500]], 'a longer timeout is cut to the action budget')
    assert.match(human(record.events, record.result), /Waited +[\d.]+ (ms|s) for click, limit 150 ms set by the call/)
  })
})
