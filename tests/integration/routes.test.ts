import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { browserPath } from '../support/test-browser.ts'
import { openApp } from './browser-harness.ts'
import { budgets, configSource, eventsOf, filesHolding, runCli, runProject, testNamed, writeProject } from './cli-harness.ts'

// Mocked responses through a whole run on Chrome: a test file answers the routes page's requests itself, refuses one,
// matches one by a regular expression, takes a route away again, and a popup the page opens shares the routes. Each
// change is a `route` event at its line; the diagnostics mark what a route answered, naming it, and the HTML report says
// so in its network section; a secret typed into a page a route served is still only its name in every file of the run.

const password = 'route-secret-7b2e91'
// A secret with the characters a regular expression escapes, slashes among them.
const token = 'tok.en$7/q'

const names = {
  stubs: 'stubs the task list, refuses the slow request and answers a task by its id',
  popup: 'a popup shares the routes of the page that opened it',
  unknown: 'unroute of a pattern no route was added with fails',
  secret: 'a secret typed into a page a route served stays a secret',
  written: 'a secret written into a long pattern or a regular expression stays a secret',
} as const

// A glob long enough that the secret in it straddles the 200 characters a message keeps.
const longPattern = `**/${'a'.repeat(185)}${password}/never`

// A whole page a route serves in place of the server: a field whose text the page repeats below it.
const formPage = '<!doctype html><title>Mocked form</title><input data-testid="secret-field" type="text"><p data-testid="echo"></p><script>document.querySelector("input").addEventListener("input", (event) => { document.querySelector("[data-testid=echo]").textContent = "typed " + event.target.value })</script>'

const tests = `import { expect, secret, test } from '@rehearsal-labs/retest'

test(${JSON.stringify(names.stubs)}, async ({ page }) => {
  await page.route('**/api/tasks', { status: 200, contentType: 'application/json', body: JSON.stringify([{ title: 'Stubbed' }]) })
  await page.route('**/api/slow', { abort: 'connectionrefused' })
  await page.route(/\\/api\\/tasks\\/\\d+$/, { status: 404, body: 'Not found' })
  await page.goto('/routes')
  await expect(page.getByTestId('tasks')).toHaveText('Stubbed')
  await page.getByTestId('slow').click()
  await expect(page.getByTestId('slow-status')).toHaveText('slow failed: Failed to fetch')
  await page.getByTestId('task-7').click()
  await expect(page.getByTestId('task-status')).toHaveText('404 Not found')
  await page.unroute('**/api/tasks')
  await page.reload()
  await expect(page.getByTestId('tasks')).toHaveText('Real task')
})

test(${JSON.stringify(names.popup)}, async ({ page }) => {
  await page.route('**/api/tasks', { contentType: 'application/json', body: JSON.stringify([{ title: 'Shared' }]) })
  await page.goto('/routes')
  const popup = await page.popup(() => page.getByTestId('open-popup').click())
  await expect(popup.getByTestId('tasks')).toHaveText('Shared')
  await popup.route('**/api/tasks', { contentType: 'application/json', body: JSON.stringify([{ title: 'From the popup' }]) })
  await page.reload()
  await expect(page.getByTestId('tasks')).toHaveText('From the popup')
})

test(${JSON.stringify(names.unknown)}, async ({ page }) => {
  await page.route('**/api/tasks', { body: '[]' })
  await page.unroute('**/api/task')
})

test(${JSON.stringify(names.secret)}, async ({ page }) => {
  await page.route('**/routes/mocked-form', { contentType: 'text/html', body: ${JSON.stringify(formPage)} })
  await page.goto('/routes/mocked-form')
  await page.getByTestId('secret-field').fill(secret('password'))
  await expect(page.getByTestId('echo')).toHaveText('typed nothing', { timeout: 300 })
})

test(${JSON.stringify(names.written)}, async ({ page }) => {
  await page.route(${JSON.stringify(longPattern)}, { body: 'never asked' })
  await page.route(/never\\/tok\\.en\\$7\\/q$/, { body: 'never asked' })
  await page.unroute(${JSON.stringify(`${longPattern}r`)})
})
`

