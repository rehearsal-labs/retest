import type { EventBody, RetestEvent } from '../../src/protocol/events.ts'
import type { Failure, SourceLocation } from '../../src/protocol/failures.ts'
import type { RunResult } from '../../src/protocol/result.ts'
import type { Variant } from '../../src/protocol/variant.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { emulationFor } from '../../src/config/devices.ts'
import { truncateText } from '../../src/protocol/failures.ts'
import { testId } from '../../src/protocol/run-folder.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { variantKey } from '../../src/protocol/variant.ts'
import { rebuildResult } from '../../src/store/rebuild-result.ts'
import { resultOf, stamp, temporaryFolder } from './reporters-fixtures.ts'

// A run from a config: one app, web, on two targets, chromium and an emulated Pixel 9. A setup signs in on each, and
// the test that needs its state fails on the Pixel only.

export const tasksFile = 'tests/tasks.retest.ts'
export const baseUrl = 'http://127.0.0.1:4173'
export const pageUrl = 'http://127.0.0.1:4173/'

export const tasksSource = `import { expect, test } from '@rehearsal-labs/retest'

test.setup('signs in', async ({ page }) => {
  await page.goto('/sign-in')
})

test.describe('tasks', () => {
  test('saves a task', { tags: ['smoke'], state: 'signed-in' }, async ({ page }) => {
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
  })
})
`

export const signsIn: string = testId(tasksFile, 'signs in')
export const savesTask: string = testId(tasksFile, 'tasks > saves a task')
export const chromiumTarget: Variant = { web: 'chromium' }
export const pixelTarget: Variant = { web: 'pixel' }

const at = (line: number, column = 3): SourceLocation => ({ file: tasksFile, line, column })
const saveButton = { by: 'role', role: 'button', name: 'Save' } as const
const savedTask = { by: 'testId', value: 'saved-task' } as const

const configSource = `import { app, chromium, defineConfig } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: { web: app({ baseUrl: '${baseUrl}', targets: { chromium: chromium(), pixel: chromium({ emulate: 'Pixel 9' }) } }) },
})
`

/** A folder with the test file and the config the run read in it, to be the run's root directory. */
export function variantProject(configFile = 'retest.config.ts'): string {
  const root = temporaryFolder()
  mkdirSync(join(root, 'tests'))
  writeFileSync(join(root, tasksFile), tasksSource)
  mkdirSync(dirname(join(root, configFile)), { recursive: true })
  writeFileSync(join(root, configFile), configSource)
  return root
}

function scope(test: string, attempt: string, variant: Variant) {
  return { testId: test, attemptId: attempt, variant, variantKey: variantKey(variant) }
}

function browserStarted(target: string, emulated: boolean): EventBody {
  const emulation = emulated ? { emulation: emulationFor('Pixel 9', '154.0.7195.41'), device: 'Pixel 9' } : {}
  return {
    type: 'browser.started',
    product: 'Chrome',
    version: '154.0.7195.41',
    userAgent: 'Mozilla/5.0 Chrome/154.0.7195.41',
    pid: 4242,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    app: 'web',
    target: { name: target, ...emulation },
  }
}

function signIn(variant: Variant, attempt: string): EventBody[] {
  const ids = scope(signsIn, attempt, variant)
  return [
    { type: 'test.started', ...ids, name: 'signs in', file: tasksFile, location: at(3, 6), setup: true },
    { type: 'action.completed', ...ids, session: 'web', command: 'goto', pageUrl, durationMs: 20, location: at(4, 14) },
    { type: 'state.saved', ...ids, state: 'signed-in', app: 'web', target: variant['web'] ?? '' },
    { type: 'test.finished', ...ids, status: 'passed', durationMs: 300, assertionCount: 0 },
  ]
}

