// Functions sent to Retest's isolated world in the page, where page scripts cannot reach or replace them.
// Values arrive as call arguments and are never written into this source.

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

const describeHelper = String.raw`
  const describe = (element) => {
    let text = '<' + element.localName
    for (const name of ['id', 'class', 'data-testid']) {
      const value = element.getAttribute(name)
      if (value !== null) text += ' ' + name + '="' + value.slice(0, 40) + '"'
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
const guardHelpers = String.raw`
  const guarded = {
    click: { events: ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'], last: 'click' },
    tap: { events: ['pointerdown', 'touchstart', 'pointerup', 'touchend', 'mousedown', 'mouseup', 'click'], last: 'click' },
    fill: { events: ['keydown', 'beforeinput', 'input', 'keyup'], last: 'input' },
    press: { events: ['keydown', 'keypress', 'beforeinput', 'input', 'keyup'], last: 'keyup', decides: 'keydown' },
  }
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
        if (!guarded.fill.events.includes(event.type)) return
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
    for (const type of new Set(Object.values(guarded).flatMap(({ events }) => events))) {
      window.addEventListener(type, check, { capture: true, passive: false })
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
    // What the guard saw so far, once: an action whose input decides early answers before the rest arrives.
    armed.report = () => {
      const landed = point === null ? document.activeElement : document.elementFromPoint(point.x, point.y)
      const { reached, intercepted, leaving } = armed
      resolve({ reached: [...reached], intercepted, landed: landed === null ? null : describe(landed), leaving })
    }
    armed.settle = () => {
      if (guard.armed === armed) guard.armed = null
      armed.report()
    }
    guard.count += 1
    guard.armed = armed
    guard.latest = { token: guard.count, verdict, settle: armed.settle }
    armed.token = guard.count
    return armed
  }
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
  // A key goes to whatever holds the keyboard focus, never through a point, so there is no hit test.
  const readyForKeys = (element) => {
    if (element.matches(':disabled')) return blocked('enabled')
    const armed = arm(element, 'press', null, null)
    element.focus()
    if (document.activeElement === element) return { status: 'ready', point: null, token: armed.token }
    armed.settle()
    return blocked('focused')
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
 * follow it, found already, and keeps those in the document's own tree, in document order.
 */
export const observeFunction: string = `function observe(limit, query, ...elements) {
  ${helpers}
  const found = find(query, elements)
  const items = found.slice(0, limit).map((element) => ({ text: textOf(element), visible: isVisible(element) }))
  const listed = { count: found.length, items, itemsTruncated: found.length > limit }
  if (found.length !== 1) return { ...listed, visible: null, text: null, value: null }
  const element = found[0]
  const isField = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
  return { ...listed, visible: isVisible(element), text: textOf(element), value: isField ? element.value : null }
}`

/**
 * Finds the matches of `query` as `observe` does, checks the one match in the order the build plan gives, and
 * returns the point to press. Once every check passes it arms the input guard for the element, all in the same
 * task as the hit test, so no page script runs between them. For `fill` it then focuses the field and selects its
 * whole value. `origins`, when not null, are the only origins the text may reach: a document on another is
 * refused, and so is one the focus sets off to leave, which the armed guard keeps from going. A `press` checks
 * that the element is visible and enabled, arms the guard and focuses it, and is ready with no point once it
 * keeps the focus.
 */
export const prepareFunction: string = `async function prepare(action, multiline, origins, query, ...elements) {
  ${helpers}
  ${describeHelper}
  ${guardHelpers}
  ${armHelper}
  ${actionHelpers}
  if (origins !== null && !origins.includes(location.origin)) return { status: 'refused', origin: location.origin, leaving: false }
  const found = find(query, elements)
  if (found.length === 0) return { status: 'missing' }
  if (found.length > 1) return { status: 'ambiguous', count: found.length }
  const element = found[0]
  if (action === 'fill') {
    if (!isField(element)) return { status: 'unsupported', reason: 'field', field: describeField(element) }
    if (multiline && element instanceof HTMLInputElement) {
      return { status: 'unsupported', reason: 'multiline', field: describeField(element) }
    }
  }
  if (!isVisible(element)) return blocked('visible')
  if (action === 'press') return readyForKeys(element)
  if (!isCentreInView(element.getBoundingClientRect())) {
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  }
  const before = await boxAfterFrame(element)
  const after = await boxAfterFrame(element)
  if (!element.isConnected) return blocked('attached')
  if (!isVisible(element)) return blocked('visible')
  if (element.matches(':disabled')) return blocked('enabled')
  if (action === 'fill' && element.readOnly) return blocked('editable')
  if (!sameBox(before, after)) return blocked('stable')
  const point = visibleCentre(after)
  if (point === null) return blocked('in-view')
  const hit = document.elementFromPoint(point.x, point.y)
  if (hit === null) return blocked('hit-target')
  if (hit !== element && !element.contains(hit)) return blocked('hit-target', describe(hit))
  const armed = arm(element, action, action === 'fill' ? null : point, origins)
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
  return { status: 'ready', point, token: armed.token }
}`

/**
 * Arms the guard for a key sent to the page's keyboard, which goes to whatever holds the focus: any element of
 * this document may take it. Returns the arming's token.
 */
export const armKeyboardFunction: string = `function armKeyboard() {
  ${describeHelper}
  ${guardHelpers}
  ${armHelper}
  return arm(document, 'press', null, null).token
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
 * `pageTextHolds` reads it: whitespace normalised, and in any case when the query ignores case. Only the
 * answers leave the page.
 */
export const readPageFunction: string = `function readPage(queries) {
  ${textMatchHelper}
  const text = normalize(document.body?.innerText ?? '')
  const lowered = text.toLowerCase()
  return queries.map((query) => (query.ignoreCase ? lowered.includes(normalize(query.text).toLowerCase()) : text.includes(normalize(query.text))))
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
