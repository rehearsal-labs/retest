import type { TestContext } from 'node:test'
import type { Pages } from './browser-harness.ts'
import type { FinishedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserPath, openApp, servePages } from './browser-harness.ts'
import { configSource, eventsOf, onlyEvent, resultOf, runCli, runProject, secondBrowserPath, testNamed, writeProject } from './cli-harness.ts'

// Acceptance check 5: an app with two targets runs its tests on each, `--target` picks one, and `runs` pairs the
// targets of two such apps. The targets are Google Chrome, found by chrome(), and Chrome for Testing, given to
// chromium() by its path.

// Each report page tells the server which browser opened it, by its major version, under the label in its path.
const reportPage = `<!doctype html><meta charset="utf-8"><title>Report</title><p data-testid="reported"></p>
<script>
const label = location.pathname.split('/')[2]
const major = /Chrome\\/(\\d+)/.exec(navigator.userAgent)?.[1] ?? 'unknown'
fetch('/seen/' + label + '/' + major, { method: 'POST' }).then(() => {
  document.querySelector('[data-testid="reported"]').textContent = 'reported'
})
</script>`

async function reportSite(t: TestContext): Promise<Pages> {
  return servePages(t, Object.fromEntries(['solo', 'web', 'admin'].map((label) => [`/report/${label}`, reportPage])))
}

function reportTests(site: Pages): Record<string, string> {
  const report = (label: string) => JSON.stringify(`${site.url}/report/${label}`)
  return {
    'tests/solo.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'

test('reports its browser', async ({ page }) => {
  await page.goto(${report('solo')})
  await expect(page.getByTestId('reported')).toHaveText('reported')
})
`,
    'tests/pair.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'

test('reports both browsers', { apps: ['web', 'admin'] }, async ({ web, admin }) => {
  await web.goto(${report('web')})
  await admin.goto(${report('admin')})
  await expect(web.getByTestId('reported')).toHaveText('reported')
  await expect(admin.getByTestId('reported')).toHaveText('reported')
})
`,
  }
}

function matrixConfig(baseUrl: string, runs: string): string {
  const targets = `targets: { chrome: chrome(), testing: chromium({ executablePath: ${JSON.stringify(secondBrowserPath())} }) }`
  return configSource(`{
  apps: {
    web: app({ baseUrl: ${JSON.stringify(baseUrl)}, ${targets} }),
    admin: app({ baseUrl: ${JSON.stringify(baseUrl)}, ${targets} }),
  },
  defaultApp: 'web',
  ${runs}
}`)
}

const pairings = "runs: [{ web: 'chrome', admin: 'testing' }, { web: 'testing', admin: 'chrome' }],"

function variantsOf(run: FinishedRun, name: string): (string | undefined)[] {
  return resultOf(run)
    .files.flatMap((file) => file.tests)
    .filter((each) => each.name === name)
    .map((each) => each.variantKey)
}

