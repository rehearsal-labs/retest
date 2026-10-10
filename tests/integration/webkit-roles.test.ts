import type { TestContext } from 'node:test'
import type { OwnedBrowser, OwnedPage } from '../../src/browser/contract.ts'
import type { AriaRole } from '../../src/protocol/aria-role.ts'
import type { CommandResult } from '../../src/protocol/commands.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { labelledRoles } from '../../src/browser/accessibility.ts'
import { launchBrowser } from '../../src/browser/launch.ts'
import { launchWebKit } from '../../src/browser/webkit/browser.ts'
import { ariaRoles } from '../../src/protocol/aria-role.ts'
import { describeLocator } from '../../src/protocol/locator.ts'
import { browserPath, closeMs, scratchFolder, servePages, setupMs } from './browser-harness.ts'
import { webKitPath } from './engines.ts'

// Role membership on Chrome and WebKit, read side by side: each element kind the WebKit review and its fix read, on a
// page of its own, looked up by every ARIA role without a name, and the named and label lookups of the review's probes.
// For every lookup WebKit answers exactly what Chrome answers, or refuses it by name; it never answers a different set.
// Chrome is the reference, read live from the test browser, so a Chrome that changes what it answers changes the table.

type Case = { readonly html: string; readonly named?: readonly (readonly [AriaRole, string])[]; readonly labels?: readonly string[] }

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

