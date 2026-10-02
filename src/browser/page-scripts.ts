import { titleReadLimit } from '../protocol/page-facts.ts'

// Functions sent to Retest's isolated world in the page, where page scripts cannot reach or replace them.
// Values arrive as call arguments and are never written into this source; Retest's own limits are.

// Matches text the way `matchesText` in text-match.ts does, which a unit test checks.
export const textMatchHelper: string = String.raw`
  const normalize = (text) => text.trim().replace(/\s+/g, ' ')
  const textMatcher = (wanted, exact) => {
    const target = normalize(wanted)
    const lowered = target.toLowerCase()
    return exact ? (text) => normalize(text) === target : (text) => normalize(text).toLowerCase().includes(lowered)
  }
`

const helpers = String.raw`
  ${textMatchHelper}
  // An element's text is that of its text nodes and descendants, except inside elements whose content no one reads.
  const skipped = ['script', 'style', 'template', 'noscript']
  const isText = (node) => node.nodeType === Node.TEXT_NODE
  const holdsText = (node) => node instanceof Element && !skipped.includes(node.localName)
  const textOf = (element) => {
    let text = ''
    for (const child of element.childNodes) {
      if (isText(child)) text += child.data
      else if (holdsText(child)) text += textOf(child)
    }
    return text
  }
  const byTestId = (value) => {
    const found = []
    for (const element of document.querySelectorAll('[data-testid]')) {
      if (element.getAttribute('data-testid') === value) found.push(element)
    }
    return found
  }
  // The innermost elements whose text matches: an element that holds a match is left out for it. Pushed after
  // their children, they stay in document order, since no element found holds another.
  const byText = (wanted, exact) => {
    const matches = textMatcher(wanted, exact)
    const found = []
    const visit = (element) => {
      let text = ''
      let below = false
      for (const child of element.childNodes) {
        if (isText(child)) text += child.data
        else if (holdsText(child)) {
          const inner = visit(child)
          text += inner.text
          below ||= inner.matched
        }
      }
      const matched = below || matches(text)
      if (matched && !below) found.push(element)
      return { text, matched }
    }
    const root = document.body ?? document.documentElement
    if (root !== null) visit(root)
    return found
  }
  // Only the document's own tree: input in a shadow tree reaches the window as input to its host, so the guard
  // could not tell the element from whatever else is inside that host.
  const inDocument = (element) => element instanceof Element && element.getRootNode() === document
  const documentOrder = (first, second) => (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
  const find = (query, elements) => {
    if (query.by === 'testId') return byTestId(query.value)
    if (query.by === 'text') return byText(query.text, query.exact)
    return elements.filter(inDocument).sort(documentOrder)
  }
  const isVisible = (element) => {
    if (!element.checkVisibility() || getComputedStyle(element).visibility !== 'visible') return false
    const box = element.getBoundingClientRect()
    return box.width > 0 && box.height > 0
  }
`

// Attribute values go whole: the parent redacts the failure that names the element, and a value cut here could not
// be found there.
const describeHelper = String.raw`
  const describe = (element) => {
    let text = '<' + element.localName
    for (const name of ['id', 'class', 'data-testid']) {
      const value = element.getAttribute(name)
      if (value !== null) text += ' ' + name + '="' + value + '"'
    }
    return text + '>'
  }
`

