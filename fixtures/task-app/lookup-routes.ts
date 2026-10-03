import type { Route } from './route.ts'
import { escapeHtml, htmlPage } from './html.ts'
import { HTML_TYPE, respondWith } from './route.ts'

// Pages that prove how scoped locators, picks, CSS, placeholders and patterns find elements, what the state matchers
// read, how the page's history moves, what a hover sets off, and what a shortcut sends. Each element a rule should find
// carries text of its own, which a look reads back, so a test can tell which one it found.

// Each Delete button names the task it belongs to in the page, so a test can tell which one it clicked.
const FIND_SCRIPT = `
for (const button of document.querySelectorAll('button.delete')) {
  button.addEventListener('click', () => {
    document.querySelector('[data-testid="last-deleted"]').textContent = button.closest('li').querySelector('span').textContent
  })
}
`

/** Two lists with the same buttons, fields known by their placeholders, and text a pattern finds. */
export const FIND_PAGE: string = htmlPage(
  'Find',
  `<section data-testid="inbox" aria-label="Inbox">
<h2>Inbox</h2>
<ul>
<li class="task"><span>Buy milk</span> <button class="delete">Delete</button></li>
<li class="task"><span>Walk the dog</span> <button class="delete">Delete</button></li>
<li class="task done"><span>Pay rent</span> <button class="delete">Delete</button></li>
</ul>
<input placeholder="Search inbox" value="inbox search">
</section>
<section data-testid="archive" aria-label="Archive">
<h2>Archive</h2>
<ul><li class="task"><span>Old task</span> <button class="delete">Delete</button></li></ul>
<input placeholder="Search archive" value="archive search">
</section>
<label>E-mail <input value="ada@tasks.example"></label>
<input placeholder="  Search   everything " value="everything">
<p data-testid="summary">Saved 3 tasks</p>
<p>Last deleted: <span data-testid="last-deleted">none</span></p>`,
  FIND_SCRIPT,
)

// The button that waits is enabled 300 ms after the page loads, as a form that checks its fields first.
const STATES_SCRIPT = `
setTimeout(() => { document.querySelector('[data-testid="enabled-later"]').disabled = false }, 300)
`

/** Checkable controls in each state, enabled and disabled elements in each way, and text and a value to compare. */
export const STATES_PAGE: string = htmlPage(
  'States',
  `<p><label><input type="checkbox" data-testid="agree" checked> I agree</label></p>
<p><label><input type="checkbox" data-testid="newsletter"> Newsletter</label></p>
<p><span role="checkbox" aria-checked="true" tabindex="0" data-testid="remember">Remember me</span></p>
<p><span role="checkbox" aria-checked="mixed" tabindex="0" data-testid="some">Some of them</span></p>
<p><button data-testid="save">Save</button> <button data-testid="send" disabled>Send</button></p>
<fieldset disabled><button data-testid="in-fieldset">In a fieldset</button></fieldset>
<div aria-disabled="true"><button data-testid="in-group">In a group</button><div aria-disabled="false"><button data-testid="enabled-again">Enabled again</button></div></div>
<p><button data-testid="enabled-later" disabled>Enabled later</button></p>
<p data-testid="status">Saved   3 tasks</p>
<p><label>Release <input data-testid="release" value="Release 2"></label></p>`,
  STATES_SCRIPT,
)

// The second page moves within its document through the history API, and retitles itself as it does.
const PUSH_SCRIPT = `
document.querySelector('[data-testid="push"]').addEventListener('click', () => {
  history.pushState({}, '', '/lookup/history/two/pushed')
  document.title = 'Two, pushed'
})
`

function historyPage(name: string, loads: number, next: string | undefined, script = ''): string {
  const link = next === undefined ? '' : `<p><a href="${escapeHtml(next)}">Next</a></p>`
  return htmlPage(name, `<p data-testid="loads">Loaded ${loads} times</p>${link}<p><button type="button" data-testid="push">Push</button></p>`, script)
}

// Whatever the mouse arrives on is shown, with whether it was trusted: the share button shows its tip, and a disabled
// button's wrapper shows its own.
const HOVER_SCRIPT = `
const show = (testId, value) => { document.querySelector('[data-testid="' + testId + '"]').textContent = value }
const heard = []
for (const type of ['pointerover', 'mouseover']) {
  addEventListener(type, (event) => {
    const target = event.target.closest('[data-testid]')?.dataset.testid ?? event.target.localName
    heard.push(type + ':' + target + ':' + event.isTrusted)
    show('hovers', heard.join(' '))
  }, true)
}
const share = document.querySelector('[data-testid="share"]')
share.addEventListener('pointerover', () => { document.querySelector('[data-testid="tip"]').hidden = false })
document.querySelector('[data-testid="locked-wrapper"]').addEventListener('pointerover', () => { document.querySelector('[data-testid="locked-tip"]').hidden = false })
`