const cases: readonly Case[] = [
  // Images and drawings.
  { html: '<img src="data:," width="5" height="5">' },
  { html: '<img src="/pixel.png" width="20" height="20">' },
  { html: '<img src="/pixel.png" width="20" height="20" title="Titled">', named: [['img', 'Titled']] },
  { html: '<img src="/pixel.png" width="20" height="20" aria-label="Labelled">', named: [['img', 'Labelled']] },
  { html: '<img src="/pixel.png" width="20" height="20" alt="">' },
  { html: '<img src="/pixel.png" width="20" height="20" alt="Alt">', named: [['img', 'Alt']] },
  { html: '<img src="/pixel.png" width="2" height="2">' },
  { html: '<img src="/missing.png" width="20" height="20">' },
  { html: '<img src="/pixel.png" width="20" height="20" aria-hidden="true">' },
  { html: '<img src="/pixel.png" width="20" height="20" role="presentation">' },
  { html: '<img src="/pixel.png" width="20" height="20" style="display:none">' },
  { html: '<a href="/x"><img src="/pixel.png" width="20" height="20"></a>' },
  { html: '<picture><img src="/pixel.png" alt="Pic"></picture>', named: [['img', 'Pic']] },
  { html: '<svg width="10" height="10"><rect width="5" height="5"/></svg>' },
  { html: '<svg width="10" height="10" aria-label="Pic"><rect width="5" height="5"/></svg>', named: [['img', 'Pic']] },
  { html: '<svg width="10" height="10" aria-hidden="true"><rect width="5" height="5"/></svg>' },
  { html: '<svg width="10" height="10" role="img" aria-label="Chart"><rect width="5" height="5"/></svg>', named: [['img', 'Chart']] },
  { html: '<button><svg width="10" height="10"><rect width="5" height="5"/></svg>Icon</button>', named: [['button', 'Icon']] },
  { html: '<div aria-hidden="true"><svg width="10" height="10"><rect width="5" height="5"/></svg></div>' },
  { html: '<svg width="10" height="10"><title>Titled svg</title><rect width="5" height="5"/></svg>' },
  { html: '<span role="img" aria-label="Star">*</span>', named: [['img', 'Star']] },
  { html: '<div role="img"></div>' },
  { html: '<object data="/pixel.png" type="image/png" width="10" height="10"></object>' },
  { html: '<canvas width="10" height="10"></canvas>' },
  // Text fields, suggestion lists, dates and editable elements.
  { html: '<input list="dl" aria-label="Pick"><datalist id="dl"><option>a</option></datalist>', named: [['combobox', 'Pick'], ['textbox', 'Pick']], labels: ['Pick'] },
  { html: '<input list="nowhere" aria-label="Pick">', named: [['textbox', 'Pick']] },
  { html: '<input type="search" list="dl" aria-label="Pick"><datalist id="dl"><option>a</option></datalist>', named: [['combobox', 'Pick']] },
  { html: '<input type="email" list="dl" aria-label="Pick"><datalist id="dl"><option>a</option></datalist>' },
  { html: '<input type="url" list="dl" aria-label="Pick"><datalist id="dl"><option>a</option></datalist>' },
  { html: '<input type="tel" list="dl" aria-label="Pick"><datalist id="dl"><option>a</option></datalist>' },
  { html: '<input type="number" list="dl" aria-label="Pick"><datalist id="dl"><option>1</option></datalist>', named: [['combobox', 'Pick'], ['spinbutton', 'Pick']] },
  { html: '<input type="range" list="dl" aria-label="Pick"><datalist id="dl"><option>1</option></datalist>' },
  { html: '<input type="date" list="dl" aria-label="Pick"><datalist id="dl"><option>2020-01-01</option></datalist>' },
  { html: '<input type="time" list="dl" aria-label="Pick"><datalist id="dl"><option>10:00</option></datalist>' },
  { html: '<input type="datetime-local" list="dl" aria-label="Pick"><datalist id="dl"><option>a</option></datalist>' },
  { html: '<input type="month" list="dl" aria-label="Pick"><datalist id="dl"><option>a</option></datalist>' },
  { html: '<input type="week" list="dl" aria-label="Pick"><datalist id="dl"><option>a</option></datalist>' },
  { html: '<input type="color" list="dl" aria-label="Pick"><datalist id="dl"><option>#ff0000</option></datalist>' },
  { html: '<input type="password" list="dl" aria-label="Pick"><datalist id="dl"><option>a</option></datalist>' },
  { html: '<input type="checkbox" list="dl" aria-label="Pick"><datalist id="dl"><option>a</option></datalist>' },
  { html: '<input list="dl" aria-label="Pick" role="textbox"><datalist id="dl"><option>a</option></datalist>' },
  { html: '<input type="date" aria-label="When">', named: [['textbox', 'When']], labels: ['When'] },
  { html: '<input type="time" aria-label="When">' },
  { html: '<input type="datetime-local" aria-label="When">' },
  { html: '<input type="month" aria-label="When">' },
  { html: '<input type="week" aria-label="When">' },
  { html: '<input type="DATE" aria-label="When">' },
  { html: '<input type="date" aria-label="When" readonly>' },
  { html: '<input type="date" role="textbox" aria-label="When">', named: [['textbox', 'When']] },
  { html: '<input type="color" aria-label="Colour">', named: [['button', 'Colour']] },
  { html: '<input type="file" aria-label="Upload file">', named: [['button', 'Upload file']] },
  { html: '<input type="hidden" aria-label="Hid">' },
  { html: '<div contenteditable="true" aria-label="Editable"></div>', named: [['textbox', 'Editable']], labels: ['Editable'] },
  { html: '<p contenteditable="true" aria-label="Editable">para</p>' },
  { html: '<span contenteditable="true" aria-label="Editable">span</span>' },
  { html: '<div contenteditable="plaintext-only" aria-label="Editable"></div>' },
  { html: '<div contenteditable="true" aria-label="Editable"><p>Inner para</p><b>bold</b><ul><li>item</li></ul></div>' },
  { html: '<h1 contenteditable="true">Editable head</h1>', named: [['heading', 'Editable head']] },
  { html: '<ul><li contenteditable="true">Editable item</li></ul>' },
  { html: '<div contenteditable="true" role="textbox" aria-label="Rich"></div>', named: [['textbox', 'Rich']] },
  { html: '<div contenteditable="false" aria-label="Not editable">x</div>' },
  { html: '<div contenteditable="" aria-label="Empty attr"></div>' },
  { html: '<div contenteditable="true"><span contenteditable="false">Locked</span></div>' },
  { html: '<textarea placeholder="Write"></textarea>', named: [['textbox', 'Write']] },
  { html: '<div style="display:none"><label for="h">Hidden label</label></div><input id="h">', named: [['textbox', 'Hidden label']], labels: ['Hidden label'] },
  { html: '<label for="h" style="display:none">Hidden label</label><input id="h" placeholder="Holder">', named: [['textbox', 'Hidden label'], ['textbox', 'Holder']] },
  { html: '<label for="h">Shown label</label><input id="h">', named: [['textbox', 'Shown label']], labels: ['Shown label'] },
  { html: '<label for="h" style="display:none">Hidden label</label><input id="h"><label for="v">Shown label</label><input id="v">', named: [['textbox', 'Shown label'], ['textbox', 'Hidden label']], labels: ['Shown label', 'Hidden label'] },
  { html: '<label>Name <input></label>', labels: ['Name'] },
  // Options, lists and their contexts.
  { html: '<div role="option" aria-selected="true">Lone option</div>', named: [['option', 'Lone option']] },
  { html: '<div role="listbox" aria-label="LB"><div role="option">In listbox</div></div>', named: [['option', 'In listbox']] },
  { html: '<div role="listbox" aria-label="LB"><div role="group"><div role="option">In group</div></div></div>' },
  { html: '<div role="listbox" aria-label="LB"><div><div role="option">In div</div></div></div>' },
  { html: '<div role="combobox" aria-expanded="true" aria-controls="lb2" aria-label="C"></div><div id="lb2" role="listbox"><div role="option">Popup</div></div>' },
  { html: '<div role="menu"><div role="option">In menu</div></div>' },
  { html: '<div role="tree"><div role="option">In tree</div></div>' },
  { html: '<div role="group"><div role="option">In bare group</div></div>' },
  { html: '<div role="combobox" aria-label="C"><div role="option">In combobox</div></div>' },
  { html: '<div role="listbox" aria-label="L"><div role="option" aria-label="Labelled option">x</div></div>', named: [['option', 'Labelled option']] },
  { html: '<select aria-label="S"><option>One</option><option>Two</option></select>', named: [['option', 'One'], ['combobox', 'S']] },
  { html: '<select size="3" aria-label="S"><option>One</option><option>Two</option></select>', named: [['listbox', 'S']] },
  { html: '<select multiple aria-label="S"><option>One</option><option>Two</option></select>' },
  { html: '<select aria-label="S"><optgroup label="G"><option>One</option></optgroup></select>' },
  {
    html: '<select aria-label="S"><option label="Lab">Text</option><option aria-label="Aria">Text2</option><option title="Tit">Text3</option></select><div role="listbox" aria-label="L"><div role="option">Custom</div></div>',
    named: [['option', 'Lab'], ['option', 'Text'], ['option', 'Aria'], ['option', 'Text2'], ['option', 'Tit'], ['option', 'Text3'], ['option', 'Custom']],
  },
  { html: '<div role="treeitem">Lone treeitem</div>' },
  { html: '<div role="tab">Lone tab</div>' },
  { html: '<div role="listitem">Lone listitem</div>' },
  { html: '<ul role="list"><li>Listed</li></ul>' },
  { html: '<ul><li>One</li></ul><ol><li>Two</li></ol>' },
  { html: '<menu><li>M</li></menu>' },
  // Tables, grids and what Chrome names from text.
  { html: '<table><tr><th>Head</th></tr><tr><td>Cell</td></tr></table>', named: [['cell', 'Cell'], ['columnheader', 'Head']] },
  { html: '<table><tr><th aria-label="Head A">Head</th></tr><tr><td aria-label="Cell A">Cell</td></tr></table>', named: [['cell', 'Cell A'], ['columnheader', 'Head A']] },
  { html: '<table><caption>Cap</caption><tr><td>c</td></tr></table>' },
  { html: '<table role="presentation"><tr><td>Layout</td></tr></table>' },
  { html: '<table aria-label="T"><tr><td>c</td></tr></table>', named: [['table', 'T'], ['cell', 'c']] },
  { html: '<div role="grid"><div role="row"><div role="gridcell">G</div></div></div>', named: [['gridcell', 'G']] },
  { html: '<div role="cell">Lone cell</div>' },
  { html: '<div role="row"><div role="cell">Row cell</div></div>' },
  { html: '<div role="table"><div role="row"><div role="cell">Table cell</div></div></div>' },
  { html: '<div role="row">Lone row</div>' },
  { html: '<div role="columnheader">Lone header</div><div role="rowheader">Lone row header</div>' },
  { html: '<div role="gridcell">Lone gridcell</div>' },
  { html: '<div role="tooltip">Tip</div>', named: [['tooltip', 'Tip']] },
  { html: '<div role="tooltip" aria-label="Tip A">Tip</div>', named: [['tooltip', 'Tip A']] },
  // Text-level and sectioning elements.
  { html: '<abbr title="Title text">TT</abbr>' },
  { html: '<div>Plain div</div>' },
  { html: '<span>Plain span</span>' },
  { html: '<div title="Titled div">Titled</div>' },
  { html: '<b>Bold</b><strong>Strong</strong><em>Em</em><code>Code</code><del>Del</del><ins>Ins</ins><sub>Sub</sub><sup>Sup</sup>' },
  { html: '<div aria-hidden="true"><em>Em</em><strong>Strong</strong></div>' },
  { html: '<em style="display:none">Em</em>' },
  { html: '<p>Para <em>em</em></p>' },
  { html: '<time datetime="2020-01-01">Jan</time>' },
  { html: '<blockquote>Quote</blockquote><q>Q</q>' },
  { html: '<dl><dt>Term</dt><dd>Def</dd></dl>' },
  { html: '<address>Addr</address>' },
  { html: '<section>Unnamed section</section>' },
  { html: '<section aria-label="Sec">Named section</section>', named: [['region', 'Sec']] },
  { html: '<form><input aria-label="u"></form>' },
  { html: '<form aria-label="F"><input aria-label="u"></form>', named: [['form', 'F']] },
  { html: '<search><input aria-label="u"></search>' },
  { html: '<math><mi>x</mi></math>' },
  { html: '<figure><figcaption>Cap</figcaption></figure>' },
  { html: '<figure><img alt="A" src="/pixel.png"><figcaption>Fig cap</figcaption></figure>' },
  { html: '<hgroup><h1>H</h1><p>P</p></hgroup>' },
  { html: '<hgroup aria-hidden="true"><h1>H</h1></hgroup>' },
  { html: '<dialog open>D</dialog>' },
  { html: '<article>Art</article><aside>Side</aside><nav>Nav</nav><main>Main</main><header>Head</header><footer>Foot</footer>' },
  { html: '<details open><summary>Sum</summary>Body</details>' },
  { html: '<details><summary>Det sum</summary>x</details>' },
  { html: '<fieldset><legend>Legend</legend><input aria-label="x"></fieldset>', named: [['group', 'Legend']] },
  { html: '<progress value="1" max="2"></progress><meter value="0.5"></meter><output>5</output>' },
  { html: '<video controls width="10" height="10"></video><audio controls></audio>' },
  { html: '<iframe srcdoc="<p>x</p>" width="20" height="20"></iframe>' },
  { html: '<a href="/x">Link</a><a>No href</a>', named: [['link', 'Link']] },
  { html: '<div role="none">None div</div><div role="presentation">Pres div</div>' },
  { html: '<p>Para</p><h1>Head</h1>' },
  // Controls.
  { html: '<textarea aria-label="T"></textarea><input type="checkbox" aria-label="C"><input type="radio" aria-label="R">' },
  { html: '<input type="number" aria-label="N"><input type="range" aria-label="R">', named: [['spinbutton', 'N'], ['slider', 'R']] },
  { html: '<input type="search" aria-label="S"><input type="password" aria-label="P">', named: [['searchbox', 'S'], ['textbox', 'P']] },
  { html: '<input type="submit"><input type="reset"><input type="button" value="B"><input type="image" alt="I" src="/pixel.png">' },
  { html: '<button aria-pressed="true">Bold</button><div role="button" aria-pressed="false">Italic</div>', named: [['button', 'Bold'], ['button', 'Italic']] },
  { html: '<button role="presentation">Pres button</button><a href="/x" role="none">Role none link</a>', named: [['button', 'Pres button'], ['link', 'Role none link']] },
  { html: '<div role="separator"></div><hr aria-hidden="true"><hr>' },
  { html: '<div role="radiogroup" aria-label="RG"><input type="radio" aria-label="A"></div>' },
  { html: '<div role="toolbar" aria-label="TB"><button>B</button></div>' },
  { html: '<div role="switch" aria-checked="true" aria-label="Sw"></div><input type="checkbox" role="switch" aria-label="Wifi">' },
  { html: '<div role="menuitemcheckbox" aria-checked="true">MC</div><div role="menuitemradio" aria-checked="true">MR</div><div role="menuitem">Lone menuitem</div>' },
  { html: '<div role="combobox" aria-label="Combo" aria-expanded="false" tabindex="0"></div><div role="searchbox" aria-label="Look"></div>' },
  { html: '<div role="treegrid" aria-label="TG"></div><div role="heading">No level</div><h3 aria-level="5">Levelled</h3>' },
  { html: '<label><input type="checkbox"> Wrapped box</label>', named: [['checkbox', 'Wrapped box']], labels: ['Wrapped box'] },
]

