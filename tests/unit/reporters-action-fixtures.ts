import type { EventBody, RetestEvent } from '../../src/protocol/events.ts'
import type { Failure, SourceLocation } from '../../src/protocol/failures.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import type { Variant } from '../../src/protocol/variant.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { truncateText } from '../../src/protocol/failures.ts'
import { testId } from '../../src/protocol/run-folder.ts'
import { textComparison } from '../../src/protocol/text.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { variantKey } from '../../src/protocol/variant.ts'
import { tempFolder } from '../support/temp-folder.ts'
import { stamp } from './reporters-fixtures.ts'
import { observed } from './reporters-host-check-fixtures.ts'

// A run from a config: one app, web, on one target. The test chooses a country and toppings, ticks two boxes, one
// already ticked and one through its label, turns a switch off, scrolls the terms and the page, and saves. Each page
// it reaches has a title, and each navigation says what started it.

export const preferencesFile = 'tests/preferences.retest.ts'
export const baseUrl = 'http://127.0.0.1:4173'
export const preferencesUrl: string = `${baseUrl}/preferences`
export const savedUrl: string = `${baseUrl}/preferences/saved`
export const homeUrl: string = `${baseUrl}/home`

export const preferencesSource = `import { expect, test } from '@rehearsal-labs/retest'

test('saves preferences', async ({ page }) => {
  await page.goto('/preferences')
  await page.getByLabel('Country').select('Canada')
  await page.getByLabel('Toppings').select(['Cheese', { value: 'olives' }])
  await page.getByRole('checkbox', { name: 'Newsletter' }).check()
  await page.getByLabel('Remember me').check()
  await page.getByRole('switch', { name: 'Dark mode' }).uncheck()
  await page.getByTestId('terms').scroll({ y: 400 })
  await page.scroll({ y: 600 })
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('status')).toHaveText('Saved')
})
`

export const savesPreferences: string = testId(preferencesFile, 'saves preferences')
const chromeTarget: Variant = { web: 'chrome' }

const at = (line: number, column = 3): SourceLocation => ({ file: preferencesFile, line, column })
const ids = { testId: savesPreferences, attemptId: 'attempt-1', variant: chromeTarget, variantKey: variantKey(chromeTarget) }
const onWeb = { ...ids, session: 'web' }
const onPreferences = { ...onWeb, pageUrl: preferencesUrl, pageTitle: 'Preferences' }

const country: LocatorRecipe = { by: 'label', text: 'Country' }
const toppings: LocatorRecipe = { by: 'label', text: 'Toppings' }
const newsletter: LocatorRecipe = { by: 'role', role: 'checkbox', name: 'Newsletter' }
const rememberMe: LocatorRecipe = { by: 'label', text: 'Remember me' }
const darkMode: LocatorRecipe = { by: 'role', role: 'switch', name: 'Dark mode' }
const terms: LocatorRecipe = { by: 'testId', value: 'terms' }
const save: LocatorRecipe = { by: 'role', role: 'button', name: 'Save' }
const status: LocatorRecipe = { by: 'role', role: 'status' }

/** A folder with the test file in it, to be the run's root directory. */
export function preferencesProject(): string {
  const root = tempFolder('retest-actions-')
  mkdirSync(join(root, 'tests'))
  writeFileSync(join(root, preferencesFile), preferencesSource)
  return root
}

function runStarted(rootDir: string): EventBody {
  return {
    type: 'run.started',
    retestVersion: '0.0.0',
    node: 'v24.12.0',
    platform: 'darwin',
    rootDir,
    files: [preferencesFile],
    options: { config: 'retest.config.ts', timeouts: defaultTimeouts, reporter: 'human' },
  }
}

const browserStarted: EventBody = {
  type: 'browser.started',
  product: 'Chrome',
  version: '154.0.8037.92',
  userAgent: 'Mozilla/5.0 Chrome/154.0.8037.92',
  pid: 4242,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  app: 'web',
  target: { name: 'chrome' },
}

const collected: EventBody = {
  type: 'collection.completed',
  file: preferencesFile,
  tests: [{ testId: savesPreferences, name: 'saves preferences', location: at(3, 1), apps: ['web'], variants: [chromeTarget] }],
}

// Up to the page the test opened, before any choice.
function opened(rootDir: string): EventBody[] {
  return [
    runStarted(rootDir),
    browserStarted,
    collected,
    { type: 'test.started', ...ids, name: 'saves preferences', file: preferencesFile, location: at(3, 1) },
    { type: 'action.completed', ...onPreferences, command: 'goto', durationMs: 40, location: at(4) },
    { type: 'navigation', ...onWeb, url: preferencesUrl, title: 'Preferences', cause: 'goto' },
  ]
}

type ActionBody = Extract<EventBody, { type: 'action.completed' }>

// The same action, failed: what an action.failed event carries for it.
function failedAction(action: ActionBody, durationMs: number, failure: Failure): EventBody {
  const { type, ...fields } = action
  return { ...fields, type: 'action.failed', durationMs, failure }
}