// The guard listens on the window in the capture phase, where an event arrives before any element hears it.
// Every document the page opens adds it before its own scripts run, so no listener of the page hears an event
// the guard stops. Touch listeners on the window are passive unless they say otherwise, and a passive one could
// not cancel the click a stopped touch goes on to make.
// A fill bound to origins holds its document until the text reaches the field: a navigation the page starts to
// another document meanwhile is cancelled, and the typing with it, so the text never reaches another origin.
// Typing that arrives while nothing is armed for it was meant for a document this one replaced, or for an
// element outside this document, so it is stopped and noted: no text Retest sends reaches a document it did not
// check.
// A key's press decides at its keydown, which must reach the element. The rest of the keystroke then belongs to
// the page, which may have moved the focus or submitted a form, and the arming lasts until the key is released,
// so none of it is stopped as stray typing.
// Stray typing is what a keyboard or an editing input sends. The input event a checkbox, a radio button or a
// select fires after it changes is a plain event of the page's own, and passes.
// A wheel listener that is not passive makes the browser wait for it before every scroll, so the guard listens for
// the wheel only while a scroll is armed. Waiting is also what makes the wheel reach it before the browser answers.
const guardHelpers = String.raw`
  const guarded = {
    click: { events: ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'], last: 'click' },
    tap: { events: ['pointerdown', 'touchstart', 'pointerup', 'touchend', 'mousedown', 'mouseup', 'click'], last: 'click' },
    fill: { events: ['keydown', 'beforeinput', 'input', 'keyup'], last: 'input' },
    press: { events: ['keydown', 'keypress', 'beforeinput', 'input', 'keyup'], last: 'keyup', decides: 'keydown' },
    scroll: { events: ['wheel'], last: 'wheel', whileArmed: true },
  }
  const isTyping = (event) =>
    guarded.fill.events.includes(event.type) && (event instanceof KeyboardEvent || event instanceof InputEvent)
  const installGuard = () => {
    if (globalThis.retestGuard !== undefined) return globalThis.retestGuard
    const guard = { armed: null, latest: null, count: 0, stray: null }
    const stop = (event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const hold = (event) => {
      const armed = guard.armed
      if (armed === null || armed.origins === null || armed.reached.includes('beforeinput') || event.destination.sameDocument) return
      event.preventDefault()
      armed.leaving ??= new URL(event.destination.url).origin
    }
    const check = (event) => {
      const armed = guard.armed
      if (!event.isTrusted) return
      const { target } = event
      if (armed === null || !armed.events.includes(event.type)) {
        if (!isTyping(event)) return
        stop(event)
        guard.stray ??= { event: event.type, by: target instanceof Element ? describe(target) : 'the page', origin: location.origin }
        return
      }
      if (armed.leaving !== null || armed.decided === 'stopped') {
        stop(event)
      } else if (armed.decided === 'reached') {
        // The rest of the keystroke belongs to the page.
      } else if (target instanceof Node && armed.element.contains(target)) {
        armed.reached.push(event.type)
        // A page that moved the caret since Retest selected the value would otherwise keep part of it.
        if (armed.action === 'fill' && event.type === 'beforeinput') armed.element.select()
      } else {
        stop(event)
        armed.intercepted ??= { event: event.type, by: target instanceof Element ? describe(target) : 'the page' }
      }
      if (event.type === armed.decides) {
        armed.decided = armed.intercepted === null ? 'reached' : 'stopped'
        armed.report()
      }
      // Later events belong to the page, such as the click a label passes on to its field.
      if (event.type === armed.last) armed.settle()
    }
    const options = { capture: true, passive: false }
    const always = Object.values(guarded).filter((entry) => entry.whileArmed !== true)
    for (const type of new Set(always.flatMap(({ events }) => events))) window.addEventListener(type, check, options)
    // Adds the listener for events heard only while armed, and returns what removes it.
    guard.listen = (types) => {
      for (const type of types) window.addEventListener(type, check, options)
      return () => {
        for (const type of types) window.removeEventListener(type, check, options)
      }
    }
    navigation.addEventListener('navigate', hold)
    globalThis.retestGuard = guard
    return guard
  }
`

const armHelper = String.raw`
  const arm = (element, action, point, origins) => {
    const guard = installGuard()
    guard.latest?.settle()
    let resolve
    const verdict = new Promise((settle) => {
      resolve = settle
    })
    const armed = { element, action, ...guarded[action], origins, leaving: null, reached: [], intercepted: null, decided: null }
    const unlisten = armed.whileArmed === true ? guard.listen(armed.events) : () => {}
    // What the guard saw so far, once: an action whose input decides early answers before the rest arrives.
    armed.report = () => {
      const landed = point === null ? document.activeElement : document.elementFromPoint(point.x, point.y)
      const { reached, intercepted, leaving } = armed
      resolve({ reached: [...reached], intercepted, landed: landed === null ? null : describe(landed), leaving })
    }
    armed.settle = () => {
      if (guard.armed === armed) guard.armed = null
      unlisten()
      armed.report()
    }
    guard.count += 1
    guard.armed = armed
    guard.latest = { token: guard.count, verdict, settle: armed.settle }
    armed.token = guard.count
    return armed
  }
`