// The review's page of accessible names: 45 lookups by name, each found on both engines or on neither.
const namesPage = `<input type="submit" value="Send">
<button aria-label="Close" title="Dismiss">X</button>
<input aria-labelledby="l1" aria-label="Ignored"><span id="l1">Email address</span>
<label>Full name <input></label>
<input placeholder="Search here">
<input title="Phone number">
<a href="/x"><img alt="Home page" src="/pixel.png"></a>
<fieldset><legend>Shipping</legend><input aria-label="zip"></fieldset>
<button><span aria-hidden="true">*</span> Star it</button>
<h2>Title <small>sub</small></h2>
<input type="checkbox" id="c"><label for="c">Agree to terms</label>
<div role="button" aria-labelledby="h1 h2" tabindex="0">ignored text</div><span id="h1">Hello</span><span id="h2">World</span>
<input type="image" alt="Go now" src="/pixel.png">
<figure><img alt="pic" src="/pixel.png"><figcaption>Figure one</figcaption></figure>
<a href="/y">  Read   more  </a>
<label for="n">Count</label><input type="number" id="n">
<progress aria-label="Upload" value="3" max="10"></progress>
<nav aria-label="Main menu"><a href="/z">z</a></nav>
<button><svg width="10" height="10"><title>Delete item</title></svg></button>
<input type="radio" name="r" id="r1"><label for="r1">Option one</label>
<button id="self" aria-labelledby="self lab">Shut</button><span id="lab">window</span>
<style>.gen::before{content:'Add row'}</style><button class="gen"></button>
<input type="text" value="prefilled" aria-label="Filled field">
<textarea aria-label="Notes"></textarea>
<label for="s">Size</label><select id="s"><option>S</option></select>
<input type="search" aria-label="Find">
<input type="range" aria-label="Volume">
<button disabled>Disabled one</button>
<button>  Mixed <b>bold</b>text</button>
<img alt="Logo mark" src="/pixel.png" width="10" height="10">
<button aria-describedby="d">Described</button><span id="d">desc</span>
<input id="multi"><label for="multi">First</label><label for="multi">Second</label>
<button title="Only title"></button>
<a href="/t" title="Link title"></a>
<ul><li>Plain item</li></ul>
<p>Para text</p>
<div role="alert">Alert text</div>
<div role="status">Status text</div>
<div role="article" aria-label="Story">s</div>
<section aria-label="Region one">r</section>
<form aria-label="Login form"><input aria-label="u"></form>
<div role="menu" aria-label="Actions"><div role="menuitem">Rename</div></div>
<div role="tablist"><div role="tab">First tab</div></div>
<div role="tabpanel" aria-label="Panel one">p</div>
<table aria-label="T"><tr><td>c</td></tr></table>`