test('an app with two targets runs its test on each, and a run of two such apps follows runs', async (t) => {
  const [app, site] = [await openApp(t), await reportSite(t)]
  const root = await writeProject(t, { 'retest.config.ts': matrixConfig(app.url, pairings), ...reportTests(site) })
  const run = await runProject(t, root, { reporter: 'human', args: ['--no-agent'] })

  assert.equal(run.exit.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(variantsOf(run, 'reports its browser'), ['web=chrome', 'web=testing'])
  assert.deepEqual(variantsOf(run, 'reports both browsers'), ['admin=testing,web=chrome', 'admin=chrome,web=testing'])
  assert.deepEqual(testNamed(run, 'reports its browser').variant, { web: 'chrome' })

  // Each run of a test opened its page in the browser its variant names, and in no other.
  for (const seen of ['/seen/solo/154', '/seen/solo/153', '/seen/web/154', '/seen/web/153', '/seen/admin/153', '/seen/admin/154']) {
    assert.equal(site.posts(seen), 1, seen)
  }

  const browsers = eventsOf(run.events, 'browser.started')
  const described = browsers.map((event) => [`${event.app}=${event.target?.name}`, event.executablePath, event.version.split('.')[0]])
  assert.deepEqual(described.sort(), [
    ['admin=chrome', browserPath(), '154'],
    ['admin=testing', secondBrowserPath(), '153'],
    ['web=chrome', browserPath(), '154'],
    ['web=testing', secondBrowserPath(), '153'],
  ])
  const pids = new Map(browsers.map((event) => [event.executablePath, event.pid]))
  assert.equal(pids.size, 2, 'targets on the same executable share one browser process')
  for (const event of [...eventsOf(run.events, 'test.started'), ...eventsOf(run.events, 'action.completed'), ...eventsOf(run.events, 'assertion.passed')]) {
    assert.ok(event.variantKey !== undefined && event.variant !== undefined, `${event.type} carries its variant`)
  }

  // The report labels each run with its target, and sums up each target.
  for (const label of ['web=chrome', 'web=testing', 'admin=testing', 'admin=chrome']) assert.ok(run.stdout.includes(label), `the report names ${label}`)
  assert.match(run.stdout, /^ {2}web=chrome +Chrome 154\.\S+ +✓ 1 passed/m)
  assert.match(run.stdout, /^ {2}web=testing +Chrome 153\.\S+ +✓ 1 passed/m)
  assert.match(run.stdout, /^ {2}admin=testing,web=chrome +admin: Chrome 153\.\S+, web: Chrome 154\.\S+ +✓ 1 passed/m)
  assert.match(run.stdout, /Tests +4 passed across 4 targets/)

  const inspected = await runCli(t, ['inspect', run.output, '--test', 'tests/solo.retest.ts > reports its browser', '--target', 'web=testing'], { cwd: root })
  assert.equal(inspected.exit.code, 0, inspected.stderr)
  assert.match(inspected.stdout, /reports its browser +web=testing/)
  assert.match(inspected.stdout, /\bweb +goto →/)
  const ambiguous = await runCli(t, ['inspect', run.output, '--test', 'tests/solo.retest.ts > reports its browser'], { cwd: root })
  assert.equal(ambiguous.exit.code, 2, 'a test that ran on two targets needs --target')
  assert.match(ambiguous.stderr, /--target/)
})

test('--target keeps only the runs on that target, and starts only the browsers they use', async (t) => {
  const [app, site] = [await openApp(t), await reportSite(t)]
  const root = await writeProject(t, { 'retest.config.ts': matrixConfig(app.url, pairings), ...reportTests(site) })
  const run = await runProject(t, root, { args: ['--target', 'web=testing'] })

  assert.equal(run.exit.code, 0, run.stderr)
  assert.deepEqual(variantsOf(run, 'reports its browser'), ['web=testing'])
  assert.deepEqual(variantsOf(run, 'reports both browsers'), ['admin=chrome,web=testing'])
  assert.deepEqual([site.posts('/seen/solo/153'), site.posts('/seen/solo/154')], [1, 0])
  assert.deepEqual([site.posts('/seen/web/153'), site.posts('/seen/admin/154'), site.posts('/seen/web/154')], [1, 1, 0])
  const started = eventsOf(run.events, 'browser.started').map((event) => `${event.app}=${event.target?.name}`)
  assert.deepEqual(started.sort(), ['admin=chrome', 'web=testing'])

  // A run must use every target named: no runs entry pairs chrome with chrome, and the solo test uses no admin.
  const both = await runProject(t, root, { args: ['--target', 'web=chrome', '--target', 'admin=chrome'] })
  assert.equal(both.exit.code, 2)
  assert.deepEqual(resultOf(both).failure, { class: 'usage', message: 'No test matches --target admin=chrome and --target web=chrome.' })
  assert.deepEqual(eventsOf(both.events, 'browser.started'), [])

  const unknown = await runProject(t, root, { args: ['--target', 'web=beta'] })
  assert.equal(unknown.exit.code, 2)
  assert.deepEqual(unknown.events, [], 'no run started')
  assert.match(unknown.stderr, /web=beta/)
  assert.match(unknown.stderr, /chrome, testing|chrome and testing/)
})

test('two apps with several targets and no runs entry naming both fail collection, and the other files still run', async (t) => {
  const [app, site] = [await openApp(t), await reportSite(t)]
  const root = await writeProject(t, { 'retest.config.ts': matrixConfig(app.url, "runs: [{ web: 'chrome' }],"), ...reportTests(site) })
  const run = await runProject(t, root)

  assert.equal(run.exit.code, 2, run.stderr)
  const failed = onlyEvent(run.events, 'collection.failed')
  assert.equal(failed.file, 'tests/pair.retest.ts')
  assert.equal(failed.failure.class, 'collection_failed')
  assert.equal(
    failed.failure.message,
    '"reports both browsers": This test uses "web" and "admin", which have several targets each, and no entry in runs names all of them. Add one to runs.',
  )
  assert.deepEqual(variantsOf(run, 'reports its browser'), ['web=chrome', 'web=testing'])
  assert.equal(site.posts('/seen/web/154') + site.posts('/seen/web/153'), 0)
})