// A page's title as it has it, up to Retest's limit and never inside a surrogate pair, so no page can send a title
// of any size. The parent redacts it before it cleans or cuts it.
const titleHelper = String.raw`
  const titleOf = () => {
    const title = document.title
    if (title.length <= ${titleReadLimit}) return title
    const code = title.charCodeAt(${titleReadLimit} - 1)
    return title.slice(0, code >= 0xd800 && code <= 0xdbff ? ${titleReadLimit} - 1 : ${titleReadLimit})
  }
`

// The page a command went to, read in the same call that checks or reads the element: its address and its title,
// as the page has them. The browser keeps the origin and path.
const pageFactsHelper = String.raw`
  ${titleHelper}
  const pageFacts = () => ({ href: location.href, title: titleOf() })
`

const actionHelpers = String.raw`
  const fieldTypes = ['text', 'search', 'email', 'url', 'tel', 'password', 'number']
  const isField = (element) =>
    element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && fieldTypes.includes(element.type))
  const describeField = (element) =>
    element instanceof HTMLInputElement ? '<input type="' + element.type + '">' : '<' + element.localName + '>'
  // What is on screen, in client coordinates. A mobile page zoomed out to fit wide content shows more than its
  // layout viewport, and hit tests and input reach all of it.
  const viewport = () => {
    const { offsetLeft, offsetTop, width, height } = visualViewport
    return { left: offsetLeft, top: offsetTop, right: offsetLeft + width, bottom: offsetTop + height }
  }
  const visibleCentre = (box) => {
    const view = viewport()
    const left = Math.max(box.left, view.left)
    const right = Math.min(box.right, view.right)
    const top = Math.max(box.top, view.top)
    const bottom = Math.min(box.bottom, view.bottom)
    if (right <= left || bottom <= top) return null
    return { x: (left + right) / 2, y: (top + bottom) / 2 }
  }
  const isCentreInView = (box) => {
    const view = viewport()
    const x = box.left + box.width / 2
    const y = box.top + box.height / 2
    return x >= view.left && x < view.right && y >= view.top && y < view.bottom
  }
  const boxAfterFrame = (element) =>
    new Promise((resolve) => requestAnimationFrame(() => resolve(element.getBoundingClientRect())))
  const sameBox = (first, second) =>
    first.x === second.x && first.y === second.y && first.width === second.width && first.height === second.height
  const blocked = (check, detail = null) => ({ status: 'blocked', check, detail })
  const ready = (point, token, via = null) => ({ status: 'ready', point, token, via, scale: visualViewport.scale, page: pageFacts() })
  // A key goes to whatever holds the keyboard focus, never through a point, so there is no hit test.
  const readyForKeys = (element) => {
    if (element.matches(':disabled')) return blocked('enabled')
    const armed = arm(element, 'press', null, null)
    element.focus()
    if (document.activeElement === element) return ready(null, armed.token)
    armed.settle()
    return blocked('focused')
  }
`

// A checkbox or radio button of the page's own, or an element whose role says it is one. Only the role's first
// word counts, as it does for the browser.
const checkableHelper = String.raw`
  const checkableRoles = new Map([
    ['checkbox', 'checkbox'],
    ['switch', 'checkbox'],
    ['menuitemcheckbox', 'checkbox'],
    ['radio', 'radio'],
    ['menuitemradio', 'radio'],
  ])
  const checkable = (element) => {
    if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
      return { native: true, kind: element.type }
    }
    const kind = checkableRoles.get((element.getAttribute('role') ?? '').trim().split(/\s+/)[0])
    return kind === undefined ? null : { native: false, kind }
  }
  const isChecked = (element, control) => (control.native ? element.checked : element.getAttribute('aria-checked') === 'true')
  // A hidden native control is ticked through its one visible label of its own, as a person ticks a styled checkbox.
  const visibleLabel = (control) => {
    const labels = [...(control.labels ?? [])].filter(isVisible)
    return labels.length === 1 ? labels[0] : null
  }
`

