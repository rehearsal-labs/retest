import type { TestContext } from 'node:test'
import type { OwnedBrowser, OwnedPage } from '../../src/browser/contract.ts'
import type { CommandResult } from '../../src/protocol/commands.ts'
import type { FrameRecipe, LocatorRecipe } from '../../src/protocol/locator.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EDIT_HEADING } from '../../fixtures/task-app/leaving-page.ts'
import { ChromiumPage } from '../../src/browser/page.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { assertOk, awaitFirstLook, byTestId, click, failureOf, goto, launchGated, openApp, openPage, sharedBrowser, timed } from './browser-harness.ts'

// A check right after an action that leaves the page must read the page the action opens, never the one it leaves: a
// look reads nothing while the main frame has another document on its way, and reads the new one once it is there. The
// edit page's every way out reaches a save that answers late with a server error page, which has no edit heading.

const browser = sharedBrowser()

const heading = byTestId('task-heading')

type Edit = { url: string; page: OwnedPage }

// The edit page, opened and looked at once, so the first look of a case is not the one Chrome lays the page out for.
async function openEdit(t: TestContext, from: OwnedBrowser, waitMs = 600): Promise<Edit> {
  const app = await openApp(t)
  const page = await openPage(t, from, app.url)
  assertOk(await goto(page, `/leaving/edit?wait=${waitMs}`))
  await awaitFirstLook(page, heading)
  return { url: app.url, page }
}

function look(page: OwnedPage, timeoutMs: number = defaultTimeouts.assertion): Promise<CommandResult> {
  return page.execute({ kind: 'observe', locator: heading }, timeoutMs)
}

// The look's count of edit headings, and the page it read them on.
function readOn(result: CommandResult): [number, string | undefined] {
  assert.ok(result.ok && result.kind === 'observe', JSON.stringify(result))
  return [result.observation.count, result.page?.url]
}

test('a look right after a click that posts a form to a slow server reads the page the server answers, not the form', async (t) => {
  const { url, page } = await openEdit(t, browser())
  assertOk(await click(page, 'save'))
  assert.deepEqual(readOn(await look(page)), [0, `${url}/leaving/save`])
})

test('a look right after a click on a link to a slow page reads the page the link opens', async (t) => {
  const { url, page } = await openEdit(t, browser())
  assertOk(await click(page, 'save-link'))
  assert.deepEqual(readOn(await look(page)), [0, `${url}/leaving/save`])
})

test('a look right after a click whose listener assigns the address reads the page it opens', async (t) => {
  const { url, page } = await openEdit(t, browser())
  assertOk(await click(page, 'save-now'))
  assert.deepEqual(readOn(await look(page)), [0, `${url}/leaving/save`])
})

test('an action right after a click that posts a form waits for the page the server answers, and looks for its element there', async (t) => {
  const { page } = await openEdit(t, browser())
  assertOk(await click(page, 'save'))
  assert.deepEqual(failureOf(await click(page, 'save-link', 2000)), {
    class: 'not_found',
    message: "Could not click getByTestId('save-link'): no element matched within 2000 ms.",
    details: { waitedMs: 2000 },
  })
})

// Nothing tells Retest of a submit a timer makes until the page asks for it, after the click has answered, so a look
// before then reads the edit page. Once the page has asked, a look waits for the page that answers.
test('a look once the page asked for the submit its click listener deferred with a timer of 0 reads the page that answers', async (t) => {
  const requested = Promise.withResolvers<void>()
  const gated = await launchGated(t, {
    watch: (message) => {
      const params = message['params']
      const asked = typeof params === 'object' && params !== null && 'url' in params ? String(params.url) : ''
      if (message['method'] === 'Page.frameRequestedNavigation' && asked.includes('/leaving/save')) requested.resolve()
    },
  })
  const { url, page } = await openEdit(t, gated)
  assertOk(await click(page, 'save-soon'))
  await requested.promise
  assert.deepEqual(readOn(await look(page)), [0, `${url}/leaving/save`])
})

test('a look while the page is still opening another document fails once its time is up, naming the address, having read nothing', async (t) => {
  const { url, page } = await openEdit(t, browser(), 10_000)
  assertOk(await click(page, 'save'))
  const { value, ms } = await timed(look(page, 800))
  assert.deepEqual(failureOf(value), {
    class: 'timeout',
    message: `Could not read getByTestId('task-heading') within 800 ms: the page was still opening ${url}/leaving/save, so Retest read nothing.`,
    details: { check: 'navigation', url: `${url}/leaving/save`, waitedMs: 800 },
  })
  assert.ok(ms >= 790 && ms < 5000, `took ${ms} ms, and the server answers after 10000`)
})

test("a look at the page itself right after the form's click reads the address and title of the page the server answers", async (t) => {
  const { url, page } = await openEdit(t, browser())
  assertOk(await click(page, 'save'))
  const result = await page.execute({ kind: 'observePage' }, defaultTimeouts.assertion)
  assert.ok(result.ok && result.kind === 'observePage', JSON.stringify(result))
  assert.deepEqual(result.observation, { url: `${url}/leaving/save?wait=600`, title: 'Server error' })
})

