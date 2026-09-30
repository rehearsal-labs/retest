// Functions sent to Retest's isolated world in the page, where page scripts cannot reach or replace them.
// Values arrive as call arguments and are never written into this source.

const helpers = String.raw`
  const find = (value) => {
    const found = []
    for (const element of document.querySelectorAll('[data-testid]')) {
      if (element.getAttribute('data-testid') === value) found.push(element)
    }
    return found
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
// the guard stops.
const guardHelpers = String.raw`
  const guarded = {
    click: { events: ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'], last: 'click' },
    fill: { events: ['keydown', 'beforeinput', 'input', 'keyup'], last: 'input' },
  }
  const installGuard = () => {
    if (globalThis.retestGuard !== undefined) return globalThis.retestGuard
    const guard = { armed: null, latest: null, count: 0 }
    const check = (event) => {
      const armed = guard.armed
      if (armed === null || !event.isTrusted || !armed.events.includes(event.type)) return
      const { target } = event
      if (target instanceof Node && armed.element.contains(target)) {
        armed.reached.push(event.type)
        // A page that moved the caret since Retest selected the value would otherwise keep part of it.
        if (event.type === 'beforeinput') armed.element.select()
      } else {
        event.preventDefault()
        event.stopImmediatePropagation()
        armed.intercepted ??= { event: event.type, by: target instanceof Element ? describe(target) : 'the page' }
      }
      // Later events belong to the page, such as the click a label passes on to its field.
      if (event.type === armed.last) armed.settle()
    }
    for (const type of new Set(Object.values(guarded).flatMap(({ events }) => events))) {
      window.addEventListener(type, check, true)
    }
    globalThis.retestGuard = guard
    return guard
  }
`

const armHelper = String.raw`
  const arm = (element, action, point) => {
    const guard = installGuard()
    guard.latest?.settle()
    let resolve
    const verdict = new Promise((settle) => {
      resolve = settle
    })
    const armed = { element, ...guarded[action], reached: [], intercepted: null }
    armed.settle = () => {
      if (guard.armed === armed) guard.armed = null
      const landed = action === 'click' ? document.elementFromPoint(point.x, point.y) : document.activeElement
      resolve({ reached: armed.reached, intercepted: armed.intercepted, landed: landed === null ? null : describe(landed) })
    }
    guard.count += 1
    guard.armed = armed
    guard.latest = { token: guard.count, verdict, settle: armed.settle }
    return guard.count
  }
`

const actionHelpers = String.raw`
  const fieldTypes = ['text', 'search', 'email', 'url', 'tel', 'password', 'number']
  const isField = (element) =>
    element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && fieldTypes.includes(element.type))
  const describeField = (element) =>
    element instanceof HTMLInputElement ? '<input type="' + element.type + '">' : '<' + element.localName + '>'
  const viewport = () => {
    const root = document.scrollingElement ?? document.documentElement
    return { width: root.clientWidth, height: root.clientHeight }
  }
  const visibleCentre = (box) => {
    const { width, height } = viewport()
    const left = Math.max(box.left, 0)
    const right = Math.min(box.right, width)
    const top = Math.max(box.top, 0)
    const bottom = Math.min(box.bottom, height)
    if (right <= left || bottom <= top) return null
    return { x: (left + right) / 2, y: (top + bottom) / 2 }
  }
  const isCentreInView = (box) => {
    const { width, height } = viewport()
    const x = box.left + box.width / 2
    const y = box.top + box.height / 2
    return x >= 0 && x < width && y >= 0 && y < height
  }
  const boxAfterFrame = (element) =>
    new Promise((resolve) => requestAnimationFrame(() => resolve(element.getBoundingClientRect())))
  const sameBox = (first, second) =>
    first.x === second.x && first.y === second.y && first.width === second.width && first.height === second.height
  const blocked = (check, detail = null) => ({ status: 'blocked', check, detail })
`

/** Installs the input guard in each new document, before the page's own scripts run. */
export const guardScript: string = `(() => {
  ${describeHelper}
  ${guardHelpers}
  installGuard()
})()`

/** Counts the matches and, for a single match, reads whether it is visible and its text. Never waits. */
export const observeFunction: string = `function observe(value) {
  ${helpers}
  const found = find(value)
  if (found.length !== 1) return { count: found.length, visible: null, text: null }
  return { count: 1, visible: isVisible(found[0]), text: found[0].textContent }
}`

/**
 * Checks one match in the order the build plan gives, and returns the point to press. For `fill` it also
 * focuses the field and selects its whole value. Once every check passes it arms the input guard for the
 * element, all in the same task as the hit test, so no page script runs between them.
 */
export const prepareFunction: string = `async function prepare(value, action, multiline) {
  ${helpers}
  ${describeHelper}
  ${guardHelpers}
  ${armHelper}
  ${actionHelpers}
  const found = find(value)
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
  if (action === 'fill') {
    element.focus()
    element.select()
    if (document.activeElement !== element) return blocked('focused')
  }
  return { status: 'ready', x: point.x, y: point.y, token: arm(element, action, point) }
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