// Each choice names exactly one option, by its label as a person reads it, whitespace normalised, or by its value.
// An option is disabled on its own or inside a disabled group, which :disabled covers both.
const selectHelper = String.raw`
  const chooseOptions = (select, choices) => {
    const options = [...select.options]
    const matches = choices.map((choice) =>
      options.filter((option) => ('label' in choice ? normalize(option.label) === normalize(choice.label) : option.value === choice.value)),
    )
    const problem = (kind, index) => ({ status: 'option', problem: kind, choice: index, count: matches[index].length })
    const ambiguous = matches.findIndex((found) => found.length > 1)
    if (ambiguous !== -1) return problem('ambiguous', ambiguous)
    const missing = matches.findIndex((found) => found.length === 0)
    if (missing !== -1) return problem('missing', missing)
    const disabled = matches.findIndex(([option]) => option.matches(':disabled'))
    if (disabled !== -1) return problem('disabled', disabled)
    return { status: 'chosen', options: matches.map(([option]) => option) }
  }
  const isSelection = (select, chosen) => {
    const selected = [...select.selectedOptions]
    return selected.length === new Set(chosen).size && chosen.every((option) => selected.includes(option))
  }
  // As the browser does once a person picks from the list: the selection, then input and change, both bubbling.
  const applySelection = (select, chosen) => {
    if (select.multiple) for (const option of select.options) option.selected = chosen.includes(option)
    else chosen[0].selected = true
    select.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }
`

// What an action asks of the element it found before any check, which may settle the action at once: the kind of
// element it takes, and for check and select whether there is anything to do. Otherwise it names the element to
// check and act on, which for a hidden native control is its label.
const fitHelper = String.raw`
  const settled = (readiness) => ({ settled: readiness })
  const fitField = (intent, control) => {
    if (!isField(control)) return settled({ status: 'unsupported', reason: 'field', element: describeField(control) })
    if (intent.multiline && control instanceof HTMLInputElement) {
      return settled({ status: 'unsupported', reason: 'multiline', element: describeField(control) })
    }
    return { element: control }
  }
  const fitCheckable = (intent, control) => {
    const kind = checkable(control)
    if (kind === null) return settled({ status: 'unsupported', reason: 'checkable', element: describe(control) })
    if (!intent.checked && kind.kind === 'radio') return settled({ status: 'unsupported', reason: 'radio', element: describe(control) })
    if (isChecked(control, kind) === intent.checked) return settled({ status: 'unchanged', page: pageFacts() })
    const label = kind.native && !isVisible(control) ? visibleLabel(control) : null
    return label === null ? { element: control, kind } : { element: label, via: 'label', kind }
  }
  const fitSelect = (intent, control) => {
    if (!(control instanceof HTMLSelectElement)) return settled({ status: 'unsupported', reason: 'select', element: describe(control) })
    if (intent.multiple && !control.multiple) return settled({ status: 'unsupported', reason: 'multiple', element: describe(control) })
    const chosen = chooseOptions(control, intent.choices)
    return chosen.status === 'chosen' ? { element: control } : settled(chosen)
  }
  const fit = (intent, control) => {
    if (intent.action === 'fill') return fitField(intent, control)
    if (intent.action === 'check') return fitCheckable(intent, control)
    if (intent.action === 'select') return fitSelect(intent, control)
    return { element: control }
  }
  // In the task of the hit test: the selection is read again, left alone when it is already the one asked for,
  // and otherwise set only when the call applies it.
  const finishSelect = (intent, select, point) => {
    const chosen = chooseOptions(select, intent.choices)
    if (chosen.status !== 'chosen') return chosen
    if (isSelection(select, chosen.options)) return { status: 'unchanged', page: pageFacts() }
    if (!intent.apply) return ready(point, null)
    const page = pageFacts()
    applySelection(select, chosen.options)
    return { status: 'selected', page }
  }
`

/** Installs the input guard in each new document, before the page's own scripts run. */
export const guardScript: string = `(() => {
  ${describeHelper}
  ${guardHelpers}
  installGuard()
})()`

