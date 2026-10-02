import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { resultFile, eventsFile } from '../../src/protocol/run-folder.ts'
import { browserPath, openApp } from './browser-harness.ts'
import { onlyEvent, readEvents, readResult, runCli, scratchFolder, writeFiles } from './cli-harness.ts'

const spec = `import { test, expect, type Page } from '@playwright/test'
import { title } from './helper'

async function save(page: Page, text: string): Promise<void> {
  await page.getByTestId('task-title').fill(text)
  await page.getByTestId('save-task').click()
}

test.describe('tasks', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('saves a task', async ({ page }) => {
    await save(page, title)
    await expect(page.getByTestId('saved-task')).toHaveText(title)
  })

  test('uses a member Retest does not have yet', async ({ page }) => {
    await page.getByPlaceholder('Title').fill('x')
  })
})
`

// The folder holds no node_modules at all: neither Playwright nor Retest is installed there, and the file names
// Playwright alone.
test('a Playwright test file runs unchanged from a bare folder, and what Retest does not have yet fails by name', async (t) => {
  const app = await openApp(t)
  const root = await scratchFolder(t, 'retest-playwright-')
  await writeFiles(root, {
    'tests/tasks.spec.ts': spec,
    'tests/helper.ts': "export const title = 'Release checklist'\n",
    'tests/unit.test.ts': "throw new Error('a .test file is not taken unless it is named')\n",
  })
  const output = join(await scratchFolder(t), 'run')
  const run = await runCli(t, ['run', '--playwright', '--browser', browserPath(), '--base-url', app.url, '--no-agent', '--output', output], { cwd: root })
  assert.equal(run.exit.code, 2, `${run.stdout}\n${run.stderr}`)
  assert.match(run.stdout, /retest \S+, playwright compatibility/)

  const events = readEvents(readFileSync(join(output, eventsFile), 'utf8'))
  const started = onlyEvent(events, 'run.started')
  assert.equal(started.options.playwright, true)
  assert.deepEqual(started.files, ['tests/tasks.spec.ts'])

  const result = readResult(readFileSync(join(output, resultFile), 'utf8'))
  const tests = result.files.flatMap((file) => file.tests)
  assert.deepEqual(tests.map((each) => [each.name, each.status]), [
    ['saves a task', 'passed'],
    ['uses a member Retest does not have yet', 'error'],
  ])
  const [, unsupported] = tests
  assert.equal(unsupported?.failure?.class, 'unsupported')
  assert.equal(unsupported?.failure?.message, "page.getByPlaceholder is not supported yet by Retest's Playwright compatibility.")
  const line = spec.split('\n').findIndex((text) => text.includes('getByPlaceholder')) + 1
  assert.deepEqual([unsupported?.failure?.location?.file, unsupported?.failure?.location?.line], ['tests/tasks.spec.ts', line])
  assert.equal(app.submissions(), 1, 'the passing test saved once, and the refused one sent nothing')
})

test('without --playwright, a file that is not a Retest test file is refused before anything starts', async (t) => {
  const root = await scratchFolder(t, 'retest-playwright-')
  await writeFiles(root, { 'tests/tasks.spec.ts': spec })
  const run = await runCli(t, ['run', 'tests/tasks.spec.ts', '--browser', browserPath()], { cwd: root })
  assert.equal(run.exit.code, 2)
  assert.match(run.stderr, /tests\/tasks\.spec\.ts is not a test file\. Test files end in \.retest\.ts\./)
})