const namesLookups: readonly (readonly [AriaRole, string])[] = [
  ['button', 'Send'], ['button', 'Close'], ['textbox', 'Email address'], ['textbox', 'Full name'], ['textbox', 'Search here'],
  ['textbox', 'Phone number'], ['link', 'Home page'], ['group', 'Shipping'], ['button', 'Star it'], ['heading', 'Title sub'],
  ['checkbox', 'Agree to terms'], ['button', 'Hello World'], ['button', 'Go now'], ['figure', 'Figure one'], ['link', 'Read more'],
  ['spinbutton', 'Count'], ['progressbar', 'Upload'], ['navigation', 'Main menu'], ['button', 'Delete item'], ['radio', 'Option one'],
  ['button', 'Shut window'], ['button', 'Add row'], ['textbox', 'Filled field'], ['textbox', 'Notes'], ['combobox', 'Size'],
  ['searchbox', 'Find'], ['slider', 'Volume'], ['button', 'Disabled one'], ['button', 'Mixed boldtext'], ['img', 'Logo mark'],
  ['button', 'Described'], ['textbox', 'First Second'], ['button', 'Only title'], ['link', 'Link title'], ['listitem', 'Plain item'],
  ['paragraph', 'Para text'], ['alert', 'Alert text'], ['status', 'Status text'], ['article', 'Story'], ['region', 'Region one'],
  ['form', 'Login form'], ['menuitem', 'Rename'], ['tab', 'First tab'], ['tabpanel', 'Panel one'], ['table', 'T'],
]

