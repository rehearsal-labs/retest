import type { TestContext } from 'node:test'
import type { OwnedPage } from '../../src/browser/contract.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ROW_COUNT } from '../../fixtures/task-app/locators-page.ts'
import { observedItemLimit } from '../../src/protocol/commands.ts'
import {
  assertOk,
  byLabel,
  byRole,
  byText,
  click,
  failureOf,
  fill,
  goto,
  observe,
  observeUntil,
  openApp,
  openPage,
  servePages,
  sharedBrowser,
  timed,
} from './browser-harness.ts'
import { engineExpectations } from './engine-expectations.ts'
import { observationOf } from '../support/observation.ts'

const browser = sharedBrowser()

// Cases another engine ends otherwise assert through this, which holds Chrome's outcome or the engine's declared one.
const engineCase = engineExpectations('browser-locators')

async function locatorsPage(t: TestContext): Promise<OwnedPage> {
  const app = await openApp(t)
  const page = await openPage(t, browser(), app.url)
  assertOk(await goto(page, '/locators'))
  return page
}

async function texts(page: OwnedPage, locator: LocatorRecipe): Promise<string[]> {
  return (await observe(page, locator)).items.map((item) => item.text)
}

test('role finds a button by the name Chrome computes from its content, aria-label, aria-labelledby or title', async (t) => {
  const page = await locatorsPage(t)
  assert.deepEqual(await texts(page, byRole('button', 'Save')), ['Save'])
  assert.deepEqual(await texts(page, byRole('button', 'Close dialog')), ['×'])
  assert.deepEqual(await texts(page, byRole('button', 'Archive task')), ['archive'])
  assert.deepEqual(await texts(page, byRole('button', 'Print page')), ['print'])
})

test('a name matches exactly by default: case counts, and the whole name must match', async (t) => {
  const page = await locatorsPage(t)
  assert.deepEqual(await texts(page, byRole('button', 'save')), ['save'])
  assert.deepEqual(await texts(page, byRole('button', 'SAVE')), [])
  assert.deepEqual(await texts(page, byRole('button', 'Save dra')), [])
})

test('exact: false matches any case and any part of the name, in document order', async (t) => {
  const page = await locatorsPage(t)
  assert.deepEqual(await texts(page, byRole('button', 'SAVE', false)), ['Save', 'save', '  Save\n    draft  '])
  assert.deepEqual(await texts(page, byRole('button', 'dialog', false)), ['×'])
})

test('names are compared with the ends trimmed and each run of whitespace read as one space', async (t) => {
  const page = await locatorsPage(t)
  assert.deepEqual(await texts(page, byRole('button', 'Save draft')), ['  Save\n    draft  '])
  assert.deepEqual(await texts(page, byRole('button', '  Save \n\t draft ')), ['  Save\n    draft  '])
  assert.deepEqual(await texts(page, byRole('button', 'Archive   task')), ['archive'])
})

test('role leaves out elements that are aria-hidden, not displayed, hidden, invisible or inert', async (t) => {
  const page = await locatorsPage(t)
  assert.deepEqual(await observe(page, byRole('button', 'Delete')), observationOf([{ text: 'shown', visible: true }]))
  assertOk(await click(page, byRole('button', 'Delete')))
})

test('a name is passed to the page as a value, never read as code', async (t) => {
  const page = await locatorsPage(t)
  const tricky = `It's "quoted" \\ text`
  assert.deepEqual(await texts(page, byRole('button', tricky)), ['quoted'])
  assert.deepEqual(await texts(page, byText(tricky)), [tricky])
})

test('role without a name finds every element with it, and a role Chrome names its own way is found by its WAI-ARIA name', async (t) => {
  const page = await locatorsPage(t)
  const listItems = await observe(page, byRole('listitem'))
  assert.equal(listItems.count, ROW_COUNT)
  // Each lookup is a subtest, so one an engine answers differently does not hide the others.
  for (const [role, name] of [['img', 'Logo'], ['img', 'Badge'], ['math', 'Formula'], ['heading', 'Locators']] as const) {
    await t.test(`${role} ${name}`, async (each) => {
      const looked = await page.execute({ kind: 'observe', locator: byRole(role, name) }, 2000)
      engineCase.assertOutcome(each, looked.ok && looked.kind === 'observe' ? { count: looked.observation.count } : looked, { count: 1 })
    })
  }
})

