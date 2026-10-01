import type { FinishedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openApp } from './browser-harness.ts'
import { configSource, eventsOf, filesHolding, runCli, runProject, testNamed, textHolds, writeProject } from './cli-harness.ts'

// Acceptance check 4: page titles and the cause of each navigation, through the command line against real Chrome
// and the task app's title pages. A secret the page puts in its title reads as its name, and a title's control
// characters reach no report.

const password = 'wren 7731 tag'
const variable = 'RETEST_E2E_TITLE_PASSWORD'
const alarm = '/titles/echo?title=%1B%5B2J%C2%9B31mAlarm%07%C2%9B0m'

const tests = `import { expect, secret, test } from '@rehearsal-labs/retest'

test('records a title and a cause for each way a page opens', async ({ page }) => {
  await page.goto('/titles')
  await page.getByRole('link', { name: 'Next' }).click()
  await expect(page.getByTestId('arrived')).toHaveText('Arrived')
  await page.goto('/titles')
  await page.getByLabel('Search').fill('release notes')
  await page.getByLabel('Search').press('Enter')
  await expect(page.getByTestId('arrived')).toHaveText('Arrived')
  await page.goto('/titles')
  await page.getByRole('button', { name: 'Push' }).click()
  await page.goto('/titles/chain')
  await expect(page.getByTestId('arrived')).toHaveText('Arrived')
})

test('hides a secret the page puts in its title', async ({ page }) => {
  await page.goto('/titles/greeting')
  await page.getByLabel('Name').fill(secret('password'))
  await page.getByLabel('Name').press('Enter')
  await expect(page.getByTestId('titled')).toHaveText('Titled')
})

test('keeps no control character of a title', async ({ page }) => {
  await page.goto('${alarm}')
  await expect(page.getByTestId('titled')).toHaveText('Not this')
})
`

const file = 'tests/titles.retest.ts'
const opens = 'records a title and a cause for each way a page opens'
const hides = 'hides a secret the page puts in its title'
const cleans = 'keeps no control character of a title'
const controlCharacters = /\p{Cc}/u

function navigations(run: FinishedRun, name: string, origin: string): [string, string | undefined, string | undefined][] {
  const { testId } = testNamed(run, name)
  return eventsOf(run.events, 'navigation')
    .filter((event) => event.testId === testId)
    .map((event) => [event.url.slice(origin.length), event.cause, event.title])
}

// Everything a report printed, without its line breaks, holds no control character.
function assertPrintable(what: string, text: string): void {
  assert.equal(controlCharacters.test(text.replaceAll('\n', '')), false, `${what} holds no control character:\n${JSON.stringify(text)}`)
}

