import type { FinishedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openApp } from './browser-harness.ts'
import { budgets, configSource, eventsOf, runProject, testNamed, writeProject } from './cli-harness.ts'
import { failedAtIn, lineOf } from './workflow-harness.ts'

// Release 1 workflow family 1, open a page, navigate and reload, against real Chrome and the task app's small site.
// The cases are F1.1 to F1.4 in docs/compatibility/workflow-cases.md.

const file = 'tests/navigation.retest.ts'
const assertFailedAt = failedAtIn(file)

const source = (origin: string): string => `import { expect, test } from '@rehearsal-labs/retest'

test('opens pages by link, by a moved address and by an absolute address', async ({ page }) => {
  await page.goto('/workflow/site')
  await expect(page.getByTestId('heading')).toHaveText('Home')
  await page.getByRole('link', { name: 'Projects' }).click()
  await expect(page.getByTestId('heading')).toHaveText('Projects')
  await page.getByRole('link', { name: 'Apollo' }).click()
  await expect(page.getByTestId('heading')).toHaveText('Apollo')
  await expect(page.getByTestId('summary')).toHaveText('The launch checklist for the spring release.')
  await page.getByRole('link', { name: 'Back to projects' }).click()
  await expect(page.getByRole('link', { name: 'Borealis' })).toBeVisible()
  await page.goto('/workflow/site/old-projects')
  await expect(page.getByTestId('heading')).toHaveText('Projects')
  await page.goto('${origin}/workflow/site')
  await expect(page.getByTestId('welcome')).toHaveText('Welcome back. Pick a project to carry on.')
})

test('a reload keeps the saved name and loses the unsaved draft', async ({ page }) => {
  await page.goto('/workflow/site/settings')
  await expect(page.getByTestId('loads')).toHaveText('Loaded 1 time in this tab')
  await page.getByLabel('Display name').fill('Ada')
  await page.getByRole('button', { name: 'Save profile' }).click()
  await expect(page.getByTestId('profile-status')).toHaveText('Profile saved')
  await page.getByLabel('Draft note').fill('Pay the venue deposit')
  await page.reload()
  await expect(page.getByTestId('loads')).toHaveText('Loaded 2 times in this tab')
  await expect(page.getByLabel('Display name')).toHaveValue('Ada')
  await expect(page.getByTestId('saved-name')).toHaveText('Ada')
  await expect(page.getByLabel('Draft note')).toHaveValue('')
})

test('a section opened by a client-side route survives a reload', async ({ page }) => {
  await page.goto('/workflow/site/settings')
  await page.getByRole('tab', { name: 'Notifications' }).click()
  await expect(page.getByTestId('notifications-intro')).toBeVisible()
  await expect(page.getByTestId('profile-section')).toBeHidden()
  await expect(page).toHaveURL('/workflow/site/settings/notifications')
  await page.reload()
  await expect(page.getByTestId('notifications-intro')).toBeVisible()
  await expect(page.getByTestId('loads')).toHaveText('Loaded 2 times in this tab')
  await page.getByRole('tab', { name: 'Profile' }).click()
  await expect(page.getByLabel('Display name')).toBeVisible()
})

test('a menu link that leads to the wrong page fails at the heading check', async ({ page }) => {
  await page.goto('/workflow/site?defect=wrong-link')
  await test.step('open settings from the menu', async () => {
    await page.getByRole('link', { name: 'Settings' }).click()
    await expect(page.getByTestId('heading')).toHaveText('Settings')
  })
})
`

const opens = 'opens pages by link, by a moved address and by an absolute address'
const reloads = 'a reload keeps the saved name and loses the unsaved draft'
const routes = 'a section opened by a client-side route survives a reload'
const wrongLink = 'a menu link that leads to the wrong page fails at the heading check'

// The commands a test sent to its page, in order.
function commandsOf(run: FinishedRun, name: string): string[] {
  const { testId } = testNamed(run, name)
  return eventsOf(run.events, 'action.completed').filter((event) => event.testId === testId).map((event) => event.command)
}

// Each navigation of a test as its path, what started it, and whether it opened a new document.
function navigations(run: FinishedRun, name: string, origin: string): [string, string | undefined, string | undefined][] {
  const { testId } = testNamed(run, name)
  return eventsOf(run.events, 'navigation')
    .filter((event) => event.testId === testId)
    .map((event) => [event.url.slice(origin.length), event.cause, event.document])
}

test('workflow family 1: pages open by link, redirect and address, a reload loads the page again, and a wrong link fails at its check', async (t) => {
  const app = await openApp(t)
  const tests = source(app.url)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) } }`),
    [file]: tests,
  })
  const run = await runProject(t, root, { timeouts: budgets({ assertion: 1500 }) })
  assert.equal(run.exit.code, 1, run.stderr)

  // F1.1: links, the server's redirect from the moved address, and an absolute address each open their page.
  assert.equal(testNamed(run, opens).status, 'passed')
  assert.deepEqual(navigations(run, opens, app.url), [
    ['/workflow/site', 'goto', 'new'],
    ['/workflow/site/projects', 'action', 'new'],
    ['/workflow/site/projects/apollo', 'action', 'new'],
    ['/workflow/site/projects', 'action', 'new'],
    ['/workflow/site/projects', 'goto', 'new'],
    ['/workflow/site', 'goto', 'new'],
  ])

  // F1.2: the reload loads a new document, which counts its second load in this tab, shows the name the server saved
  // and has lost the draft nobody saved. A navigation a reload starts is recorded as the command's own, as a goto's.
  assert.equal(testNamed(run, reloads).status, 'passed')
  assert.deepEqual(commandsOf(run, reloads), ['goto', 'fill', 'click', 'fill', 'reload'])
  assert.deepEqual(navigations(run, reloads, app.url), [
    ['/workflow/site/settings', 'goto', 'new'],
    ['/workflow/site/settings', 'goto', 'new'],
  ])

  // F1.3: the tab moves to a new path within the document, which the page's address shows; a reload of that path opens
  // the same section in a new document.
  assert.equal(testNamed(run, routes).status, 'passed')
  assert.deepEqual(navigations(run, routes, app.url), [
    ['/workflow/site/settings', 'goto', 'new'],
    ['/workflow/site/settings/notifications', 'action', 'same'],
    ['/workflow/site/settings/notifications', 'goto', 'new'],
    ['/workflow/site/settings', 'action', 'same'],
  ])

  // F1.4: the Settings link opens the projects page, so the heading check fails in its step, naming both texts.
  assertFailedAt(run, wrongLink, {
    step: 'open settings from the menu',
    failureClass: 'check_failed',
    line: lineOf(tests, "toHaveText('Settings')", 'open settings from the menu'),
    message: /^getByTestId\('heading'\) has text "Projects", expected "Settings"\./,
  })
  assert.deepEqual(navigations(run, wrongLink, app.url), [
    ['/workflow/site', 'goto', 'new'],
    ['/workflow/site/projects', 'action', 'new'],
  ])
})