test('role stays in the document itself, out of shadow roots and frames, as test id and text do', async (t) => {
  const page = await locatorsPage(t)
  assert.deepEqual(await texts(page, byRole('button', 'tree', false)), ['one', 'three'])
  assert.equal((await observe(page, byRole('button', 'Tree two'))).count, 0)
})

test('an observation lists at most its limit of matches and says when more matched', async (t) => {
  const page = await locatorsPage(t)
  for (const locator of [byRole('listitem'), byText('Row')]) {
    const rows = await observe(page, locator)
    assert.equal(rows.count, ROW_COUNT)
    assert.equal(rows.items.length, observedItemLimit)
    assert.equal(rows.itemsTruncated, true)
    assert.deepEqual([rows.visible, rows.text, rows.value], [null, null, null])
  }
})

test('label finds a form control by each source of its name, and reads its value', async (t) => {
  const page = await locatorsPage(t)
  const values: [string, string][] = [
    ['Email', 'email by label for'],
    ['Full name', 'name by wrapping label'],
    ['Search tasks', 'search by title'],
    ['City', 'city by placeholder'],
    ['Phone', 'phone by aria-label'],
    ['Notes', 'notes by aria-labelledby'],
    ['Size', 'Large'],
    ['I agree', 'on'],
  ]
  for (const [label, value] of values) {
    const observation = await observe(page, byLabel(label))
    assert.equal(observation.count, 1, label)
    assert.equal(observation.value, value, label)
  }
})

test('label matches only form controls, never a button with the same name, and skips a hidden field', async (t) => {
  const page = await locatorsPage(t)
  assert.equal((await observe(page, byRole('button', 'Email'))).count, 1)
  assert.equal((await observe(page, byLabel('Email'))).value, 'email by label for')
  assert.equal((await observe(page, byLabel('Hidden field'))).count, 0)
})

test('label follows the same exact rule: case and whole name, or any part in any case', async (t) => {
  const page = await locatorsPage(t)
  assert.equal((await observe(page, byLabel('email'))).value, 'email in lower case')
  const both = await observe(page, byLabel('EMAIL', false))
  assert.equal(both.count, 2)
  const { value: result, ms } = await timed(fill(page, byLabel('EMAIL', false), 'new@example.test', 5000))
  const failure = failureOf(result)
  assert.equal(failure.class, 'ambiguous')
  assert.equal(failure.message, "Could not fill getByLabel('EMAIL', { exact: false }): it matches 2 elements, and a locator must match exactly one. Retest did not fill any of them.")
  assert.ok(ms < 1000, `ambiguity should fail at once, took ${ms} ms`)
  assert.equal((await observe(page, byLabel('Email'))).value, 'email by label for')
})

test('text finds the innermost elements whose whole text matches', async (t) => {
  const page = await locatorsPage(t)
  assert.deepEqual(await texts(page, byText('Welcome back')), ['Welcome back'])
  assert.deepEqual(await texts(page, byText('Plan pro')), ['Plan pro'])
  assert.deepEqual(await texts(page, byText('pro')), ['pro'])
  assert.deepEqual(await texts(page, byText('Release notes')), ['Release notes'])
  assert.deepEqual(await texts(page, byText('notes')), ['notes'])
  assert.deepEqual(await texts(page, byText('Ship it')), ['  Ship\n    it  '])
})

test('text skips script, style, template and noscript content', async (t) => {
  const page = await locatorsPage(t)
  assert.equal((await observe(page, byText('Welcome back'))).count, 1)
  assert.equal((await observe(page, byText('/* Welcome back */'))).count, 0)
})

test('text with exact: false matches any part in any case, and keeps only the innermost match', async (t) => {
  const page = await locatorsPage(t)
  assert.deepEqual(await texts(page, byText('PLAN', false)), ['Plan'])
  assert.deepEqual(await texts(page, byText('welcome', false)), ['Welcome back'])
  assert.deepEqual(await texts(page, byText('Welcome', true)), [])
})