test("a look at the page itself while the page is still opening another document fails once its time is up, naming the address", async (t) => {
  const { url, page } = await openEdit(t, browser(), 10_000)
  assertOk(await click(page, 'save'))
  const result = await page.execute({ kind: 'observePage' }, 800)
  assert.deepEqual(failureOf(result), {
    class: 'timeout',
    message: `Could not read the page within 800 ms: the page was still opening ${url}/leaving/save, so Retest read nothing.`,
    details: { check: 'navigation', url: `${url}/leaving/save`, waitedMs: 800 },
  })
})

test("a layout look right after the form's click measures the page the server answers", async (t) => {
  const { url, page } = await openEdit(t, browser())
  assertOk(await click(page, 'save'))
  const result = await page.execute({ kind: 'observeLayout', locator: heading }, defaultTimeouts.assertion)
  assert.ok(result.ok && result.kind === 'observeLayout', JSON.stringify(result))
  assert.deepEqual([result.observation.targets.map((target) => target.count), result.page?.url], [[0], `${url}/leaving/save`])
})

test("a keyed read right after the form's click reads the page the server answers", async (t) => {
  const { url, page } = await openEdit(t, browser())
  assert.ok(page instanceof ChromiumPage)
  assertOk(await click(page, 'save'))
  const reading = await page.readElements([heading], defaultTimeouts.assertion)
  assert.ok(reading.ok, JSON.stringify(reading))
  assert.deepEqual([reading.reads.map((read) => read.observation.count), reading.page?.url], [[0], `${url}/leaving/save`])
})

test("a picture of the heading right after the form's click is looked for on the page the server answers", async (t) => {
  const { url, page } = await openEdit(t, browser())
  assertOk(await click(page, 'save'))
  const taken = await page.takePicture?.({ locator: heading }, defaultTimeouts.assertion)
  assert.ok(taken?.ok === true && 'target' in taken, JSON.stringify(taken === undefined || !taken.ok || !('png' in taken) ? taken : { page: taken.page }))
  assert.deepEqual([taken.target.count, taken.page?.url], [0, `${url}/leaving/save`])
})

test("a host check's read right after the form's click reads nothing, and says the page is opening another document", async (t) => {
  const { page } = await openEdit(t, browser())
  assertOk(await click(page, 'save'))
  const reading = await page.readPage([{ text: EDIT_HEADING, ignoreCase: false }], defaultTimeouts.assertion)
  assert.deepEqual([reading.navigating, reading.found], [true, []])
})

// A navigation the browser gives up, and a move within the document, leave the page where it was: the look after
// them reads it at once rather than waiting for a document that never comes.
test('a look after a link to an answer with no content, to a download or within the document reads the page that stayed, at once', async (t) => {
  for (const link of ['empty-link', 'report-link', 'details-link']) {
    const { url, page } = await openEdit(t, browser())
    assertOk(await click(page, link))
    const { value, ms } = await timed(look(page))
    assert.deepEqual(readOn(value), [1, `${url}/leaving/edit`], link)
    assert.ok(ms < 2500, `${link}: took ${ms} ms of the look's ${defaultTimeouts.assertion} ms`)
  }
})

test('a look after a click whose page asks before it leaves, which the test dismissed, reads the page that stayed, at once', async (t) => {
  const { url, page } = await openEdit(t, browser())
  assert.ok(page instanceof ChromiumPage)
  // The page asks before it leaves only once a person has used it, as this click does.
  assertOk(await click(page, 'guard'))
  const arming = page.armDialog(defaultTimeouts.action)
  assert.ok(arming.ok)
  const clicked = click(page, 'save-link')
  const opened = await arming.opened
  assert.ok(opened.ok, JSON.stringify(opened))
  const answered = await page.answerDialog(opened.dialog.id, { accept: false }, defaultTimeouts.action)
  assert.ok(answered.ok, JSON.stringify(answered))
  assertOk(await clicked)
  const { value, ms } = await timed(look(page))
  assert.deepEqual(readOn(value), [1, `${url}/leaving/edit`])
  assert.ok(ms < 2500, `took ${ms} ms of the look's ${defaultTimeouts.assertion} ms`)
})

// A frame on a locator's path that is opening another document holds it as the page does: a look in it reads nothing
// until that document is there. The frame of another site runs in a process of its own.
test("a look in a frame right after a click that posts the frame's form reads the page the frame opens, of the same site or another", async (t) => {
  const app = await openApp(t)
  const frame: FrameRecipe[] = [{ by: 'css', selector: 'iframe[title="Edit task"]' }]
  const framed = (locator: LocatorRecipe): LocatorRecipe => ({ ...locator, frame })
  for (const origin of ['', app.url.replace('127.0.0.1', 'localhost')]) {
    const page = await openPage(t, browser(), app.url)
    assertOk(await goto(page, `/leaving/framed?frame=${encodeURIComponent(origin)}`))
    await awaitFirstLook(page, framed(heading))
    assertOk(await click(page, framed(byTestId('save'))))
    const result = await page.execute({ kind: 'observe', locator: framed(heading) }, defaultTimeouts.assertion)
    assert.ok(result.ok && result.kind === 'observe', JSON.stringify(result))
    assert.equal(result.observation.count, 0, `${origin === '' ? 'the same site' : 'another site'}: ${JSON.stringify(result.observation)}`)
    const banner = await page.execute({ kind: 'observe', locator: framed(byTestId('error-banner')) }, defaultTimeouts.assertion)
    assert.ok(banner.ok && banner.kind === 'observe' && banner.observation.count === 1, JSON.stringify(banner))
  }
})