const allCases: readonly Case[] = [...cases, { html: namesPage, named: namesLookups }]

/** What one lookup answered: a count, or the class and named role of a failure. */
type Answer = { readonly count: number } | { readonly failure: string; readonly role: unknown; readonly message: string }

function answerOf(result: CommandResult): Answer {
  if (result.ok && result.kind === 'observe') return { count: result.observation.count }
  if (result.ok) return { failure: `unexpected ${result.kind}`, role: undefined, message: '' }
  return { failure: result.failure.class, role: result.failure.details?.['role'], message: result.failure.message }
}

/** Every lookup a case makes: each ARIA role with no name, then its named and label lookups. */
function lookupsOf(entry: Case): LocatorRecipe[] {
  return [
    ...ariaRoles.map((role): LocatorRecipe => ({ by: 'role', role })),
    ...(entry.named ?? []).map(([role, name]): LocatorRecipe => ({ by: 'role', role, name })),
    ...(entry.labels ?? []).map((text): LocatorRecipe => ({ by: 'label', text })),
  ]
}

async function serveCases(t: TestContext): Promise<string> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/pixel.png') {
      response.writeHead(200, { 'content-type': 'image/png' })
      response.end(pixel)
      return
    }
    const entry = allCases[Number(url.searchParams.get('case'))]
    response.writeHead(entry === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(entry === undefined ? 'Not found' : `<!doctype html><title>t</title><body>${entry.html}</body>`)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return `http://127.0.0.1:${address.port}/`
}

