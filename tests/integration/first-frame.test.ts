import assert from 'node:assert/strict'
import { test } from 'node:test'
import { servePages } from './browser-harness.ts'
import { budgets, configSource, eventsOf, runProject, writeProject } from './cli-harness.ts'

const STILL = '<!doctype html><title>Still</title><link rel="icon" href="data:,"><p>Still</p>'

// Busy for six seconds from its first task after it loaded, longer than a navigation waits for a page's first frame.
const BUSY = `<!doctype html><title>Busy</title><link rel="icon" href="data:,"><p data-testid="box">Busy</p><script>
  addEventListener('load', () => setTimeout(() => { const end = performance.now() + 6000; while (performance.now() < end) {} }, 0))
</script>`

test('a goto whose page drew no first frame says so on its action, and one whose page drew says nothing', async (t) => {
  const site = await servePages(t, { '/still': STILL, '/busy': BUSY })
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(site.url)} }) } }`),
    'tests/frame.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'

test('opens a page that draws and one that does not yet', async ({ page }) => {
  await page.goto('/still')
  await expect(page.getByText('Still')).toBeVisible()
  await page.goto('/busy')
  await expect(page.getByTestId('box')).toBeVisible()
})
`,
  })
  const run = await runProject(t, root, { timeouts: budgets({ navigation: 10_000, assertion: 10_000, test: 30_000 }) })
  assert.equal(run.exit.code, 0, run.stderr)
  const opened = eventsOf(run.events, 'action.completed').filter((event) => event.command === 'goto')
  assert.deepEqual(opened.map((event) => [event.pageUrl, event.firstFrame]), [[`${site.url}/still`, undefined], [`${site.url}/busy`, false]])
})