test('text finds hidden elements too, and reports them as not visible', async (t) => {
  const page = await locatorsPage(t)
  assert.deepEqual(await observe(page, byText('Hidden note')), observationOf([{ text: 'Hidden note', visible: false }]))
})

test('text stays in the document itself, out of shadow roots and frames', async (t) => {
  const page = await locatorsPage(t)
  assert.equal((await observe(page, byText('two'))).count, 0)
  assert.equal((await observe(page, byText('Framed text'))).count, 0)
})

test('a locator resolves afresh for every command, so a changed name is found by its new name', async (t) => {
  const page = await locatorsPage(t)
  assertOk(await click(page, byRole('button', 'Start')))
  await observeUntil(page, byRole('button', 'Stop'), (seen) => seen.count === 1)
  assert.equal((await observe(page, byRole('button', 'Start'))).count, 0)
})

test('a role that matches more than one element fails an action at once', async (t) => {
  const page = await locatorsPage(t)
  const { value: result, ms } = await timed(click(page, byRole('button', 'save', false), 5000))
  const failure = failureOf(result)
  assert.equal(failure.class, 'ambiguous')
  assert.deepEqual(failure.details, { count: 3 })
  assert.match(failure.message, /^Could not click getByRole\('button', \{ name: 'save', exact: false \}\): it matches 3 elements/)
  assert.ok(ms < 1000, `took ${ms} ms`)
})

test('the task page can be driven by role, label and text alone', async (t) => {
  const app = await openApp(t)
  const page = await openPage(t, browser(), app.url)
  assertOk(await goto(page, '/'))
  assertOk(await fill(page, byLabel('Title'), 'Release checklist'))
  assertOk(await click(page, byRole('button', 'Save')))
  await observeUntil(page, byText('Release checklist'), (seen) => seen.count === 1 && seen.visible === true)
  assert.equal((await observe(page, byLabel('Title'))).value, 'Release checklist')
  assert.equal(app.submissions(), 1)
})

test('an action on a locator that matches nothing fails as not found when the time runs out', async (t) => {
  const page = await locatorsPage(t)
  for (const locator of [byRole('button', 'Missing'), byLabel('Missing'), byText('Missing')]) {
    const failure = failureOf(await click(page, locator, 300))
    assert.equal(failure.class, 'not_found')
    assert.match(failure.message, /no element matched within 300 ms/)
  }
})

// Assertions may look together. A look that shared its document with another once lost elements on WebKit, whose every
// fresh reading of a document cancelled the node ids the other look was still using: 400 buttons were counted as 0,
// 100, 200 or 300, or the look failed outright.
const manyButtons = 400

async function counts(page: OwnedPage, locators: readonly LocatorRecipe[], pauseMs: number): Promise<number[]> {
  const looks: Promise<number>[] = []
  for (const [index, locator] of locators.entries()) {
    if (index > 0 && pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs))
    looks.push(page.execute({ kind: 'observe', locator }, 10_000).then((result) => {
      assert.ok(result.ok && result.kind === 'observe', JSON.stringify(result))
      return result.observation.count
    }))
  }
  return Promise.all(looks)
}

test('two or three looks at once, started together or a few milliseconds apart, each count every one of hundreds of matches', async (t) => {
  const buttons = Array.from({ length: manyButtons }, (_, index) => `<button>Item ${index}</button><span>filler ${index}</span>`).join('')
  const site = await servePages(t, { '/': `<!doctype html><title>Many</title><body>${buttons}</body>` })
  const page = await openPage(t, browser(), site.url)
  assertOk(await goto(page, '/'))
  const all = byRole('button')
  const last = byRole('button', `Item ${manyButtons - 1}`)
  const named = byRole('button', 'item', false)
  for (const pauseMs of [0, 0, 0, 1, 2, 5, 8, 12, 16, 20, 30, 50]) {
    assert.deepEqual(await counts(page, [all, last], pauseMs), [manyButtons, 1], `two looks ${pauseMs} ms apart`)
    assert.deepEqual(await counts(page, [all, last, named], pauseMs), [manyButtons, 1, manyButtons], `three looks ${pauseMs} ms apart`)
  }
})