const chooseCountry: ActionBody = {
  type: 'action.completed',
  ...onPreferences,
  command: 'select',
  locator: country,
  choices: [{ label: 'Canada' }],
  changed: true,
  input: 'script',
  durationMs: 8,
  location: at(5),
}

// The choices and the first tick, which found the box already ticked.
function chosen(): EventBody[] {
  return [
    chooseCountry,
    {
      type: 'action.completed',
      ...onPreferences,
      command: 'select',
      locator: toppings,
      choices: [{ label: 'Cheese' }, { value: 'olives' }],
      input: 'script',
      durationMs: 9,
      location: at(6),
    },
    { type: 'action.completed', ...onPreferences, command: 'check', locator: newsletter, changed: false, durationMs: 3, location: at(7) },
  ]
}

const tickRememberMe: ActionBody = {
  type: 'action.completed',
  ...onPreferences,
  command: 'check',
  locator: rememberMe,
  changed: true,
  via: 'label',
  durationMs: 14,
  location: at(8),
}

function saved(): EventBody[] {
  return [
    { type: 'action.completed', ...onPreferences, command: 'uncheck', locator: darkMode, changed: true, durationMs: 11, location: at(9) },
    { type: 'action.completed', ...onPreferences, command: 'scroll', locator: terms, scroll: { x: 0, y: 400 }, durationMs: 6, location: at(10) },
    { type: 'action.completed', ...onPreferences, command: 'scroll', scroll: { x: 0, y: 600 }, durationMs: 5, location: at(11) },
    { type: 'action.completed', ...onPreferences, command: 'click', locator: save, durationMs: 10, location: at(12) },
    { type: 'navigation', ...onWeb, url: savedUrl, title: 'Preferences saved', cause: 'action' },
    {
      type: 'observation',
      ...onWeb,
      observationId: 'o1',
      locator: status,
      pageUrl: savedUrl,
      pageTitle: 'Preferences saved',
      observed: observed('Saved'),
      durationMs: 3,
    },
    {
      type: 'assertion.passed',
      ...onWeb,
      matcher: 'toHaveText',
      locator: status,
      expected: truncateText('Saved'),
      actual: truncateText('Saved'),
      comparison: textComparison,
      attempts: 1,
      timeoutMs: 5000,
      durationMs: 30,
      location: at(13),
      pageUrl: savedUrl,
      pageTitle: 'Preferences saved',
      observationId: 'o1',
      judgedBy: 'parent',
    },
    // The saved page sends itself home a moment later, and home has no title.
    { type: 'navigation', ...onWeb, url: homeUrl, cause: 'page' },
  ]
}

const passedCounts = { passed: 1, failed: 0, error: 0, notRun: 0, inconclusive: 0 }

/** Every choice, tick and scroll lands, and the preferences are saved. */
export function actionsPassRun(rootDir: string): RetestEvent[] {
  return stamp([
    ...opened(rootDir),
    ...chosen(),
    tickRememberMe,
    ...saved(),
    { type: 'test.finished', ...ids, status: 'passed', durationMs: 900, assertionCount: 1 },
    { type: 'run.finished', status: 'passed', exitCode: 0, complete: true, counts: passedCounts, durationMs: 1200 },
  ])
}

export const stayedUnchecked: Failure = {
  class: 'not_actionable',
  message: 'Retest clicked it once, and it stayed unchecked. Retest does not click again.',
  location: at(8),
  details: { check: 'state', inputSent: true },
}

/** The box ticked through its label took the click and stayed unticked. */
export function checkIgnoredRun(rootDir: string): RetestEvent[] {
  return stamp([
    ...opened(rootDir),
    ...chosen(),
    failedAction(tickRememberMe, 5003, stayedUnchecked),
    { type: 'evidence.captured', ...onWeb, kind: 'screenshot', path: 'artifacts/preferences-saves-preferences-web-failure.png', reason: 'failure' },
    { type: 'test.finished', ...ids, status: 'failed', durationMs: 5400, assertionCount: 0, failure: stayedUnchecked },
    { type: 'run.finished', status: 'failed', exitCode: 1, complete: true, counts: { ...passedCounts, passed: 0, failed: 1 }, durationMs: 5700 },
  ])
}

export const choiceLost: Failure = { class: 'outcome_unknown', message: 'The browser closed after the choice was sent.', location: at(5) }

/** The browser is lost while the country is chosen, after the choice went to the page. */
export function selectLostRun(rootDir: string): RetestEvent[] {
  return stamp([
    ...opened(rootDir),
    failedAction(chooseCountry, 20, choiceLost),
    { type: 'test.finished', ...ids, status: 'error', durationMs: 300, assertionCount: 0, failure: choiceLost },
    { type: 'run.finished', status: 'error', exitCode: 2, complete: true, counts: { ...passedCounts, passed: 0, error: 1 }, durationMs: 500 },
  ])
}