/** A button that shows a tip when the mouse arrives, a disabled one in a wrapper that does, and a covered one. */
export const HOVER_PAGE: string = htmlPage(
  'Hover',
  `<style>.covered { position: relative; display: inline-block } .cover { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.1) }</style>
<p><button data-testid="share">Share</button> <span data-testid="tip" hidden>Copy the link</span></p>
<p><span data-testid="locked-wrapper"><button data-testid="locked" disabled>Locked</button></span> <span data-testid="locked-tip" hidden>Coming soon</span></p>
<p><span class="covered"><button data-testid="under">Under</button><span class="cover" data-testid="cover"></span></span></p>
<p>Heard: <span data-testid="hovers"></span></p>`,
  HOVER_SCRIPT,
)

// Every key down the page hears, written with the modifiers held, and an app shortcut that opens a palette.
const SHORTCUTS_SCRIPT = `
const heard = []
addEventListener('keydown', (event) => {
  const held = ['ctrl', 'alt', 'meta', 'shift'].filter((name) => event[name + 'Key']).map((name) => name[0].toUpperCase() + name.slice(1))
  heard.push([...held, event.key].join('+') + ':' + event.isTrusted)
  document.querySelector('[data-testid="heard"]').textContent = heard.join(' ')
  if ((event.ctrlKey || event.metaKey) && event.key === 'k') document.querySelector('[data-testid="palette"]').hidden = false
}, true)
`

/** A field whose text a shortcut selects, every key down the page hears, and a palette a shortcut opens. */
export const SHORTCUTS_PAGE: string = htmlPage(
  'Shortcuts',
  `<p><label>Note <input data-testid="note" value="Release checklist" autocomplete="off"></label></p>
<p>Heard: <span data-testid="heard"></span></p>
<div data-testid="palette" role="dialog" aria-label="Palette" hidden>Palette</div>`,
  SHORTCUTS_SCRIPT,
)

/**
 * What Playwright's finders find that Retest's own do not: a button whose name holds the word asked for, text in
 * another case, and elements that only an aria-label or aria-labelledby names.
 */
export const PLAYWRIGHT_PAGE: string = htmlPage(
  'Playwright rules',
  `<button data-testid="delete-task">Delete task</button>
<p id="caption">Order summary</p>
<section aria-labelledby="caption" data-testid="summary"><span>2 tasks</span></section>
<span aria-label="Unread count" data-testid="unread">3</span>
<input placeholder="Search tasks" data-testid="search" autocomplete="off">`,
)

// A widget that keeps its button in an open shadow root, beside one outside it.
const SHADOW_SCRIPT = `
const root = document.querySelector('[data-testid="widget"]').attachShadow({ mode: 'open' })
root.innerHTML = '<button>Inside</button>'
`

/** A title longer than the 300 code units Retest records, which a page matcher still compares whole. */
export const LONG_TITLE: string = 'Quarterly report '.repeat(25).trim()

/** A page with an open shadow root, which Playwright's locators look inside and Retest's do not. */
export const SHADOW_PAGE: string = htmlPage('Shadow', `<todo-widget data-testid="widget"></todo-widget><button>Outside</button>`, SHADOW_SCRIPT)

/**
 * The routes of these pages. Each history page counts its loads, so a test can tell a reload from a page the
 * browser kept.
 */
export function lookupRoutes(): Route[] {
  const loads = new Map<string, number>()
  const counted = (path: string): number => {
    const count = (loads.get(path) ?? 0) + 1
    loads.set(path, count)
    return count
  }
  return [
    ['GET /lookup/find', (_request, response) => respondWith(response, 200, HTML_TYPE, FIND_PAGE)],
    ['GET /lookup/states', (_request, response) => respondWith(response, 200, HTML_TYPE, STATES_PAGE)],
    ['GET /lookup/hover', (_request, response) => respondWith(response, 200, HTML_TYPE, HOVER_PAGE)],
    ['GET /lookup/shortcuts', (_request, response) => respondWith(response, 200, HTML_TYPE, SHORTCUTS_PAGE)],
    ['GET /lookup/playwright', (_request, response) => respondWith(response, 200, HTML_TYPE, PLAYWRIGHT_PAGE)],
    ['GET /lookup/shadow', (_request, response) => respondWith(response, 200, HTML_TYPE, SHADOW_PAGE)],
    ['GET /lookup/long-title', (_request, response) => respondWith(response, 200, HTML_TYPE, htmlPage(LONG_TITLE, '<p>Long title</p>'))],
    ['GET /lookup/history/one', (_request, response) => respondWith(response, 200, HTML_TYPE, historyPage('One', counted('one'), '/lookup/history/two'))],
    ['GET /lookup/history/two', (_request, response) => respondWith(response, 200, HTML_TYPE, historyPage('Two', counted('two'), undefined, PUSH_SCRIPT))],
    ['GET /lookup/history/reloaded', (_request, response) => respondWith(response, 200, HTML_TYPE, historyPage('Reloaded', counted('reloaded'), undefined))],
  ]
}