function saveTask(variant: Variant, attempt: string, failed: boolean): EventBody[] {
  const ids = scope(savesTask, attempt, variant)
  const started: EventBody[] = [
    { type: 'test.started', ...ids, name: 'saves a task', file: tasksFile, location: at(8, 3), describePath: ['tasks'] },
    { type: 'state.restored', ...ids, state: 'signed-in', app: 'web', target: variant['web'] ?? '' },
    { type: 'action.completed', ...ids, session: 'web', command: 'click', locator: saveButton, pageUrl, durationMs: 9, location: at(9, 5) },
  ]
  const checked = { matcher: 'toHaveText', locator: savedTask, attempts: failed ? 14 : 1, timeoutMs: 5000, pageUrl, location: at(10, 5) }
  if (!failed) {
    return [
      ...started,
      { type: 'assertion.passed', ...ids, ...checked, expected: truncateText('Release checklist'), actual: truncateText('Release checklist'), durationMs: 4 },
      { type: 'test.finished', ...ids, status: 'passed', durationMs: 800, assertionCount: 1 },
    ]
  }
  const failure: Failure = { class: 'check_failed', message: 'Expected the text "Release checklist", received "Saving…".', location: at(10, 5) }
  return [
    ...started,
    { type: 'assertion.failed', ...ids, ...checked, expected: truncateText('Release checklist'), actual: truncateText('Saving…'), durationMs: 5003, failure },
    { type: 'evidence.captured', ...ids, session: 'web', kind: 'screenshot', path: 'artifacts/tasks-saves-a-task-web-failure.png', reason: 'failure' },
    { type: 'test.finished', ...ids, status: 'failed', durationMs: 5600, assertionCount: 1, failure },
  ]
}

/** The start of a run from a config, at `config` relative to the root. */
export function runStarted(rootDir: string, options: VariantRunOptions = {}): Extract<EventBody, { type: 'run.started' }> {
  return {
    type: 'run.started',
    retestVersion: '0.0.0',
    node: 'v24.12.0',
    platform: 'darwin',
    rootDir,
    files: [tasksFile],
    options: { config: options.config ?? 'retest.config.ts', ...(options.baseUrls === undefined ? {} : { baseUrls: options.baseUrls }), timeouts: defaultTimeouts, reporter: 'human' },
  }
}

const collected: EventBody = {
  type: 'collection.completed',
  file: tasksFile,
  tests: [
    { testId: signsIn, name: 'signs in', location: at(3, 6), apps: ['web'], setup: true, variants: [chromiumTarget, pixelTarget] },
    {
      testId: savesTask,
      name: 'saves a task',
      location: at(8, 3),
      describePath: ['tasks'],
      tags: ['smoke'],
      apps: ['web'],
      variants: [chromiumTarget, pixelTarget],
    },
  ],
}

export type VariantRunOptions = { config?: string; baseUrls?: Record<string, string> }

/** The app server starts, both setups pass, and the test fails on the emulated Pixel only. */
export function variantRun(rootDir: string, options: VariantRunOptions = {}): RetestEvent[] {
  return stamp([
    runStarted(rootDir, options),
    { type: 'app.started', app: 'web', ready: baseUrl, pid: 5151, durationMs: 2100 },
    collected,
    browserStarted('chromium', false),
    ...signIn(chromiumTarget, 'attempt-1'),
    ...saveTask(chromiumTarget, 'attempt-2', false),
    browserStarted('pixel', true),
    ...signIn(pixelTarget, 'attempt-3'),
    ...saveTask(pixelTarget, 'attempt-4', true),
    {
      type: 'run.finished',
      status: 'failed',
      exitCode: 1,
      complete: true,
      counts: { passed: 3, failed: 1, error: 0, notRun: 0, inconclusive: 0 },
      durationMs: 7200,
    },
  ])
}

/** The server never answers, so no test runs; the run fails with the server's reason. */
export function serverFailureRun(rootDir: string): RetestEvent[] {
  const failure: Failure = {
    class: 'setup_failed',
    message: `The server for web did not answer at ${baseUrl} within 60000 ms. Its output is in logs/app-web.log.`,
  }
  const notRun = (test: string, name: string, variant: Variant): EventBody => ({
    type: 'test.finished',
    ...scope(test, `${name}-${variantKey(variant)}`, variant),
    status: 'not_run',
    durationMs: 0,
    assertionCount: 0,
    failure,
  })
  return stamp([
    runStarted(rootDir),
    { type: 'app.failed', app: 'web', ready: baseUrl, failure },
    collected,
    notRun(signsIn, 'signs', chromiumTarget),
    notRun(savesTask, 'saves', chromiumTarget),
    notRun(signsIn, 'signs', pixelTarget),
    notRun(savesTask, 'saves', pixelTarget),
    {
      type: 'run.finished',
      status: 'error',
      exitCode: 2,
      complete: false,
      counts: { passed: 0, failed: 0, error: 0, notRun: 4, inconclusive: 0 },
      durationMs: 60_100,
      failure,
    },
  ])
}

/** The result the runner would store for these events, with every browser it started. */
export function variantResult(events: RetestEvent[]): RunResult {
  const { browsers } = rebuildResult(events)
  return { ...resultOf(events), ...(browsers === undefined ? {} : { browsers }) }
}
