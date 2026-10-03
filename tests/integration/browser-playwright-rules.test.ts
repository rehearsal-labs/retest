import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LONG_TITLE, PLAYWRIGHT_PAGE, SHADOW_PAGE } from '../../fixtures/task-app/lookup-routes.ts'
import { assertOk, click, failureOf, goto, observe, openPage, servePages, sharedBrowser, timed } from './browser-harness.ts'

const browser = sharedBrowser()

const playwright = (recipe: LocatorRecipe): LocatorRecipe => ({ ...recipe, dialect: 'playwright' })

test("a label by Playwright's rules also finds what aria-label or aria-labelledby names, on any element, where Retest's own finds only form controls", async (t) => {
  const site = await servePages(t, { '/': PLAYWRIGHT_PAGE })
  const page = await openPage(t, browser(), site.url)
  assertOk(await goto(page, '/'))
  const unread: LocatorRecipe = { by: 'label', text: 'unread', exact: false }
  assert.deepEqual([(await observe(page, playwright(unread))).count, (await observe(page, playwright(unread))).text], [1, '3'])
  assert.equal((await observe(page, unread)).count, 0)
  const summary: LocatorRecipe = { by: 'label', text: 'Order summary' }
  assert.equal((await observe(page, playwright(summary))).text, '2 tasks', 'named by the text aria-labelledby points at')
  assert.equal((await observe(page, summary)).count, 0)
  const search: LocatorRecipe = { by: 'label', text: 'Search tasks' }
  assert.equal((await observe(page, playwright(search))).count, 1, 'a form control Chrome names is still found')
})

test("a locator by Playwright's rules on a page with an open shadow root fails at once as unsupported, naming the host, and Retest's own looks as before", async (t) => {
  const site = await servePages(t, { '/': SHADOW_PAGE })
  const page = await openPage(t, browser(), site.url)
  assertOk(await goto(page, '/'))
  const outside: LocatorRecipe = { by: 'role', role: 'button', name: 'Outside' }
  const message = (action: string) =>
    `Could not ${action}: the page holds an open shadow root, in <todo-widget>. Playwright looks inside shadow roots and Retest does not, so Retest refuses the lookup rather than find less than Playwright would.`
  const looked = await page.execute({ kind: 'observe', locator: playwright({ by: 'text', text: 'Inside', exact: false }) }, 2000)
  assert.deepEqual(failureOf(looked), { class: 'unsupported', message: message("read getByText('Inside')"), details: { host: '<todo-widget>' } })
  const { value: clicked, ms } = await timed(click(page, playwright(outside), 3000))
  assert.deepEqual(failureOf(clicked), { class: 'unsupported', message: message("click getByRole('button', { name: 'Outside' })"), details: { host: '<todo-widget>' } })
  assert.ok(ms < 1000, `refused at once, after ${ms} ms`)
  assert.equal((await observe(page, outside)).count, 1, "Retest's own locator finds the button outside the shadow root")
  assert.equal((await observe(page, { by: 'text', text: 'Inside' })).count, 0, 'and does not look inside it')
})

test('a look at the page reads the whole address, query and fragment included, and the whole title, past what Retest records', async (t) => {
  const site = await servePages(t, { '/tasks?tab=open': `<!doctype html><title>${LONG_TITLE}</title><p>Tasks</p>` })
  const page = await openPage(t, browser(), site.url)
  assertOk(await goto(page, '/tasks?tab=open#top'))
  const look = await page.execute({ kind: 'observePage' }, 2000)
  assert.ok(look.ok && look.kind === 'observePage', JSON.stringify(look))
  assert.deepEqual(look.observation, { url: `${site.url}/tasks?tab=open#top`, title: LONG_TITLE })
  assert.equal(look.page?.url, `${site.url}/tasks`, 'the page facts keep origin and path')
})
