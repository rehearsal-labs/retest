import { titleReadLimit } from '../protocol/page-facts.ts'

// Functions sent to Retest's isolated world in the page, where page scripts cannot reach or replace them.
// Values arrive as call arguments and are never written into this source; Retest's own limits are.

// Matches text the way `matchesText` in text-match.ts does, which a unit test checks. A pattern is a RegExp's source and
// flags, searched for in the normalised text; its position is reset for every text, so a g or y flag carries none.
export const textMatchHelper: string = String.raw`
  const normalize = (text) => text.trim().replace(/\s+/g, ' ')
  const textMatcher = (wanted, exact) => {
    if (typeof wanted !== 'string') {
      const pattern = new RegExp(wanted.pattern, wanted.flags)
      return (text) => {
        pattern.lastIndex = 0
        return pattern.test(normalize(text))
      }
    }
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
  // Only the document's own tree: input in a shadow tree reaches the window as input to its host, so the guard
  // could not tell the element from whatever else is inside that host.
  const inDocument = (element) => element instanceof Element && element.getRootNode() === document
  const documentOrder = (first, second) => (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
  const ordered = (elements) => (elements.length < 2 ? elements : [...new Set(elements)].sort(documentOrder))
  // Inside each root, never a root itself: a step after the first looks inside the elements the step before kept. The
  // first step's roots are null, the whole document.
  const inside = (roots) => (element) => roots.some((root) => root !== element && root.contains(element))
  const under = (roots, selector) => {
    if (roots === null) return [...document.querySelectorAll(selector)]
    return ordered(roots.flatMap((root) => [...root.querySelectorAll(selector)]))
  }
  // The innermost elements whose text matches: an element that holds a match is left out for it. Pushed after
  // their children, they stay in document order, since no element found holds another.
  const byText = (wanted, exact, roots) => {
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
    if (roots !== null) {
      for (const root of roots) for (const child of root.children) if (holdsText(child)) visit(child)
      return ordered(found)
    }
    const root = document.body ?? document.documentElement
    if (root !== null) visit(root)
    return found
  }
  // By Playwright's rules a label names any element through its aria-label, or through the text of the elements its
  // aria-labelledby names.
  const byLabelled = ({ text, exact }, roots) => {
    const matches = textMatcher(text, exact)
    const labelledBy = (element) =>
      (element.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter((id) => id !== '').map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
    const labels = (element) => [element.getAttribute('aria-label'), element.hasAttribute('aria-labelledby') ? labelledBy(element) : null]
    return under(roots, '[aria-label], [aria-labelledby]').filter((element) => labels(element).some((label) => label !== null && matches(label)))
  }
  // An open shadow root of the document, by its host's name, or null: by Playwright's rules a locator looks inside one,
  // and Retest does not.
  const shadowHost = () => {
    for (const element of document.querySelectorAll('*')) if (element.shadowRoot !== null) return '<' + element.localName + '>'
    return null
  }
  const findStep = (step, roots, elements) => {
    if (step.by === 'testId') return under(roots, '[data-testid]').filter((element) => element.getAttribute('data-testid') === step.value)
    if (step.by === 'text') return byText(step.text, step.exact, roots)
    if (step.by === 'placeholder') {
      const matches = textMatcher(step.text, step.exact)
      return under(roots, '[placeholder]').filter((element) => matches(element.getAttribute('placeholder') ?? ''))
    }
    if (step.by === 'css') return under(roots, step.selector)
    const named = elements.slice(step.from, step.from + step.count).filter(inDocument)
    const kept = roots === null ? named : named.filter(inside(roots))
    return ordered(step.labelled === undefined ? kept : [...kept, ...byLabelled(step.labelled, roots)])
  }
  // A pick keeps one match: the first, the last, or the one at an index, counted from the end when negative.
  const pickFrom = (found, pick) => {
    if (pick === null || pick === undefined) return found
    const index = pick === 'first' ? 0 : pick === 'last' ? found.length - 1 : pick < 0 ? found.length + pick : pick
    const kept = found[index]
    return kept === undefined ? [] : [kept]
  }
  // Resolves the steps in order. A CSS selector the page cannot read is named, with the step it is in. When nothing
  // is left, empty names the first step that kept nothing and how many it matched before its pick, unless that is
  // the last step and it matched nothing, which the count of none already says. A query by Playwright's rules finds
  // nothing in a document that holds an open shadow root, and names its host.
  const resolve = (query, elements) => {
    const shadow = query.shadow === 'refused' ? shadowHost() : null
    if (shadow !== null) return { found: [], empty: null, invalid: null, shadow }
    let roots = null
    const last = query.steps.length - 1
    for (const [index, step] of query.steps.entries()) {
      let matched
      try {
        matched = findStep(step, roots, elements)
      } catch (error) {
        if (step.by !== 'css' || !(error instanceof DOMException)) throw error
        return { found: [], empty: null, invalid: { step: index, message: error.message }, shadow }
      }
      roots = pickFrom(matched, step.pick)
      if (roots.length > 0) continue
      const said = index === last && matched.length === 0
      return { found: [], empty: said ? null : { step: index, matched: matched.length }, invalid: null, shadow }
    }
    return { found: roots ?? [], empty: null, invalid: null, shadow }
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
// Added then, it hears the wheel after any wheel listener the page put on the window in the capture phase.
// A chord's keys are each released, so a press settles once it has heard as many key ups as it sent keys.
// A key typed to choose an option is watched further: the select's change may open another document before any
// look could read it, so the guard reads the selection when the select's own input or change event arrives, before
// any listener of the page, in that same task, and answers then, or once the key is released when the key changed
// nothing. The guard also notes the arming during which the page last set off for another document, so a select's
// next key is never typed into a document that is on its way out.
// A hover is the mouse arriving: its over and move events must reach the element. The guard hears them from the
// start of every document, as it does the rest, and lets them pass while no hover is armed.
const guardHelpers = String.raw`
  const guarded = {
    click: { events: ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'], last: 'click' },
    tap: { events: ['pointerdown', 'touchstart', 'pointerup', 'touchend', 'mousedown', 'mouseup', 'click'], last: 'click' },
    fill: { events: ['keydown', 'beforeinput', 'input', 'keyup'], last: 'input' },
    press: { events: ['keydown', 'keypress', 'beforeinput', 'input', 'keyup'], last: 'keyup', decides: 'keydown' },
    scroll: { events: ['wheel'], last: 'wheel', whileArmed: true },
    hover: { events: ['pointerover', 'pointermove', 'mouseover', 'mousemove'], last: 'mousemove' },
  }
  const isTyping = (event) =>
    guarded.fill.events.includes(event.type) && (event instanceof KeyboardEvent || event instanceof InputEvent)
  const installGuard = () => {
    if (globalThis.retestGuard !== undefined) return globalThis.retestGuard
    const guard = { armed: null, latest: null, count: 0, stray: null, setOff: -1 }
    const stop = (event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const hold = (event) => {
      if (event.destination.sameDocument) return
      guard.setOff = guard.count
      const armed = guard.armed
      if (armed === null || armed.origins === null || armed.reached.includes('beforeinput')) return
      event.preventDefault()
      armed.leaving ??= new URL(event.destination.url).origin
    }
    const selectChanged = (event) => {
      const armed = guard.armed
      if (armed === null || armed.watched === null || !event.isTrusted || event.target !== armed.element || armed.selection !== undefined) return
      armed.selection = armed.watched()
      armed.report()
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
        if (armed.watched === null) armed.report()
      }
      // Later events belong to the page, such as the click a label passes on to its field.
      if (event.type === armed.last && (armed.left -= 1) <= 0) armed.settle()
    }
    const options = { capture: true, passive: false }
    const always = Object.values(guarded).filter((entry) => entry.whileArmed !== true)
    for (const type of new Set(always.flatMap(({ events }) => events))) window.addEventListener(type, check, options)
    for (const type of ['input', 'change']) window.addEventListener(type, selectChanged, { capture: true })
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
  const arm = (element, action, point, origins, strokes = 1, watched = null) => {
    const guard = installGuard()
    guard.latest?.settle()
    let resolve
    const verdict = new Promise((settle) => {
      resolve = settle
    })
    const armed = { element, action, ...guarded[action], origins, leaving: null, reached: [], intercepted: null, decided: null, left: strokes, watched }
    const unlisten = armed.whileArmed === true ? guard.listen(armed.events) : () => {}
    // What the guard saw so far, once: an action whose input decides early answers before the rest arrives.
    armed.report = () => {
      const landed = point === null ? document.activeElement : document.elementFromPoint(point.x, point.y)
      const { reached, intercepted, leaving } = armed
      if (watched !== null) armed.selection ??= watched()
      const selection = armed.selection === undefined ? {} : { selection: armed.selection }
      resolve({ reached: [...reached], intercepted, landed: landed === null ? null : describe(landed), leaving, ...selection })
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

// When Retest last readied each element for a key, kept in Retest's world for the document's life. Chrome forgets the
// keys typed into a select a second after the last one, so a select's type-ahead waits until its own second is up.
const typingHelper = String.raw`
  const typing = () => (globalThis.retestTyped ??= new WeakMap())
  const noteTyped = (element) => {
    if (element !== null) typing().set(element, performance.now())
  }
  const quietFor = (element) => {
    const at = typing().get(element)
    return at === undefined ? 0 : Math.max(0, Math.ceil(1100 - (performance.now() - at)))
  }
`

const actionHelpers = String.raw`
  ${typingHelper}
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
  const ready = (point, token, via = null, plan = null) => ({ status: 'ready', point, token, via, scale: visualViewport.scale, page: pageFacts(), plan })
  // A key goes to whatever holds the keyboard focus, never through a point, so there is no hit test.
  const readyForKeys = (element, strokes, watched = null) => {
    if (element.matches(':disabled')) return blocked('enabled')
    const armed = arm(element, 'press', null, null, strokes, watched)
    element.focus()
    if (document.activeElement === element) {
      noteTyped(element)
      return ready(null, armed.token)
    }
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
// Chrome draws a select's list outside the page, where input cannot reach it (fact F3), so a select is chosen with the
// keyboard while it is closed, as a person can. A select that takes one option is typed into: Chrome jumps to the
// next option whose label starts with what was typed in the last second, case aside and leading spaces skipped, and
// a key typed again moves on to the next option starting with it. typeAhead follows that rule, so the plan is the
// shortest start of the label that lands on the option, or its first letter typed until it does. A select that takes
// several moves its focus with a modifier held, which leaves the selection alone, and toggles an option with the
// modifier and Space: the plan starts at the first option and toggles each one whose state is not the one asked for.
// Disabled and hidden options are skipped by that focus, as Chrome skips them.
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
  const selectionOf = (select, choices) => {
    const selected = [...select.selectedOptions].map((option) => option.label)
    const chosen = chooseOptions(select, choices)
    const made = chosen.status === 'chosen' && isSelection(select, chosen.options)
    return { status: made ? 'selected' : 'other', selected, page: pageFacts() }
  }
  const typedLabel = (option) => (option.matches(':disabled') ? '' : option.label.trimStart().toLowerCase())
  const typeAhead = (select, keys) => {
    const labels = [...select.options].map(typedLabel)
    let selected = select.selectedIndex
    let typed = ''
    let repeating = null
    for (const key of keys) {
      typed += key
      let prefix = typed
      let offset = 1
      if (key === repeating) prefix = key
      else if (typed.length > 1) {
        repeating = null
        offset = 0
      } else repeating = key
      let index = ((selected < 0 ? 0 : selected) + offset) % labels.length
      for (let step = 0; step < labels.length; step += 1, index = (index + 1) % labels.length) {
        if (labels[index].startsWith(prefix)) {
          selected = index
          break
        }
      }
    }
    return selected
  }
  const typePlan = (select, target) => {
    const characters = Array.from(typedLabel(target))
    if (characters.length === 0) return null
    const typed = (keys) => ({ quietMs: quietFor(select), keys: keys.map((key) => ({ key, toggle: false })) })
    for (let length = 1; length <= characters.length; length += 1) {
      const keys = characters.slice(0, length)
      if (typeAhead(select, keys) === target.index) return typed(keys)
    }
    const keys = []
    for (let count = 0; count < select.options.length; count += 1) {
      keys.push(characters[0])
      if (typeAhead(select, keys) === target.index) return typed(keys)
    }
    return null
  }
  const togglePlan = (select, chosen) => {
    const options = [...select.options]
    const reachable = options.filter((option) => !option.matches(':disabled') && getComputedStyle(option).display !== 'none')
    if (options.some((option) => !reachable.includes(option) && option.selected !== chosen.includes(option))) return null
    const differs = reachable.map((option) => option.selected !== chosen.includes(option))
    const keys = [{ key: 'Home', toggle: true }]
    for (let index = 0; index <= differs.lastIndexOf(true); index += 1) {
      if (index > 0) keys.push({ key: 'ArrowDown', toggle: true })
      if (differs[index]) keys.push({ key: 'Space', toggle: true })
    }
    return { quietMs: 0, keys }
  }
  const planSelection = (select, chosen) => (select.multiple ? togglePlan(select, chosen) : typePlan(select, chosen[0]))
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
  // In the task of the hit test: the selection is read again, left alone when it is already the one asked for, and
  // otherwise planned as the keys that make it. An option no key can reach is named.
  const finishSelect = (intent, select, point) => {
    const chosen = chooseOptions(select, intent.choices)
    if (chosen.status !== 'chosen') return chosen
    if (isSelection(select, chosen.options)) return { status: 'unchanged', page: pageFacts() }
    const plan = planSelection(select, chosen.options)
    return plan === null ? { status: 'unreachable', element: describe(select) } : ready(point, null, null, plan)
  }
`

/** Installs the input guard in each new document, before the page's own scripts run. */
export const guardScript: string = `(() => {
  ${describeHelper}
  ${guardHelpers}
  installGuard()
})()`

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

// Disabled as toBeEnabled and toBeDisabled read it: a native control that is disabled, on its own or in a disabled
// fieldset, or the nearest aria-disabled on the element or an ancestor saying true.
const stateHelper = String.raw`
  const isDisabled = (element) => {
    if (element.matches(':disabled')) return true
    for (let current = element; current instanceof Element; current = current.parentElement) {
      const value = current.getAttribute('aria-disabled')
      if (value === 'true') return true
      if (value === 'false') return false
    }
    return false
  }
`

/**
 * Finds the matches of `query`, and lists the first `limit` of them; for a single match, reads whether it is
 * visible, its text, for a field its value, for a checkable control whether it is checked, and whether it is
 * enabled. Never waits. A query is a list of steps; an `elements` step takes, from the elements that follow the
 * query, those found already for it. Returns the observation and the page it was read on, or the CSS selector the
 * page could not read.
 */
export const observeFunction: string = `function observe(limit, query, ...elements) {
  ${helpers}
  ${pageFactsHelper}
  ${checkableHelper}
  ${stateHelper}
  const resolved = resolve(query, elements)
  if (resolved.invalid !== null) return { invalid: resolved.invalid }
  if (resolved.shadow !== null) return { shadow: resolved.shadow }
  const { found } = resolved
  const items = found.slice(0, limit).map((element) => ({ text: textOf(element), visible: isVisible(element) }))
  const listed = { count: found.length, items, itemsTruncated: found.length > limit }
  const unread = { visible: null, text: null, value: null, checked: null, enabled: null }
  if (found.length !== 1) {
    const empty = resolved.empty === null ? {} : { emptyStep: resolved.empty }
    return { observation: { ...listed, ...unread, ...empty }, page: pageFacts() }
  }
  const element = found[0]
  const isField = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
  const kind = checkable(element)
  const observation = {
    ...listed,
    visible: isVisible(element),
    text: textOf(element),
    value: isField ? element.value : null,
    checked: kind === null ? null : isChecked(element, kind),
    enabled: !isDisabled(element),
  }
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
 * - `press`: `strokes`, the keys the press holds and presses. It checks that the element is visible and enabled,
 *   arms the guard and focuses it, and is ready with no point once it keeps the focus.
 * - `check`: `checked`, the state asked for, and `pointer`, the input that clicks it. A control already in that
 *   state is `unchanged`. A hidden native control is checked and armed through its one visible label.
 * - `select`: `choices` and `multiple`. Each choice must name one enabled option. A select already as asked is
 *   `unchanged`; otherwise it is ready with the plan of keys that choose the options, and nothing is armed. With
 *   `typing`, it is readied for one of those keys as a press is, with `strokes`.
 * - `hover` checks what a click does, except that the element may be disabled.
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
  const resolved = resolve(query, elements)
  if (resolved.invalid !== null) return { status: 'invalid', ...resolved.invalid }
  if (resolved.shadow !== null) return { status: 'shadow', host: resolved.shadow }
  const { found } = resolved
  if (found.length === 0) return { status: 'missing', empty: resolved.empty }
  if (found.length > 1) return { status: 'ambiguous', count: found.length }
  const control = found[0]
  const fitted = fit(intent, control)
  if (fitted.settled !== undefined) return fitted.settled
  const { element, via = null } = fitted
  if (!isVisible(element)) return blocked('visible')
  if (action === 'press') return readyForKeys(element, intent.strokes)
  if (intent.typing === true) return readyForKeys(element, intent.strokes, () => selectionOf(element, intent.choices))
  if (!isCentreInView(element.getBoundingClientRect())) {
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  }
  const before = await boxAfterFrame(element)
  const after = await boxAfterFrame(element)
  if (!element.isConnected) return blocked('attached')
  if (!isVisible(element)) return blocked('visible')
  if (action !== 'hover' && control.matches(':disabled')) return blocked('enabled')
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
 * key for the page's keyboard, which goes to whatever holds the focus, with the `strokes` it holds and presses, or
 * the wheel at the centre of the viewport. Any element of this document may take it.
 */
export const armDocumentFunction: string = `function armDocument(action, strokes) {
  ${describeHelper}
  ${guardHelpers}
  ${armHelper}
  ${pageFactsHelper}
  ${actionHelpers}
  const view = viewport()
  const point = action === 'scroll' ? { x: (view.left + view.right) / 2, y: (view.top + view.bottom) / 2 } : null
  if (action === 'press') noteTyped(document.activeElement)
  return ready(point, arm(document, action, point, null, strokes).token)
}`

/**
 * Whether the one element `query` finds is checked, as `check` reads it, or null when there is not exactly one
 * such element, or it is not a control that can be checked.
 */
export const checkedFunction: string = `function checked(query, ...elements) {
  ${helpers}
  ${checkableHelper}
  const { found } = resolve(query, elements)
  if (found.length !== 1) return null
  const kind = checkable(found[0])
  return kind === null ? null : isChecked(found[0], kind)
}`

/**
 * Whether the one select `query` finds holds exactly the options `choices` name, and the labels of the options it
 * holds, with the page it is on. `lost` when there is not exactly one select, or the choices no longer name options.
 */
export const selectionFunction: string = `function selection(choices, query, ...elements) {
  ${helpers}
  ${pageFactsHelper}
  ${selectHelper}
  const { found } = resolve(query, elements)
  const select = found.length === 1 ? found[0] : null
  if (!(select instanceof HTMLSelectElement)) return { status: 'lost', selected: [], page: pageFacts() }
  return selectionOf(select, choices)
}`

/**
 * A look at the page for `toHaveURL` and `toHaveTitle`: its whole address and title, as the page has them, each read
 * up to Retest's limit, and the parts it held more of.
 */
export const pageLookFunction: string = `function lookAtPage() {
  ${titleHelper}
  const title = titleOf()
  const href = location.href
  const url = href.length > ${titleReadLimit} ? href.slice(0, ${titleReadLimit}) : href
  const cut = [...(url.length < href.length ? ['url'] : []), ...(title.length < document.title.length ? ['title'] : [])]
  return { url, title, cut }
}`

/** The page's address and title, as the page has them. */
export const pageFactsFunction: string = `function readPageFacts() {
  ${pageFactsHelper}
  return pageFacts()
}`

/**
 * Whether this document set off for another since the arming `token` began: a navigation of the whole document that
 * its guard saw start, whether or not it commits.
 */
export const setOffFunction: string = `function setOff(token) {
  const guard = globalThis.retestGuard
  return guard !== undefined && guard.setOff >= token
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