test('a run answers requests with its routes, and its events, diagnostics and report name each route', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chromium({ executablePath: ${JSON.stringify(browserPath())}, baseUrl: ${JSON.stringify(app.url)} }) }, secrets: { password: env('RETEST_ROUTES_PASSWORD'), token: env('RETEST_ROUTES_TOKEN') } }`),
    'tests/routes.retest.ts': tests,
  })
  const run = await runProject(t, root, { timeouts: budgets({ assertion: 2000 }), env: { RETEST_ROUTES_PASSWORD: password, RETEST_ROUTES_TOKEN: token } })
  assert.equal(run.exit.code, 1, run.stderr)

  const stubs = testNamed(run, names.stubs)
  assert.equal(stubs.status, 'passed', JSON.stringify(stubs.failure))
  const routes = eventsOf(run.events, 'route').filter((event) => event.testId === stubs.testId)
  assert.deepEqual(
    routes.map(({ operation, pattern, answer, removed, location, session }) => ({ operation, pattern, answer, removed, line: location?.line, session })),
    [
      { operation: 'add', pattern: "'**/api/tasks'", answer: { status: 200, contentType: 'application/json', bodyBytes: 21 }, removed: undefined, line: 4, session: 'web' },
      { operation: 'add', pattern: "'**/api/slow'", answer: { abort: 'connectionrefused' }, removed: undefined, line: 5, session: 'web' },
      { operation: 'add', pattern: '/\\/api\\/tasks\\/\\d+$/', answer: { status: 404, bodyBytes: 9 }, removed: undefined, line: 6, session: 'web' },
      { operation: 'remove', pattern: "'**/api/tasks'", answer: undefined, removed: 1, line: 13, session: 'web' },
    ],
  )
  const reached = (await (await fetch(`${app.url}/routes/counts`)).json()) as Record<string, number>
  assert.equal(reached['GET /routes/api/slow'], undefined, 'the refused request never reached the server')
  assert.equal(reached['GET /routes/api/tasks/7'], undefined, 'the task the expression matched never reached the server')

  // The diagnostics mark the hops the routes answered as the test's own, naming each route, and leave the rest unmarked.
  const artifacts = readdirSync(join(run.output, 'diagnostics')).filter((name) => name.endsWith('.jsonl'))
  const lines = artifacts.flatMap((name) => readFileSync(join(run.output, 'diagnostics', name), 'utf8').trim().split('\n').map((line): unknown => JSON.parse(line)))
  const marked = lines.filter((line): line is { type: string; route: string; mocked: true } => typeof line === 'object' && line !== null && 'mocked' in line)
  assert.ok(marked.some((line) => line.type === 'network.response' && line.route === "'**/api/tasks'"), JSON.stringify(marked))
  assert.ok(marked.some((line) => line.type === 'network.failed' && line.route === "'**/api/slow'"), JSON.stringify(marked))
  assert.ok(marked.some((line) => line.type === 'network.response' && line.route === '/\\/api\\/tasks\\/\\d+$/'), JSON.stringify(marked))
  assert.ok(marked.every((line) => line.mocked === true))

  const popup = testNamed(run, names.popup)
  assert.equal(popup.status, 'passed', JSON.stringify(popup.failure))

  const unknown = testNamed(run, names.unknown)
  assert.deepEqual([unknown.status, unknown.failure?.class], ['failed', 'usage'])
  assert.equal(unknown.failure?.message, "page.unroute('**/api/task') matches no route of this page. Pass the pattern the route was added with, as it was written.")
  assert.equal(unknown.failure?.location?.line, 30)
  const refused = eventsOf(run.events, 'route').filter((event) => event.testId === unknown.testId && event.operation === 'remove')
  assert.deepEqual(refused.map((event) => event.failure?.class), ['usage'])

  const secretTest = testNamed(run, names.secret)
  assert.deepEqual([secretTest.status, secretTest.failure?.class], ['failed', 'check_failed'])
  assert.match(secretTest.failure?.message ?? '', /typed \{\{password\}\}/)
  assert.deepEqual(filesHolding(run.output, password), [], 'the secret reached no file of the run')

  // A pattern is redacted whole before it is cut, so no start of a secret is left at the cut, and a secret a regular
  // expression escapes is hidden as it is written there.
  const written = testNamed(run, names.written)
  assert.deepEqual([written.status, written.failure?.class], ['failed', 'usage'])
  const writtenRoutes = eventsOf(run.events, 'route').filter((event) => event.testId === written.testId)
  assert.equal(writtenRoutes.length, 3)
  assert.match(writtenRoutes[0]?.pattern ?? '', /^'\*\*\/a{185}\{\{/)
  assert.equal(writtenRoutes[1]?.pattern, '/never\\/{{token}}$/')
  for (const part of [password.slice(0, 15), token, 'tok\\.en\\$7']) assert.deepEqual(filesHolding(run.output, part), [], `no file of the run holds ${part}`)

  const report = await runCli(t, ['report', run.output])
  assert.equal(report.exit.code, 0, report.stderr)
  const html = readFileSync(join(run.output, 'report.html'), 'utf8')
  assert.ok(html.includes('mocked by page.route(&#39;**/api/slow&#39;)'), 'the network section names the route that refused a request')
  assert.ok(html.includes('page.route(&#39;**/api/tasks&#39;) answers 200, application/json, 21 bytes'), 'the timeline names each route and its answer')
  assert.ok(html.includes('page.unroute(&#39;**/api/tasks&#39;) removed 1 route'), 'the timeline names each route taken away')
  assert.ok(!html.includes(password), 'the report holds no secret')
  const inspected = await runCli(t, ['inspect', run.output, '--test', `tests/routes.retest.ts > ${names.stubs}`])
  assert.equal(inspected.exit.code, 0, inspected.stderr)
  assert.match(inspected.stdout, /page\.route\('\*\*\/api\/slow'\) refuses requests as connectionrefused/)
})