test('navigations carry titles and causes, as do actions, looks and checks; a secret in a title reads as its name; no report holds a control character from a title', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{
  apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) },
  secrets: { password: env('${variable}') },
}`),
    [file]: tests,
  })
  const env = { [variable]: password, NO_COLOR: '1' }
  const run = await runProject(t, root, { env })
  assert.equal(run.exit.code, 1, run.stderr)

  // Each navigation names its own document's title and what started it: goto, the link, Enter in a form and a new
  // path the click's listener set are the test's; the redirect the page makes on its own after it loads is the
  // page's. The server's redirect gives its own document its own title.
  assert.equal(testNamed(run, opens).status, 'passed')
  assert.deepEqual(navigations(run, opens, app.url), [
    ['/titles', 'goto', 'Titles'],
    ['/titles/next', 'action', 'Next'],
    ['/titles', 'goto', 'Titles'],
    ['/titles/next', 'action', 'Next'],
    ['/titles', 'goto', 'Titles'],
    ['/titles/pushed', 'action', 'Pushed'],
    ['/titles/redirect', 'goto', 'Redirecting'],
    ['/titles/next', 'page', 'Next'],
  ])
  // An action names the page it went to, read as it acted; a look and the check resting on it name the page it read.
  const { testId } = testNamed(run, opens)
  const ofTest = run.events.filter((event) => 'testId' in event && event.testId === testId)
  const actions = eventsOf(ofTest, 'action.completed').map((event) => [event.command, event.pageTitle])
  assert.deepEqual(actions, [
    ['goto', 'Titles'],
    ['click', 'Titles'],
    ['goto', 'Titles'],
    ['fill', 'Titles'],
    ['press', 'Titles'],
    ['goto', 'Titles'],
    ['click', 'Titles'],
    ['goto', 'Redirecting'],
  ])
  // A look taken before the next page arrived read the page before it; every look that found the arrival read Next.
  const looks = eventsOf(ofTest, 'observation')
  assert.ok(looks.length >= 3 && looks.every((look) => look.pageTitle !== undefined), 'every look names the page it read')
  assert.deepEqual([...new Set(looks.filter((look) => look.observed.count === 1).map((look) => look.pageTitle))], ['Next'])
  const checks = eventsOf(ofTest, 'assertion.passed').map((check) => check.pageTitle)
  assert.deepEqual(checks, ['Next', 'Next', 'Next'], 'each check names the page of the look it rested on')

  // A secret the page makes its title reads as its name in every event, and nowhere in the run folder or the output.
  const hidden = testNamed(run, hides)
  assert.equal(hidden.status, 'passed')
  assert.deepEqual(navigations(run, hides, app.url), [
    ['/titles/greeting', 'goto', 'Greeting'],
    ['/titles/echo', 'action', '{{password}}'],
  ])
  const hiddenLook = eventsOf(run.events, 'assertion.passed').find((event) => event.testId === hidden.testId)
  assert.equal(hiddenLook?.pageTitle, '{{password}}')
  assert.deepEqual(filesHolding(run.output, password), [])
  assert.ok(!textHolds(run.stdout, password) && !textHolds(run.stderr, password))

  // A title's control characters are gone from the events, and the check that failed on that page names it. Chrome
  // itself turns the escape and the bell into spaces; Retest removes the two C1 escapes Chrome keeps.
  const cleaned = testNamed(run, cleans)
  assert.deepEqual([cleaned.status, cleaned.failure?.class], ['failed', 'check_failed'])
  assert.deepEqual(navigations(run, cleans, app.url), [['/titles/echo', 'goto', '[2J31mAlarm 0m']])
  const failedCheck = eventsOf(run.events, 'assertion.failed').find((event) => event.testId === cleaned.testId)
  assert.equal(failedCheck?.pageTitle, '[2J31mAlarm 0m')

  // The human report, live and replayed, the agent report and inspect's timelines hold no control character, and show
  // the title beside each address they print.
  const live = await runProject(t, root, { env, reporter: 'human' })
  const agent = await runProject(t, root, { env, reporter: 'agent' })
  const replayed = await runCli(t, ['inspect', run.output], { env })
  const timelines = await Promise.all([opens, hides, cleans].map((name) => runCli(t, ['inspect', run.output, '--test', testNamed(run, name).testId], { env })))
  for (const [what, text] of [
    ['the live human report', live.stdout],
    ['the agent report', agent.stdout],
    ['the replayed report', replayed.stdout],
    ...timelines.map((timeline, index): [string, string] => [`timeline ${index + 1}`, timeline.stdout]),
  ] as const) {
    assertPrintable(what, text)
  }
  for (const report of [live.stdout, replayed.stdout]) {
    assert.match(report, /\n {4}Page {13}"\[2J31mAlarm 0m" at http:\/\/127\.0\.0\.1:\d+\/titles\/echo\n/)
  }
  const [opened, echoed] = timelines.map((timeline) => timeline.stdout)
  for (const line of [
    `navigated to "Titles" at ${app.url}/titles, by goto`,
    `navigated to "Next" at ${app.url}/titles/next, by an action`,
    `navigated to "Pushed" at ${app.url}/titles/pushed, by an action`,
    `navigated to "Redirecting" at ${app.url}/titles/redirect, by goto`,
    `navigated to "Next" at ${app.url}/titles/next, by the page`,
  ]) {
    assert.ok(opened?.includes(line), `inspect shows ${line}:\n${opened}`)
  }
  assert.ok(echoed?.includes(`navigated to "{{password}}" at ${app.url}/titles/echo, by an action`), echoed)
})
