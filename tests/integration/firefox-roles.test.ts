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
import { firefoxPlatformProblem } from '../../src/browser/firefox/executable.ts'
import { launchFirefox } from '../../src/browser/firefox/launch.ts'
import { launchBrowser } from '../../src/browser/launch.ts'
import { ariaRoles } from '../../src/protocol/aria-role.ts'
import { describeLocator } from '../../src/protocol/locator.ts'
import { browserPath, closeMs, scratchFolder, setupMs } from './browser-harness.ts'
import { firefoxPath, testFirefoxRoute } from './engines.ts'

// Role membership and names on Chrome and Firefox, read side by side (review F-2): every element kind of the WebKit
// table, the review's probes and the cases Firefox's own differences call for, each on a page of its own, looked up by
// every ARIA role without a name, and by the names and labels each case names. For every lookup Firefox answers exactly
// what Chrome answers, or refuses it by name, naming the lookup and a role it asked for; it never answers a different
// set. Chrome is the reference, read live from the test browser, so a Chrome that changes what it answers changes the
// table.

type Named = readonly (readonly [AriaRole, string])[]
type Case = { readonly html: string; readonly named?: Named; readonly loose?: Named; readonly labels?: readonly string[] }

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

// The WebKit table's element kinds (`webkit-roles.test.ts`), unchanged.
const webKitCases: readonly Case[] = [
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

// The WebKit review's page of accessible names: 45 lookups by name.
const namesPage: Case = {
  html: `<input type="submit" value="Send">
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
<table aria-label="T"><tr><td>c</td></tr></table>`,
  named: [
    ['button', 'Send'], ['button', 'Close'], ['textbox', 'Email address'], ['textbox', 'Full name'], ['textbox', 'Search here'],
    ['textbox', 'Phone number'], ['link', 'Home page'], ['group', 'Shipping'], ['button', 'Star it'], ['heading', 'Title sub'],
    ['checkbox', 'Agree to terms'], ['button', 'Hello World'], ['button', 'Go now'], ['figure', 'Figure one'], ['link', 'Read more'],
    ['spinbutton', 'Count'], ['progressbar', 'Upload'], ['navigation', 'Main menu'], ['button', 'Delete item'], ['radio', 'Option one'],
    ['button', 'Shut window'], ['button', 'Add row'], ['textbox', 'Filled field'], ['textbox', 'Notes'], ['combobox', 'Size'],
    ['searchbox', 'Find'], ['slider', 'Volume'], ['button', 'Disabled one'], ['button', 'Mixed boldtext'], ['img', 'Logo mark'],
    ['button', 'Described'], ['textbox', 'First Second'], ['button', 'Only title'], ['link', 'Link title'], ['listitem', 'Plain item'],
    ['paragraph', 'Para text'], ['alert', 'Alert text'], ['status', 'Status text'], ['article', 'Story'], ['region', 'Region one'],
    ['form', 'Login form'], ['menuitem', 'Rename'], ['tab', 'First tab'], ['tabpanel', 'Panel one'], ['table', 'T'],
  ],
}

// The Firefox review's probe 1: names with odd spacing, password fields and their labels, on one page.
const reviewNamesPage: Case = {
  html: `<button aria-label=" Save ">a</button>
<button aria-label="Save  draft">b</button>
<button aria-label="Save&nbsp;now">c</button>
<button title="  Tip  "></button>
<button>  Go
   now </button>
<input type="checkbox" aria-label="Agree  terms">
<input type="text" aria-label="Email ">
<label for="pw">Password <span aria-hidden="true">*</span></label><input id="pw" type="password">
<label for="pw2">Secret<span style="display:none">Hidden</span></label><input id="pw2" type="password">
<input type="password" title="" placeholder="PIN">
<label for="tx">Login <span aria-hidden="true">*</span></label><input id="tx" type="text">
<a href="#x" aria-label="Home&#9;page">h</a>
<button>Delete</button><button>Publish</button>`,
  named: [
    ['button', 'Save'], ['button', 'Save draft'], ['button', 'Save now'], ['button', 'Tip'], ['button', 'Go now'], ['checkbox', 'Agree terms'],
    ['textbox', 'Password'], ['textbox', 'PIN'], ['link', 'Home page'],
  ],
  labels: ['Email', 'Password', 'Password *', 'Secret', 'SecretHidden', 'Login'],
}

// The Firefox review's probe 4: element kinds, each with the lookups the review made of it.
const reviewKinds: readonly Case[] = [
  { html: '<img src="/pixel.png">' },
  { html: '<img src="/pixel.png" alt="">' },
  { html: '<input list="d"><datalist id="d"><option value="A"></option></datalist>' },
  { html: '<input aria-label="Pick" list="d2"><datalist id="d2"><option value="B"></option></datalist>', named: [['combobox', 'Pick'], ['textbox', 'Pick']] },
  { html: '<abbr title="x">X</abbr>' },
  { html: '<input type="date">' },
  { html: '<input type="time">' },
  { html: '<input type="color">' },
  { html: '<input type="file">' },
  { html: '<div contenteditable="true">x</div>' },
  { html: '<div role="option">x</div>' },
  { html: '<select><option>A</option><option>B</option></select>' },
  { html: '<select multiple><option>A</option><option>B</option></select>' },
  { html: '<input type="search">' },
  { html: '<input type="email"><input type="tel"><input type="url"><textarea></textarea>' },
  { html: '<input type="number"><input type="range">' },
  { html: '<details><summary>S</summary>D</details>' },
  { html: '<output>5</output><progress value="1" max="2"></progress><meter value="0.5"></meter>' },
  { html: '<header>H</header><footer>F</footer><nav>N</nav><main>M</main><aside>A</aside>' },
  { html: '<section>S</section>' },
  { html: '<section aria-label="Sec">S</section>', named: [['region', 'Sec']] },
  { html: '<form>F</form>' },
  { html: '<form aria-label="Fm">x</form>', named: [['form', 'Fm']] },
  { html: '<dl><dt>T</dt><dd>D</dd></dl>' },
  { html: '<table><caption>C</caption><thead><tr><th>H</th></tr></thead><tbody><tr><td>D</td></tr></tbody></table>', named: [['table', 'C'], ['columnheader', 'H']] },
  { html: '<table><tr><th scope="row">R</th><td>D</td></tr></table>', named: [['rowheader', 'R'], ['row', 'R D']] },
  { html: '<hr><fieldset><legend>L</legend>x</fieldset><figure><figcaption>C</figcaption></figure>', named: [['group', 'L'], ['figure', 'C']] },
  { html: '<a>no href</a>' },
  { html: '<a href="#a">Here</a>', named: [['link', 'Here']] },
  { html: '<svg role="img" aria-label="S" width="10" height="10"></svg>', named: [['img', 'S']] },
  { html: '<code>c</code><strong>s</strong><em>e</em><blockquote>q</blockquote><p>p</p>' },
  { html: '<math><mi>x</mi></math>' },
  { html: '<time>t</time><del>d</del><ins>i</ins><sub>b</sub><sup>p</sup>' },
  { html: '<input type="image" alt="Go" src="/pixel.png"><input type="reset"><input type="submit">', named: [['button', 'Go'], ['button', 'Reset'], ['button', 'Submit']] },
  { html: '<button aria-pressed="true">T</button><input type="checkbox" role="switch" aria-label="Sw">', named: [['button', 'T'], ['switch', 'Sw']] },
  { html: '<dialog open>d</dialog>' },
  { html: '<menu><li>a</li></menu><ul><li>b</li></ul><ol><li>c</li></ol>' },
  { html: '<address>a</address>' },
  { html: '<label style="display:none" for="h">Hidden</label><input id="h">', named: [['textbox', 'Hidden']] },
  { html: '<div role="textbox" aria-label="R"></div><div role="tooltip">tip</div><div role="gridcell">g</div>', named: [['textbox', 'R'], ['tooltip', 'tip']] },
  { html: '<button style="opacity:0">O</button><button style="visibility:hidden">V</button><div aria-hidden="true"><button>A</button></div><button inert>I</button>' },
  { html: '<h1>A</h1><div role="heading" aria-level="2">B</div><h6>C</h6>', named: [['heading', 'B']] },
  { html: '<div role="radiogroup" aria-label="G"><input type="radio" aria-label="r1"></div>', named: [['radiogroup', 'G'], ['radio', 'r1']] },
  { html: '<input type="text" title="Hint">', named: [['textbox', 'Hint']] },
  { html: '<input type="text" placeholder="Holder">', named: [['textbox', 'Holder']] },
  { html: '<button><img src="/pixel.png" alt="Icon"> Send</button>', named: [['button', 'Icon Send'], ['button', 'Send']] },
  { html: '<button>Pay<span style="display:none"> now</span></button>', named: [['button', 'Pay'], ['button', 'Pay now']] },
]

// The differences review F-2 named, and the cases around each that its settling depends on.
const firefoxCases: readonly Case[] = [
  // Names holding a no-break or other wide space, which Retest reads as one plain space on every engine.
  { html: '<button aria-label="Save&nbsp;now">c</button>', named: [['button', 'Save now'], ['button', 'Save now']], loose: [['button', 'save now']] },
  { html: '<button>Save&nbsp;now</button>', named: [['button', 'Save now']], loose: [['button', 'save now']] },
  { html: '<button aria-label="&nbsp;Pad&nbsp;">x</button>', named: [['button', 'Pad']] },
  { html: '<button title="Tip&#8195;text"></button>', named: [['button', 'Tip text']] },
  { html: '<button>Go&nbsp; &nbsp;home</button>', named: [['button', 'Go home']] },
  { html: '<button aria-label="Save&nbsp;now">x</button><button>Save now</button><button>Save&#12288;now</button><button>Save later</button>', named: [['button', 'Save now'], ['button', 'Save later']], loose: [['button', 'save']] },
  { html: '<img src="/pixel.png" width="20" height="20" alt="Alt&nbsp;text">', named: [['img', 'Alt text']] },
  { html: '<input type="submit" value="Send&nbsp;now">', named: [['button', 'Send now']] },
  { html: '<a href="/x">Read&#12288;more</a>', named: [['link', 'Read more']] },
  { html: '<span id="lb">Pick&#8239;one</span><div role="listbox" aria-labelledby="lb"></div>', named: [['listbox', 'Pick one']] },
  { html: '<label for="e">E&nbsp;mail</label><input id="e">', named: [['textbox', 'E mail']], labels: ['E mail'] },
  { html: '<input type="checkbox" aria-label="I&nbsp;agree">', named: [['checkbox', 'I agree']], labels: ['I agree'] },
  { html: '<h2>Big&nbsp;news</h2>', named: [['heading', 'Big news']] },
  { html: '<input placeholder="Your&nbsp;name">', named: [['textbox', 'Your name']] },
  { html: '<fieldset><legend>Ship&nbsp;to</legend><input aria-label="x"></fieldset>', named: [['group', 'Ship to']] },
  { html: '<button aria-label="Tab&#9;bed">x</button><button aria-label="Line&#10;break">y</button>', named: [['button', 'Tab bed'], ['button', 'Line break']] },
  // Password fields, which Firefox's locator never returns.
  { html: '<label for="pw">Password <span aria-hidden="true">*</span></label><input id="pw" type="password">', named: [['textbox', 'Password'], ['textbox', 'Password *']], loose: [['textbox', 'pass']], labels: ['Password', 'Password *'] },
  { html: '<label for="pw">Secret<span style="display:none">Hidden</span></label><input id="pw" type="password">', named: [['textbox', 'Secret'], ['textbox', 'SecretHidden']], labels: ['Secret', 'SecretHidden'] },
  { html: '<input type="password" title="" placeholder="PIN">', named: [['textbox', 'PIN'], ['textbox', '']], labels: ['PIN'] },
  { html: '<label for="pw">Code <span style="visibility:hidden">X</span></label><input id="pw" type="password">', named: [['textbox', 'Code'], ['textbox', 'Code X']], labels: ['Code'] },
  { html: '<span id="h" hidden>Hidden ref</span><input type="password" aria-labelledby="h">', named: [['textbox', 'Hidden ref']] },
  { html: '<span id="m">Main <span aria-hidden="true">x</span></span><input type="password" aria-labelledby="m">', named: [['textbox', 'Main'], ['textbox', 'Main x']] },
  { html: '<label>Pass <input type="password"></label>', named: [['textbox', 'Pass']], labels: ['Pass'] },
  { html: '<label for="pw">Key <input type="text" value="v"></label><input id="pw" type="password">', named: [['textbox', 'Key v'], ['textbox', 'Key']], labels: ['Key v'] },
  { html: '<input type="password" aria-label="  Spaced   out  ">', named: [['textbox', 'Spaced out']] },
  { html: '<label for="pw">Label</label><input id="pw" type="password" aria-label="">', named: [['textbox', 'Label']] },
  { html: '<input type="password" title="Tip">', named: [['textbox', 'Tip']] },
  { html: '<input type="password" placeholder="Holder">', named: [['textbox', 'Holder']], loose: [['textbox', 'hold']] },
  { html: '<input type="password" title="Tip" placeholder="Holder">', named: [['textbox', 'Tip'], ['textbox', 'Holder']] },
  { html: '<input type="password" aria-placeholder="Aria holder">', named: [['textbox', 'Aria holder']] },
  { html: '<input type="password" aria-label="Faded" style="opacity:0">', named: [['textbox', 'Faded']] },
  { html: '<div style="display:none"><input type="password" aria-label="Gone"></div>', named: [['textbox', 'Gone']] },
  { html: '<input type="password" aria-label="Unseen" style="visibility:hidden">', named: [['textbox', 'Unseen']] },
  { html: '<input type="password" aria-label="Muted" aria-hidden="true">', named: [['textbox', 'Muted']] },
  { html: '<input type="password" aria-label="Inert" inert>', named: [['textbox', 'Inert']] },
  { html: '<details><summary>More</summary><input type="password" aria-label="Folded"></details>', named: [['textbox', 'Folded']] },
  { html: '<label for="pw">A</label><label for="pw">B</label><input id="pw" type="password">', named: [['textbox', 'A B']], labels: ['A B'] },
  { html: '<label for="pw">Pass&nbsp;word</label><input id="pw" type="password">', named: [['textbox', 'Pass word']], labels: ['Pass word'] },
  { html: '<style>.req::after{content:" *"}</style><label for="pw" class="req">Required</label><input id="pw" type="password">', named: [['textbox', 'Required'], ['textbox', 'Required *']], labels: ['Required', 'Required *'] },
  { html: '<label for="pw">Show <img alt="key" src="/pixel.png"></label><input id="pw" type="password">', named: [['textbox', 'Show key'], ['textbox', 'Show']], labels: ['Show key'] },
  { html: '<label for="pw"><span>First</span><div>Second</div></label><input id="pw" type="password">', named: [['textbox', 'First Second'], ['textbox', 'FirstSecond']], labels: ['First Second'] },
  { html: '<input type="password" role="textbox" aria-label="Roled">', named: [['textbox', 'Roled']] },
  { html: '<input type="password" aria-label="Disabled" disabled><input type="password" aria-label="Fixed" readonly>', named: [['textbox', 'Disabled'], ['textbox', 'Fixed']] },
  { html: '<input type="PASSWORD" aria-label="Upper">', named: [['textbox', 'Upper']] },
  { html: '<input type="password" aria-label="One"><input type="password" aria-label="Two"><input type="text" aria-label="Three">', named: [['textbox', 'One'], ['textbox', 'Two'], ['textbox', 'Three']], loose: [['textbox', 't']] },
  // Row groups and grid cells.
  { html: '<table><caption>C</caption><thead><tr><th>H</th></tr></thead><tbody><tr><td>D</td></tr></tbody><tfoot><tr><td>F</td></tr></tfoot></table>' },
  { html: '<table><tbody><tr><td>D</td></tr></tbody></table>' },
  { html: '<table role="presentation"><tbody><tr><td>Layout</td></tr></tbody></table>' },
  { html: '<div role="table"><div role="rowgroup"><div role="row"><div role="cell">c</div></div></div></div>' },
  { html: '<div role="rowgroup"><div role="row">r</div></div>' },
  { html: '<div role="grid"><div role="rowgroup"><div role="row"><div role="gridcell">g</div></div></div></div>' },
  { html: '<div role="row"><div role="gridcell">In row</div></div>' },
  { html: '<div role="table"><div role="row"><div role="gridcell">In table</div></div></div>' },
  { html: '<div role="treegrid"><div role="row"><div role="gridcell">In treegrid</div></div></div>' },
  { html: '<table role="grid"><tr><td>Native grid</td></tr></table>', named: [['gridcell', 'Native grid']] },
  { html: '<div role="gridcell" aria-label="Named lone">g</div>', named: [['gridcell', 'Named lone']] },
  // Buttons made of inputs.
  { html: '<input type="submit">', named: [['button', 'Submit'], ['button', 'Submit Query']], loose: [['button', 'submit']] },
  { html: '<input type="reset">', named: [['button', 'Reset']] },
  { html: '<input type="submit" value="">', named: [['button', 'Submit'], ['button', '']] },
  { html: '<input type="button">', named: [['button', '']] },
  { html: '<input type="image" src="/pixel.png">', named: [['button', 'Submit'], ['button', 'Submit Query']] },
  { html: '<input type="image" src="/pixel.png" value="Val">', named: [['button', 'Val']] },
  { html: '<input type="submit" title="Titled">', named: [['button', 'Submit'], ['button', 'Titled']] },
  { html: '<form><input type="submit" aria-label="Go"></form>', named: [['button', 'Go']] },
  { html: '<input type="submit" value="Send"><input type="submit">', named: [['button', 'Send'], ['button', 'Submit']] },
  // Colour fields.
  { html: '<input type="color" aria-label="Tint">', named: [['button', 'Tint']] },
  { html: '<input type="color" role="button" aria-label="Tint">', named: [['button', 'Tint']] },
  { html: '<input type="color" value="#00ff00"><button>Real</button>', named: [['button', 'Real']] },
  // Figures.
  { html: '<figure><figcaption>C</figcaption></figure>', named: [['figure', 'C']] },
  { html: '<figure aria-label="Labelled"><figcaption>C</figcaption></figure>', named: [['figure', 'Labelled'], ['figure', 'C']] },
  { html: '<figure><img src="/pixel.png" alt="A"><figcaption>Fig</figcaption></figure>', named: [['figure', 'Fig'], ['img', 'A']] },
  { html: '<figure title="T">x</figure>', named: [['figure', 'T']] },
  { html: '<figure aria-labelledby="fl"><figcaption>C</figcaption></figure><span id="fl">Ref</span>', named: [['figure', 'Ref'], ['figure', 'C']] },
  { html: '<div role="figure"><figcaption>Not native</figcaption></div>', named: [['figure', 'Not native']] },
  { html: '<figure>Plain figure</figure>', named: [['figure', 'Plain figure']] },
  // Images that failed to load, and images marked as presentation.
  { html: '<img src="/missing.png" alt="Badge" width="20" height="20">', named: [['img', 'Badge']] },
  { html: '<img src="/missing.png" alt="Badge">', named: [['img', 'Badge']] },
  { html: '<img src="/missing.png" aria-label="Labelled badge" width="20" height="20">', named: [['img', 'Labelled badge']] },
  { html: '<img src="/missing.png" title="Titled badge" width="20" height="20">', named: [['img', 'Titled badge']] },
  { html: '<img src="/missing.png" alt="" width="20" height="20">' },
  { html: '<img src="/pixel.png" alt="Shown" width="20" height="20"><img src="/missing.png" alt="Broken" width="20" height="20">', named: [['img', 'Shown'], ['img', 'Broken']] },
  { html: '<img src="/pixel.png" width="20" height="20" role="none">' },
  { html: '<img src="/pixel.png" width="20" height="20" alt="Alt" role="presentation">', named: [['img', 'Alt']] },
  { html: '<img src="data:," alt="Data" width="20" height="20">', named: [['img', 'Data']] },
  { html: '<img alt="No source" width="20" height="20">', named: [['img', 'No source']] },
  { html: '<button><img src="/missing.png" alt="Broken icon"></button>', named: [['button', 'Broken icon']] },
  { html: '<a href="/x"><img src="/missing.png" alt="Broken link"></a>', named: [['link', 'Broken link']] },
]

const allCases: readonly Case[] = [...webKitCases, namesPage, reviewNamesPage, ...reviewKinds, ...firefoxCases]

/** What one lookup answered: a count, or the class, named role and message of a failure. */
type Answer = { readonly count: number } | { readonly failure: string; readonly role: unknown; readonly message: string }

function answerOf(result: CommandResult): Answer {
  if (result.ok && result.kind === 'observe') return { count: result.observation.count }
  if (result.ok) return { failure: `unexpected ${result.kind}`, role: undefined, message: '' }
  return { failure: result.failure.class, role: result.failure.details?.['role'], message: result.failure.message }
}

/** Every lookup a case makes: each ARIA role with no name, then its exact and loose named lookups and its labels. */
function lookupsOf(entry: Case): LocatorRecipe[] {
  return [
    ...ariaRoles.map((role): LocatorRecipe => ({ by: 'role', role })),
    ...(entry.named ?? []).map(([role, name]): LocatorRecipe => ({ by: 'role', role, name })),
    ...(entry.loose ?? []).map(([role, name]): LocatorRecipe => ({ by: 'role', role, name, exact: false })),
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
async function answersOn(page: OwnedPage, url: string, cases: readonly number[]): Promise<Map<number, Answer[]>> {
  const table = new Map<number, Answer[]>()
  for (const index of cases) {
    const entry = allCases[index]
    assert.ok(entry !== undefined)
    const opened = await page.execute({ kind: 'goto', url: `${url}?case=${index}` }, 5000)
    assert.ok(opened.ok, `case ${index}: ${JSON.stringify(opened)}`)
    table.set(index, await Promise.all(lookupsOf(entry).map(async (locator) => answerOf(await page.execute({ kind: 'observe', locator }, 10_000)))))
  }
  return table
}

async function opened(t: TestContext, browser: OwnedBrowser): Promise<OwnedPage> {
  t.after(() => browser.close(closeMs))
  const page = await browser.newPage({}, setupMs)
  t.after(() => page.dispose(closeMs))
  return page
}

async function openBoth(t: TestContext): Promise<{ chrome: OwnedPage; firefox: OwnedPage; url: string }> {
  const folder = await scratchFolder(t)
  const url = await serveCases(t)
  const chrome = await opened(t, await launchBrowser({ executablePath: browserPath(), logFile: join(folder, 'chrome.log'), headless: true }))
  const firefox = await opened(t, await launchFirefox({ executablePath: firefoxPath(), route: testFirefoxRoute(), logFile: join(folder, 'firefox.log'), headless: true }, setupMs * 3))
  return { chrome, firefox, url }
}

/** Whether `answer` refuses `locator` by name: class `unsupported`, a role the lookup asked for, and the lookup named. */
function refusedByName(answer: Answer, locator: LocatorRecipe): boolean {
  if (!('failure' in answer) || answer.failure !== 'unsupported') return false
  const askedRoles: readonly string[] = locator.by === 'role' ? [locator.role] : locator.by === 'label' ? labelledRoles : []
  return askedRoles.some((role) => role === answer.role) && answer.message.startsWith(`Could not look up ${describeLocator(locator)}: `)
}

const unsupported = firefoxPlatformProblem()

if (unsupported !== undefined) {
  test('the role table of Chrome and Firefox', (t) => t.skip(unsupported))
} else {
  test('every lookup of every element kind read beside Chrome is answered on Firefox as Chrome answers it, or refused by name, never answered differently', async (t) => {
    const { chrome, firefox, url } = await openBoth(t)
    const indexes = allCases.map((_, index) => index)
    const expected = await answersOn(chrome, url, indexes)
    const seen = await answersOn(firefox, url, indexes)
    const differences: string[] = []
    const refusals = new Map<string, number>()
    let answered = 0
    let lookups = 0
    for (const [index, entry] of allCases.entries()) {
      for (const [at, locator] of lookupsOf(entry).entries()) {
        lookups += 1
        const reference = expected.get(index)?.[at]
        const answer = seen.get(index)?.[at]
        const where = `case ${index} ${JSON.stringify(entry.html.slice(0, 70))} ${describeLocator(locator)}`
        assert.ok(reference !== undefined && 'count' in reference, `Chrome answers ${where}: ${JSON.stringify(reference)}`)
        assert.ok(answer !== undefined)
        if ('count' in answer && answer.count === reference.count) {
          answered += 1
          continue
        }
        if (refusedByName(answer, locator) && 'failure' in answer) {
          const role = String(answer.role)
          refusals.set(role, (refusals.get(role) ?? 0) + 1)
          continue
        }
        differences.push(`${where}: Chrome ${reference.count}, Firefox ${JSON.stringify(answer)}`)
      }
    }
    t.diagnostic(`${lookups} lookups in ${allCases.length} pages: ${answered} answered alike, ${lookups - answered - differences.length} refused by name on Firefox (${[...refusals].map(([role, count]) => `${role} ${count}`).join(', ')}), ${differences.length} answered differently`)
    for (const difference of differences) t.diagnostic(difference)
    assert.deepEqual(differences, [])
  })
}