/**
 * Finds the matches of `query`, and lists the first `limit` of them; for a single match, reads whether it is
 * visible, its text and, for a field, its value. Never waits. A query `{ by: 'elements' }` takes the elements that
 * follow it, found already, and keeps those in the document's own tree, in document order. Returns the observation
 * and the page it was read on.
 */
// The page tells Retest when its document changes, so a look can follow a change at once instead of on a timer. The
// observer reports once per task however much changed in it, through the binding `Runtime.addBinding` gave this
// world; nothing of the page's own can see or call it. Loading a document changes it as it is parsed, which counts.
export const changeScript: string = `(() => {
  if (globalThis.retestChanges !== undefined) return
  globalThis.retestChanges = true
  const tell = () => {
    if (typeof globalThis.retestChanged === 'function') globalThis.retestChanged('')
  }
  new MutationObserver(tell).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
})()`

export const observeFunction: string = `function observe(limit, query, ...elements) {
  ${helpers}
  ${pageFactsHelper}
  const found = find(query, elements)
  const items = found.slice(0, limit).map((element) => ({ text: textOf(element), visible: isVisible(element) }))
  const listed = { count: found.length, items, itemsTruncated: found.length > limit }
  if (found.length !== 1) return { observation: { ...listed, visible: null, text: null, value: null }, page: pageFacts() }
  const element = found[0]
  const isField = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
  const observation = { ...listed, visible: isVisible(element), text: textOf(element), value: isField ? element.value : null }
  return { observation, page: pageFacts() }
}`

/**
 * Finds the matches of `query` as `observe` does, checks the one match in the order the build plan gives, and
 * returns the point to act at, the page it is on, and the visual viewport's scale. Once every check passes it arms
 * the input guard for the element, all in the same task as the hit test, so no page script runs between them.
 * `intent` names the action and what it needs:
 *
 * - `fill`: `multiline` and `origins`. It focuses the field and selects its whole value. `origins`, when not null,
 *   are the only origins the text may reach: a document on another is refused, and so is one the focus sets off
 *   to leave, which the armed guard keeps from going.
 * - `press`: checks that the element is visible and enabled, arms the guard and focuses it, and is ready with no
 *   point once it keeps the focus.
 * - `check`: `checked`, the state asked for, and `pointer`, the input that clicks it. A control already in that
 *   state is `unchanged`. A hidden native control is checked and armed through its one visible label.
 * - `select`: `choices`, `multiple`, and `apply`. Each choice must name one enabled option. The selection is set,
 *   and input and change dispatched, only when `apply` is true, in the task of the hit test; nothing is armed.
 * - `click`, `tap` and `scroll` need nothing more.
 */
export const prepareFunction: string = `async function prepare(intent, query, ...elements) {
  ${helpers}
  ${describeHelper}
  ${guardHelpers}
  ${armHelper}
  ${pageFactsHelper}
  ${actionHelpers}
  ${checkableHelper}
  ${selectHelper}
  ${fitHelper}
  const { action } = intent
  const origins = intent.origins ?? null
  if (origins !== null && !origins.includes(location.origin)) return { status: 'refused', origin: location.origin, leaving: false }
  const found = find(query, elements)
  if (found.length === 0) return { status: 'missing' }
  if (found.length > 1) return { status: 'ambiguous', count: found.length }
  const control = found[0]
  const fitted = fit(intent, control)
  if (fitted.settled !== undefined) return fitted.settled
  const { element, via = null } = fitted
  if (!isVisible(element)) return blocked('visible')
  if (action === 'press') return readyForKeys(element)
  if (!isCentreInView(element.getBoundingClientRect())) {
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  }
  const before = await boxAfterFrame(element)
  const after = await boxAfterFrame(element)
  if (!element.isConnected) return blocked('attached')
  if (!isVisible(element)) return blocked('visible')
  if (control.matches(':disabled')) return blocked('enabled')
  if (action === 'fill' && element.readOnly) return blocked('editable')
  if (!sameBox(before, after)) return blocked('stable')
  const point = visibleCentre(after)
  if (point === null) return blocked('in-view')
  const hit = document.elementFromPoint(point.x, point.y)
  if (hit === null) return blocked('hit-target')
  if (hit !== element && !element.contains(hit)) return blocked('hit-target', describe(hit))
  if (action === 'select') return finishSelect(intent, element, point)
  if (action === 'check' && isChecked(control, fitted.kind) === intent.checked) return { status: 'unchanged', page: pageFacts() }
  const armed = arm(element, intent.pointer ?? action, action === 'fill' ? null : point, origins)
  if (action === 'fill') {
    element.focus()
    element.select()
    const refusal = armed.leaving === null ? null : { status: 'refused', origin: armed.leaving, leaving: true }
    const unready = refusal ?? (document.activeElement === element ? null : blocked('focused'))
    if (unready !== null) {
      armed.settle()
      return unready
    }
  }
  return ready(point, armed.token, via)
}`