/** Opens each case on the browser and answers every lookup of it, the lookups of one case all at once. */
async function answersOn(page: OwnedPage, url: string): Promise<Answer[][]> {
  const table: Answer[][] = []
  for (const [index, entry] of allCases.entries()) {
    const opened = await page.execute({ kind: 'goto', url: `${url}?case=${index}` }, 5000)
    assert.ok(opened.ok, `case ${index}: ${JSON.stringify(opened)}`)
    table.push(await Promise.all(lookupsOf(entry).map(async (locator) => answerOf(await page.execute({ kind: 'observe', locator }, 10_000)))))
  }
  return table
}

async function opened(t: TestContext, browser: OwnedBrowser): Promise<OwnedPage> {
  t.after(() => browser.close(closeMs))
  const page = await browser.newPage({}, setupMs)
  t.after(() => page.dispose(closeMs))
  return page
}

if (process.platform !== 'darwin') {
  test('the role table of Chrome and WebKit', (t) => t.skip(`Retest runs WebKit on macOS only, and this host is ${process.platform}`))
} else {
  test("every lookup of every element kind read beside Chrome is answered on WebKit as Chrome answers it, or refused by name, never answered differently", async (t) => {
    const folder = await scratchFolder(t)
    const url = await serveCases(t)
    const chrome = await opened(t, await launchBrowser({ executablePath: browserPath(), logFile: join(folder, 'chrome.log'), headless: true }))
    const webkit = await opened(t, await launchWebKit({ buildPath: webKitPath(), buildSource: 'RETEST_TEST_WEBKIT', logFile: join(folder, 'webkit.log'), headless: true }, setupMs * 3))
    const expected = await answersOn(chrome, url)
    const seen = await answersOn(webkit, url)
    const differences: string[] = []
    const refusals = new Map<string, number>()
    let answered = 0
    let lookups = 0
    for (const [index, entry] of allCases.entries()) {
      for (const [at, locator] of lookupsOf(entry).entries()) {
        lookups += 1
        const reference = expected[index]?.[at]
        const answer = seen[index]?.[at]
        const where = `case ${index} ${JSON.stringify(entry.html.slice(0, 60))} ${describeLocator(locator)}`
        assert.ok(reference !== undefined && 'count' in reference, `Chrome answers ${where}: ${JSON.stringify(reference)}`)
        if (answer !== undefined && 'count' in answer && answer.count === reference.count) {
          answered += 1
          continue
        }
        const askedRoles = locator.by === 'role' ? [locator.role] : locator.by === 'label' ? labelledRoles : []
        const refusedRole = answer !== undefined && 'failure' in answer && answer.failure === 'unsupported' ? askedRoles.find((role) => role === answer.role) : undefined
        if (refusedRole !== undefined) {
          refusals.set(refusedRole, (refusals.get(refusedRole) ?? 0) + 1)
          continue
        }
        differences.push(`${where}: Chrome ${reference.count}, WebKit ${JSON.stringify(answer)}`)
      }
    }
    t.diagnostic(`${lookups} lookups in ${allCases.length} pages: ${answered} answered alike, ${lookups - answered - differences.length} refused by name on WebKit (${[...refusals].map(([role, count]) => `${role} ${count}`).join(', ')})`)
    assert.deepEqual(differences, [])
  })

  // Held from the WebKit lane's own record: the refusal by role took two lookups WebKit can answer exactly.
  test('a cell named by aria-label, a custom option on a page that also holds a select, and a field named by a shown label beside a hidden one, are answered on WebKit as Chrome answers them', async (t) => {
    const folder = await scratchFolder(t)
    const url = await serveCases(t)
    const chrome = await opened(t, await launchBrowser({ executablePath: browserPath(), logFile: join(folder, 'chrome.log'), headless: true }))
    const webkit = await opened(t, await launchWebKit({ buildPath: webKitPath(), buildSource: 'RETEST_TEST_WEBKIT', logFile: join(folder, 'webkit.log'), headless: true }, setupMs * 3))
    const cell = allCases.findIndex((entry) => entry.html.includes('aria-label="Cell A"'))
    const options = allCases.findIndex((entry) => entry.html.includes('option label="Lab"'))
    const labels = allCases.findIndex((entry) => entry.html.includes('<label for="v">Shown label</label>'))
    const exactLookups: readonly [number, LocatorRecipe][] = [
      [cell, { by: 'role', role: 'cell', name: 'Cell A' }],
      [cell, { by: 'role', role: 'columnheader', name: 'Head A' }],
      [options, { by: 'role', role: 'option', name: 'Custom' }],
      // A hidden label changes the name of its own control only, so a field named by a shown label is answered.
      [labels, { by: 'label', text: 'Shown label' }],
      [labels, { by: 'role', role: 'textbox', name: 'Shown label' }],
    ]
    for (const [index, locator] of exactLookups) {
      const answers: Answer[] = []
      for (const page of [chrome, webkit]) {
        assert.ok((await page.execute({ kind: 'goto', url: `${url}?case=${index}` }, 5000)).ok)
        answers.push(answerOf(await page.execute({ kind: 'observe', locator }, 10_000)))
      }
      assert.deepEqual(answers, [{ count: 1 }, { count: 1 }], describeLocator(locator))
    }
    // Where Chrome counts what WebKit cannot, the refusal stays.
    assert.ok((await webkit.execute({ kind: 'goto', url: `${url}?case=${options}` }, 5000)).ok)
    const all = answerOf(await webkit.execute({ kind: 'observe', locator: { by: 'role', role: 'option' } }, 10_000))
    assert.deepEqual('failure' in all ? [all.failure, all.role] : all, ['unsupported', 'option'])
    const named = answerOf(await webkit.execute({ kind: 'observe', locator: { by: 'role', role: 'option', name: 'Lab' } }, 10_000))
    assert.deepEqual('failure' in named ? [named.failure, named.role] : named, ['unsupported', 'option'], "a name one of the select's options carries")
  })

  test('fixed role and label contracts select the intended element and keep explicit refusal boundaries', async (t) => {
    const html = `<!doctype html>
      <button aria-label="Save task">chosen save</button><button aria-label="Discard task">decoy discard</button>
      <a href="/chosen" aria-label="Open task">chosen link</a><a href="/decoy" aria-label="Other task">decoy link</a>
      <h2 aria-label="Task heading">chosen heading</h2><h2 aria-label="Other heading">decoy heading</h2>
      <label for="chosen-field">Task title</label><input id="chosen-field" value="chosen title">
      <label for="decoy-field">Other title</label><input id="decoy-field" value="decoy title">
      <table><tr><th>Task</th><th>Other</th></tr><tr><td aria-label="Chosen cell">chosen cell</td><td aria-label="Other cell">decoy cell</td></tr></table>
      <div role="listbox"><div role="option" aria-label="Custom choice">chosen option</div></div>`
    const site = await servePages(t, { '/': html, '/native': html + '<select aria-label="Native choice"><option>Native one</option><option>Native two</option></select>' })
    const folder = await scratchFolder(t)
    const chrome = await opened(t, await launchBrowser({ executablePath: browserPath(), logFile: join(folder, 'fixed-chrome.log'), headless: true }))
    const other = await opened(t, await launchWebKit({ buildPath: webKitPath(), buildSource: 'RETEST_TEST_WEBKIT', logFile: join(folder, 'fixed-webkit.log'), headless: true }, setupMs * 3))
    const supported: readonly { locator: LocatorRecipe; text?: string; value?: string }[] = [
      { locator: { by: 'role', role: 'button', name: 'Save task' }, text: 'chosen save' },
      { locator: { by: 'role', role: 'link', name: 'Open task' }, text: 'chosen link' },
      { locator: { by: 'role', role: 'heading', name: 'Task heading' }, text: 'chosen heading' },
      { locator: { by: 'role', role: 'textbox', name: 'Task title' }, value: 'chosen title' },
      { locator: { by: 'label', text: 'Task title' }, value: 'chosen title' },
      { locator: { by: 'role', role: 'option', name: 'Custom choice' }, text: 'chosen option' },
      { locator: { by: 'role', role: 'cell', name: 'Chosen cell' }, text: 'chosen cell' },
    ]
    for (const page of [chrome, other]) {
      assert.ok((await page.execute({ kind: 'goto', url: site.url }, 5000)).ok)
      for (const row of supported) {
        const result = await page.execute({ kind: 'observe', locator: row.locator }, 10_000)
        assert.ok(result.ok && result.kind === 'observe', `${page === chrome ? 'Chrome' : 'WebKit'} ${describeLocator(row.locator)}: ${JSON.stringify(result)}`)
        assert.equal(result.observation.count, 1, describeLocator(row.locator))
        if (row.text !== undefined) assert.equal(result.observation.text, row.text, describeLocator(row.locator))
        if (row.value !== undefined) assert.equal(result.observation.value, row.value, describeLocator(row.locator))
      }
      const missing = await page.execute({ kind: 'observe', locator: { by: 'role', role: 'button', name: 'Missing task' } }, 10_000)
      assert.ok(missing.ok && missing.kind === 'observe')
      assert.equal(missing.observation.count, 0, 'a supported missing lookup is answered, not refused')
    }
    assert.ok((await other.execute({ kind: 'goto', url: `${site.url}/native` }, 5000)).ok)
    const refused: readonly LocatorRecipe[] = [
      { by: 'role', role: 'generic' },
      { by: 'role', role: 'option' },
      { by: 'role', role: 'option', name: 'Native one' },
    ]
    for (const locator of refused) {
      const result = await other.execute({ kind: 'observe', locator }, 10_000)
      assert.ok(!result.ok, `${describeLocator(locator)} must retain its explicit refusal`)
      assert.equal(result.failure.class, 'unsupported')
      assert.equal(result.failure.details?.['role'], locator.by === 'role' ? locator.role : undefined)
      assert.ok(result.failure.message.startsWith(`Could not look up ${describeLocator(locator)}: `))
    }
  })
}
