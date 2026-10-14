import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { browserPath } from '../support/test-browser.ts'
import { openApp } from './browser-harness.ts'
import { budgets, configSource, eventsOf, runCli, runProject, testNamed, writeProject } from './cli-harness.ts'

// Drag and drop through a whole run on Chrome: a test file drags a card with HTML drag and drop and a handle with the
// mouse, against the task app's drag page. Each drag is one step, written as the test wrote it in the events, the HTML
// report and `inspect`; a drag onto a covered target fails as the action, naming the cover.

const names = {
  board: 'moves a card to done and sorts the list',
  covered: 'a covered target fails the drag',
} as const

const tests = `import { expect, test } from '@rehearsal-labs/retest'

test(${JSON.stringify(names.board)}, async ({ page }) => {
  await page.goto('/drag')
  await page.getByText('Write release notes').dragTo(page.getByTestId('done-column'))
  await expect(page.getByTestId('board-status')).toHaveText('saved notes in done 201')
  await page.getByTestId('handle').dragTo(page.getByTestId('slot-3'), { steps: 10 })
  await expect(page.getByTestId('order')).toHaveText('alpha in slot-3')
  await expect(page.getByTestId('pointer-moves')).toHaveText('10')
})

test(${JSON.stringify(names.covered)}, async ({ page }) => {
  await page.goto('/drag')
  await page.getByTestId('data-source').dragTo(page.getByTestId('locked-slot'), { timeout: 500 })
})
`

test('a run drags by HTML drag and drop and by the mouse, and its events, report and inspect write each drag as the test did', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chromium({ executablePath: ${JSON.stringify(browserPath())}, baseUrl: ${JSON.stringify(app.url)} }) } }`),
    'tests/drag.retest.ts': tests,
  })
  const run = await runProject(t, root, { timeouts: budgets({ assertion: 2000 }) })
  assert.equal(run.exit.code, 1, run.stderr)

  const board = testNamed(run, names.board)
  assert.equal(board.status, 'passed', JSON.stringify(board.failure))
  const drags = eventsOf(run.events, 'action.completed').filter((event) => event.testId === board.testId && event.command === 'dragTo')
  assert.deepEqual(
    drags.map(({ locator, drag, location }) => ({ locator, drag, line: location?.line })),
    [
      { locator: { by: 'text', text: 'Write release notes' }, drag: { target: { by: 'testId', value: 'done-column' }, through: 'drag-events' }, line: 5 },
      { locator: { by: 'testId', value: 'handle' }, drag: { target: { by: 'testId', value: 'slot-3' }, steps: 10, through: 'mouse' }, line: 7 },
    ],
  )

  const covered = testNamed(run, names.covered)
  assert.deepEqual([covered.status, covered.failure?.class], ['failed', 'not_actionable'])
  assert.equal(
    covered.failure?.message,
    `Could not drag getByTestId('data-source') to getByTestId('locked-slot') within 500 ms: another element, <div class="overlay" data-testid="overlay">, covers the centre of getByTestId('locked-slot').`,
  )
  const failed = eventsOf(run.events, 'action.failed').filter((event) => event.testId === covered.testId)
  assert.deepEqual(failed.map(({ command, drag }) => ({ command, drag })), [{ command: 'dragTo', drag: { target: { by: 'testId', value: 'locked-slot' } } }])

  const report = await runCli(t, ['report', run.output])
  assert.equal(report.exit.code, 0, report.stderr)
  const html = await readFile(join(run.output, 'report.html'), 'utf8')
  assert.ok(html.includes('getByText(&#39;Write release notes&#39;).dragTo(getByTestId(&#39;done-column&#39;))'), 'the report writes the HTML drag as the test wrote it')
  assert.ok(html.includes('through drag events'), 'the report says the drag went through the drag events of the browser')
  assert.ok(html.includes('getByTestId(&#39;handle&#39;).dragTo(getByTestId(&#39;slot-3&#39;), { steps: 10 })'), 'the report writes the steps the test gave')
  assert.ok(html.includes('getByTestId(&#39;data-source&#39;).dragTo(getByTestId(&#39;locked-slot&#39;))'), 'the report writes the failed drag')
  const inspected = await runCli(t, ['inspect', run.output, '--test', `tests/drag.retest.ts > ${names.board}`])
  assert.equal(inspected.exit.code, 0, inspected.stderr)
  assert.match(inspected.stdout, /getByText\('Write release notes'\)\.dragTo\(getByTestId\('done-column'\)\)/)
  assert.match(inspected.stdout, /getByTestId\('handle'\)\.dragTo\(getByTestId\('slot-3'\), \{ steps: 10 \}\)/)
})
