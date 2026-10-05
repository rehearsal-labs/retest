import type { TestContext } from 'node:test'
import type { ElementIdentity, OwnedBrowser, OwnedPage } from '../../src/browser/contract.ts'
import type { Observation } from '../../src/protocol/commands.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { hasElementIdentity } from '../../src/agent/identity.ts'
import { launch, observe, openPage, servePages } from './browser-harness.ts'
import { engineName, pinningEngines } from './agent-harness.ts'

// Element identity on a real browser, through the driver's page alone: the keyed read and the pinned dispatch the agent
// sessions consume (`ElementIdentity` in the browser contract). Every case asserts which engines offer it, so an engine
// that gains or loses it fails here, and a driver that does not offer it skips each case by name. The cases share one
// browser, launched and closed by the test that holds them.

const rows = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Rows</title></head>
<body>
<div data-testid="toolbar">
<button type="button" data-testid="save" onclick="fetch('/clicked/save', { method: 'POST' })">Save</button>
<button type="button" data-testid="cancel" onclick="fetch('/clicked/cancel', { method: 'POST' })">Cancel</button>
</div>
<div data-testid="row-1"><span>First</span> <button type="button" onclick="fetch('/clicked/delete-1', { method: 'POST' })">Delete</button> <input type="checkbox" aria-label="Done"> <select aria-label="Owner"><option>Ann</option><option>Bob</option></select></div>
<div data-testid="row-2"><span>Second</span> <button type="button" onclick="fetch('/clicked/delete-2', { method: 'POST' })">Delete</button> <input type="checkbox" aria-label="Done"> <select aria-label="Owner"><option>Ann</option><option>Bob</option></select></div>
<div data-testid="fields"><input data-testid="f-1"><input data-testid="f-2"><input data-testid="f-3"></div>
<button type="button" data-testid="sort-later" onclick="const box = document.querySelector('[data-testid=fields]'); for (const field of box.children) field.readOnly = true; setTimeout(() => { box.prepend(box.lastElementChild); for (const field of box.children) field.readOnly = false }, 1500)">Sort later</button>
</body></html>`

// Two checkboxes; clicking the second keeps it unchecked and moves it to the front, so the first, already checked, takes
// its place before Retest reads whether the click checked it.
const swapping = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Swapping</title></head>
<body>
<div data-testid="boxes"><label><input type="checkbox" data-testid="box-a" checked> A</label><label><input type="checkbox" data-testid="box-b" onclick="event.preventDefault(); const list = document.querySelector('[data-testid=boxes]'); list.prepend(list.lastElementChild)"> B</label></div>
</body></html>`

const deletes: LocatorRecipe = { by: 'role', role: 'button', name: 'Delete' }
const textboxes: LocatorRecipe = { by: 'css', selector: '[data-testid=fields] > input' }

// The page under test with its element identity, or undefined after skipping the case by name.
async function identityPage(t: TestContext, browser: OwnedBrowser, baseUrl: string): Promise<(OwnedPage & ElementIdentity) | undefined> {
  const page = await openPage(t, browser, baseUrl)
  assert.equal(hasElementIdentity(page), pinningEngines.has(engineName()), `the ${engineName()} page ${pinningEngines.has(engineName()) ? 'offers' : 'does not yet offer'} element identity`)
  if (hasElementIdentity(page)) return page
  t.skip(`the ${engineName()} driver offers no element identity yet`)
  return undefined
}

async function keysOf(page: ElementIdentity, locators: readonly LocatorRecipe[]): Promise<{ observation: Observation; keys: readonly string[] }[]> {
  const reading = await page.readElements(locators, 5000)
  assert.ok(reading.ok, reading.ok ? '' : reading.failure.message)
  return [...reading.reads]
}

async function posted(site: { posts(path: string): number }, path: string, count: number): Promise<void> {
  const deadline = performance.now() + 5000
  while (site.posts(path) < count) {
    if (performance.now() > deadline) assert.fail(`${path} was posted ${site.posts(path)} times, expected ${count}`)
    await sleep(20)
  }
}