/**
 * Arms the guard for input that goes to the document rather than to an element, and is ready as `prepare` is: a
 * key for the page's keyboard, which goes to whatever holds the focus, or the wheel at the centre of the viewport.
 * Any element of this document may take it.
 */
export const armDocumentFunction: string = `function armDocument(action) {
  ${describeHelper}
  ${guardHelpers}
  ${armHelper}
  ${pageFactsHelper}
  ${actionHelpers}
  const view = viewport()
  const point = action === 'scroll' ? { x: (view.left + view.right) / 2, y: (view.top + view.bottom) / 2 } : null
  return ready(point, arm(document, action, point, null).token)
}`

/**
 * Whether the one element `query` finds is checked, as `check` reads it, or null when there is not exactly one
 * such element, or it is not a control that can be checked.
 */
export const checkedFunction: string = `function checked(query, ...elements) {
  ${helpers}
  ${checkableHelper}
  const found = find(query, elements)
  if (found.length !== 1) return null
  const kind = checkable(found[0])
  return kind === null ? null : isChecked(found[0], kind)
}`

/** The page's address and title, as the page has them. */
export const pageFactsFunction: string = `function readPageFacts() {
  ${pageFactsHelper}
  return pageFacts()
}`

/** Waits until the guard armed with `token` has seen its input through, and returns what it saw. */
export const verdictFunction: string = `function verdict(token) {
  const latest = globalThis.retestGuard?.latest
  if (latest?.token !== token) throw new Error('No input guard is armed with token ' + token)
  return latest.verdict
}`

/** Ends the arming `token` names, which settles its verdict with what the guard saw so far. */
export const disarmFunction: string = `function disarm(token) {
  const latest = globalThis.retestGuard?.latest
  if (latest?.token !== token) return false
  latest.settle()
  return true
}`

/** The first typing this document's guard stopped while nothing was armed for it, or null: text meant for another document. */
export const strayFunction: string = `function stray() {
  return globalThis.retestGuard?.stray ?? null
}`

/**
 * Whether the visible text of the document, `document.body.innerText`, holds each query, read as
 * `pageTextHolds` reads it: whitespace normalised, and in any case when the query ignores case, and the document's
 * title. Only the answers and the title leave the page. A document with no body, such as an XML or SVG one, has no
 * visible text: it says so, and finds nothing.
 */
export const readPageFunction: string = `function readPage(queries) {
  ${textMatchHelper}
  ${titleHelper}
  if (document.body === null) return { found: queries.map(() => false), title: titleOf(), body: false }
  const text = normalize(document.body.innerText)
  const lowered = text.toLowerCase()
  const found = queries.map((query) => (query.ignoreCase ? lowered.includes(normalize(query.text).toLowerCase()) : text.includes(normalize(query.text))))
  return { found, title: titleOf(), body: true }
}`

/** Reads the document origin's `localStorage`, or null when the document may not use it. */
export const readStorageFunction: string = `function readStorage() {
  let storage
  try {
    storage = localStorage
  } catch {
    return null
  }
  const items = []
  for (let index = 0; index < storage.length; index += 1) {
    const name = storage.key(index)
    if (name !== null) items.push({ name, value: storage.getItem(name) ?? '' })
  }
  return { origin: location.origin, items }
}`

/** Adds items to the document origin's `localStorage` and returns the origin it wrote to. */
export const writeStorageFunction: string = `function writeStorage(items) {
  for (const { name, value } of items) localStorage.setItem(name, value)
  return location.origin
}`