test('element identity on a real page of the engine under test', async (outer) => {
  const browser = await launch(outer)
  await outer.test('a keyed read lists each locator as observe does, all at once, and keys each node alike in every read of its document', async (t) => {
    const site = await servePages(t, { '/': rows })
    const page = await identityPage(t, browser, site.url)
    if (page === undefined) return
    assert.ok((await page.execute({ kind: 'goto', url: '/' }, 10_000)).ok)
    const locators: LocatorRecipe[] = [{ by: 'role', role: 'button', within: [{ by: 'testId', value: 'toolbar' }] }, deletes, { ...deletes, within: [{ by: 'testId', value: 'row-2' }] }]
    const [toolbar, both, second] = await keysOf(page, locators)
    assert.ok(toolbar !== undefined && both !== undefined && second !== undefined)
    for (const [place, locator] of locators.entries()) assert.deepEqual((await keysOf(page, [locator]))[0]?.observation, await observe(page, locator), `read ${place} reads as observe does`)
    assert.deepEqual([toolbar.keys.length, both.keys.length, second.keys.length], [2, 2, 1], 'a key for each element listed')
    assert.equal(new Set([...toolbar.keys, ...both.keys]).size, 4, 'four nodes, four keys, two of them showing the same')
    assert.deepEqual(second.keys, [both.keys[1]], "the second row's Delete has one key in every locator that finds it")
    assert.deepEqual((await keysOf(page, locators)).map((read) => read.keys), [toolbar.keys, both.keys, second.keys], 'a later read keys each node alike')
  })

  await outer.test('an action pinned to one of two twins goes to that node; pinned to the other, it is refused as moved and sends nothing', async (t) => {
    const site = await servePages(t, { '/': rows })
    const page = await identityPage(t, browser, site.url)
    if (page === undefined) return
    assert.ok((await page.execute({ kind: 'goto', url: '/' }, 10_000)).ok)
    const [both] = await keysOf(page, [deletes])
    const [firstKey, secondKey] = both?.keys ?? []
    assert.ok(firstKey !== undefined && secondKey !== undefined)
    const clicked = await page.dispatchTo({ kind: 'click', locator: { ...deletes, pick: 1 } }, secondKey, 5000)
    assert.ok(clicked.result.ok, clicked.result.ok ? '' : clicked.result.failure.message)
    assert.equal(clicked.input, 'sent')
    await posted(site, '/clicked/delete-2', 1)
    const refused = await page.dispatchTo({ kind: 'click', locator: { ...deletes, pick: 0 } }, secondKey, 5000)
    assert.ok(!refused.result.ok)
    assert.equal(refused.result.failure.class, 'not_actionable', refused.result.failure.message)
    assert.deepEqual(refused.result.failure.details, { refused: 'moved', inputSent: false })
    assert.equal(refused.input, 'not_sent')
    await sleep(300)
    assert.deepEqual([site.posts('/clicked/delete-1'), site.posts('/clicked/delete-2')], [0, 1], 'only the pinned node took a click')
  })

  await outer.test('a pinned check and a pinned select reach their own row of two that show the same', async (t) => {
    const site = await servePages(t, { '/': rows })
    const page = await identityPage(t, browser, site.url)
    if (page === undefined) return
    assert.ok((await page.execute({ kind: 'goto', url: '/' }, 10_000)).ok)
    const boxes: LocatorRecipe = { by: 'css', selector: 'input[type=checkbox]' }
    const owners: LocatorRecipe = { by: 'css', selector: 'select' }
    const [checkKeys, selectKeys] = await keysOf(page, [boxes, owners])
    const checkKey = checkKeys?.keys[1]
    const selectKey = selectKeys?.keys[1]
    assert.ok(checkKey !== undefined && selectKey !== undefined)
    const checked = await page.dispatchTo({ kind: 'check', locator: { ...boxes, pick: 1 } }, checkKey, 5000)
    assert.ok(checked.result.ok, checked.result.ok ? '' : checked.result.failure.message)
    const selected = await page.dispatchTo({ kind: 'select', locator: { ...owners, pick: 1 }, choices: [{ label: 'Bob' }] }, selectKey, 5000)
    assert.ok(selected.result.ok, selected.result.ok ? '' : selected.result.failure.message)
    for (const [row, done, owner] of [['row-1', false, 'Ann'], ['row-2', true, 'Bob']] as const) {
      assert.equal((await observe(page, { by: 'css', selector: `[data-testid=${row}] input[type=checkbox]` })).checked, done, `${row} checked`)
      assert.equal((await observe(page, { by: 'css', selector: `[data-testid=${row}] select` })).value, owner, `${row} owner`)
    }
    const wrongBox = await page.dispatchTo({ kind: 'uncheck', locator: { ...boxes, pick: 0 } }, checkKey, 5000)
    assert.deepEqual([wrongBox.input, wrongBox.result.ok ? undefined : wrongBox.result.failure.details?.['refused']], ['not_sent', 'moved'])
  })

  await outer.test('a pinned check whose element the page moves before Retest reads its state is not confirmed by the element now in its place', async (t) => {
    const site = await servePages(t, { '/': swapping })
    const page = await identityPage(t, browser, site.url)
    if (page === undefined) return
    assert.ok((await page.execute({ kind: 'goto', url: '/' }, 10_000)).ok)
    const boxes: LocatorRecipe = { by: 'css', selector: '[data-testid=boxes] input' }
    const [read] = await keysOf(page, [boxes])
    const secondKey = read?.keys[1]
    assert.ok(secondKey !== undefined)
    const checked = await page.dispatchTo({ kind: 'check', locator: { ...boxes, pick: 1 } }, secondKey, 1500)
    assert.ok(!checked.result.ok, 'the check is not reported as done: the element now at its place is another one, checked already')
    assert.equal(checked.input, 'sent', 'the click went, to the pinned box')
    assert.equal(checked.result.failure.class, 'not_actionable', checked.result.failure.message)
    assert.deepEqual(checked.result.failure.details, { check: 'state', inputSent: true })
    assert.match(checked.result.failure.message, /no longer found the element it clicked/)
    assert.equal((await observe(page, { by: 'testId', value: 'box-b' })).checked, false, 'the pinned box stayed unchecked')
    assert.equal((await observe(page, { by: 'testId', value: 'box-a' })).checked, true)
  })

  await outer.test('fields put in another order while a pinned fill waits for its field are refused as moved, and nothing is typed', async (t) => {
    const site = await servePages(t, { '/': rows })
    const page = await identityPage(t, browser, site.url)
    if (page === undefined) return
    assert.ok((await page.execute({ kind: 'goto', url: '/' }, 10_000)).ok)
    assert.ok((await page.execute({ kind: 'click', locator: { by: 'testId', value: 'sort-later' } }, 5000)).ok)
    const [before] = await keysOf(page, [textboxes])
    const secondKey = before?.keys[1]
    assert.ok(before !== undefined && secondKey !== undefined)
    const typed = await page.dispatchTo({ kind: 'fill', locator: { ...textboxes, pick: 1 }, value: 'meant for f-2' }, secondKey, 5000)
    assert.ok(!typed.result.ok)
    assert.deepEqual([typed.result.failure.class, typed.result.failure.details, typed.input], ['not_actionable', { refused: 'moved', inputSent: false }, 'not_sent'], typed.result.failure.message)
    const [after] = await keysOf(page, [textboxes])
    assert.deepEqual(after?.keys, [before.keys[2], before.keys[0], before.keys[1]], 'the page sorted the fields after the first read, while the fill waited')
    for (const field of ['f-1', 'f-2', 'f-3']) assert.equal((await observe(page, { by: 'testId', value: field })).value, '', `${field} holds nothing`)
  })

  await outer.test('a key read in an earlier document names nothing in the next, even on the same page showing the same', async (t) => {
    const site = await servePages(t, { '/': rows })
    const page = await identityPage(t, browser, site.url)
    if (page === undefined) return
    const save: LocatorRecipe = { by: 'testId', value: 'save' }
    assert.ok((await page.execute({ kind: 'goto', url: '/' }, 10_000)).ok)
    const [earlier] = await keysOf(page, [save])
    const earlierKey = earlier?.keys[0]
    assert.ok(earlierKey !== undefined)
    assert.ok((await page.execute({ kind: 'reload' }, 10_000)).ok)
    // The new document keys the same button first, so the earlier key could only match it by naming another document's.
    const [now] = await keysOf(page, [save])
    const refused = await page.dispatchTo({ kind: 'click', locator: save }, earlierKey, 5000)
    assert.ok(!refused.result.ok)
    assert.deepEqual([refused.result.failure.details?.['refused'], refused.input], ['moved', 'not_sent'])
    assert.notEqual(now?.keys[0], earlierKey, 'the new document keys the same button anew')
    await sleep(300)
    assert.equal(site.posts('/clicked/save'), 0)
  })

  await outer.test('a pinned dispatch of a command that names no element is refused, and a keyed read names a selector the page cannot read', async (t) => {
    const site = await servePages(t, { '/': rows })
    const page = await identityPage(t, browser, site.url)
    if (page === undefined) return
    assert.ok((await page.execute({ kind: 'goto', url: '/' }, 10_000)).ok)
    const unpinnable = await page.dispatchTo({ kind: 'press', key: 'Enter' }, 'any-key', 5000)
    assert.deepEqual([unpinnable.input, unpinnable.result.ok ? undefined : unpinnable.result.failure.class], ['not_sent', 'usage'])
    const unreadable = await page.readElements([{ by: 'testId', value: 'save' }, { by: 'css', selector: '::nope' }], 5000)
    assert.ok(!unreadable.ok)
    assert.equal(unreadable.failure.class, 'usage')
    assert.match(unreadable.failure.message, /::nope/)
  })
})
