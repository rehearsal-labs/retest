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

// How the page's tree reaches through open shadow roots. `parentOf` is an element's parent element, or for the top of
// a shadow tree its host, and `holds` whether a node is inside another, its own tree or a shadow tree inside it.
// `drawnIn` says a node is drawn inside an element as the page lays it out, through the slots that show it, and
// `reaches` that input at a node reaches an element, either way. `elementAt` and `focusedElement` follow the hit test
// and the focus into open shadow roots, where the document alone stops at the host. `outsideClosedRoots` says a node is
// in no closed root: a closed root keeps its inside to itself.
const treeHelper = String.raw`
  const parentOf = (node) => node.parentElement ?? (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null)
  const holds = (root, node) => {
    for (let current = node; current !== null; ) {
      if (root === current || root.contains(current)) return true
      const tree = current.getRootNode()
      current = tree instanceof ShadowRoot ? tree.host : null
    }
    return false
  }
  const shownParent = (node) => node.assignedSlot ?? parentOf(node)
  const drawnIn = (element, node) => {
    for (let current = node; current !== null && current !== undefined; current = shownParent(current)) if (current === element) return true
    return false
  }
  const reaches = (element, node) => holds(element, node) || drawnIn(element, node)
  // The document names the host for what its open root draws at a point, and a root names the host again for the
  // host's own text that one of its slots draws: that text's slot is what is drawn there.
  const slotAt = (host, x, y) => {
    if (!host.shadowRoot) return null
    for (const child of host.childNodes) {
      if (child.nodeType !== Node.TEXT_NODE || !child.assignedSlot) continue
      const range = document.createRange()
      range.selectNodeContents(child)
      if ([...range.getClientRects()].some((box) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom)) return child.assignedSlot
    }
    return null
  }
  const elementAt = (x, y) => {
    let found = document.elementFromPoint(x, y)
    while (found !== null && found.shadowRoot) {
      const inner = found.shadowRoot.elementFromPoint(x, y)
      if (inner === null || inner === found) break
      found = inner
    }
    return found === null ? null : (slotAt(found, x, y) ?? found)
  }
  const focusedElement = () => {
    let focused = document.activeElement
    while (focused !== null && focused.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement
    return focused
  }
  // Only an open root is its host's shadowRoot. A closed root, or the browser's own inside a control, is not; and
  // reading such a root's mode stops Chrome's renderer for the browser's own.
  const outsideClosedRoots = (node) => {
    for (let root = node.getRootNode(); root instanceof ShadowRoot; root = root.host.getRootNode()) if (root.host.shadowRoot !== root) return false
    return true
  }
`

const helpers = String.raw`
  ${textMatchHelper}
  ${treeHelper}
  // An element's text is that of its text nodes and descendants, except inside elements whose content no one reads,
  // then that of its open shadow root, as Playwright reads it. Text a slot shows stays its own element's: a slot holds
  // only its fallback, so a match on the text of <my-button>Pay now</my-button> is <my-button>, whose box is drawn.
  const skipped = ['script', 'style', 'template', 'noscript']
  const isText = (node) => node.nodeType === Node.TEXT_NODE
  const holdsText = (node) => node instanceof Element && !skipped.includes(node.localName)
  const childrenOf = (node) => (node instanceof Element && node.shadowRoot ? [...node.childNodes, ...node.shadowRoot.childNodes] : [...node.childNodes])
  // What a node shows inside it, as the page lays it out: an open shadow root's content in place of the host's
  // children, which its slots show where they stand, and a slot's assigned nodes, or its own when none are assigned.
  // The host's children no slot takes come last, so every node is reached once.
  const shownIn = (node) => {
    if (node instanceof HTMLSlotElement) {
      const assigned = node.assignedNodes()
      return assigned.length > 0 ? assigned : [...node.childNodes]
    }
    const shadow = node instanceof Element ? node.shadowRoot : null
    if (!shadow) return [...node.childNodes]
    return [...shadow.childNodes, ...[...node.childNodes].filter((child) => !child.assignedSlot)]
  }
  const textOf = (element) => {
    let text = ''
    for (const child of childrenOf(element)) {
      if (isText(child)) text += child.data
      else if (holdsText(child)) text += textOf(child)
    }
    return text
  }
  const documentOrder = (first, second) => (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
  // Every element by its place in a walk of what each node shows, from the document down: the order the page shows
  // them in, across shadow roots.
  const shownOrder = () => {
    const order = new Map()
    const walk = (node) => {
      for (const child of shownIn(node)) {
        if (!(child instanceof Element) || order.has(child)) continue
        order.set(child, order.size)
        walk(child)
      }
    }
    walk(document)
    return order
  }
  // Matches in one tree keep the document's order. Matches across shadow roots, which the document cannot order, take
  // the order the page shows them in.
  const ordered = (elements) => {
    if (elements.length < 2) return elements
    const unique = [...new Set(elements)]
    const tree = unique[0].getRootNode()
    if (unique.every((element) => element.getRootNode() === tree)) return unique.sort(documentOrder)
    const order = shownOrder()
    const place = (element) => order.get(element) ?? order.size
    return unique.sort((first, second) => place(first) - place(second))
  }
  // Inside each root, never a root itself: a step after the first looks inside the elements the step before kept. The
  // first step's roots are null, the whole document.
  const inside = (roots) => (element) => roots.some((root) => root !== element && holds(root, element))
  // Every open shadow root of the document, roots inside roots included, read once for each resolution.
  let openRoots = null
  const shadowRoots = () => {
    if (openRoots !== null) return openRoots
    openRoots = []
    const visit = (holder) => {
      for (const element of holder.querySelectorAll('*')) {
        if (!element.shadowRoot) continue
        openRoots.push(element.shadowRoot)
        visit(element.shadowRoot)
      }
    }
    visit(document)
    return openRoots
  }
  // A selector list split as CSS reads it, outside quotes, brackets and parentheses: each selector as its compound
  // selectors, the last one rightmost, each with the combinator before it.
  const splitSelector = (selector) => {
    const list = []
    let parts = []
    let compound = ''
    let combinator = null
    let depth = 0
    let quote = null
    const close = () => {
      if (compound.trim() === '') return
      parts.push({ combinator: parts.length === 0 ? null : (combinator ?? ' '), compound: compound.trim() })
      compound = ''
      combinator = null
    }
    for (let index = 0; index < selector.length; index += 1) {
      const character = selector[index]
      if (character === '\\') {
        compound += character + (selector[index + 1] ?? '')
        index += 1
      } else if (quote !== null) {
        compound += character
        if (character === quote) quote = null
      } else if (character === '"' || character === "'") {
        quote = character
        compound += character
      } else if (character === '(' || character === '[') {
        depth += 1
        compound += character
      } else if (character === ')' || character === ']') {
        depth -= 1
        compound += character
      } else if (depth > 0) {
        compound += character
      } else if (character === ',') {
        close()
        list.push(parts)
        parts = []
      } else if (character === '>' || character === '+' || character === '~') {
        close()
        combinator = character
      } else if (/\s/.test(character)) {
        close()
        if (parts.length > 0) combinator ??= ' '
      } else {
        compound += character
      }
    }
    close()
    list.push(parts)
    return list
  }
  // :scope names the element a scoped step looks inside, and the root element for the document.
  const matchesCompound = (element, compound, scope) => (compound.includes(':scope') ? element === scope && element.matches(compound) : element.matches(compound))
  const matchesFrom = (element, parts, index, scope) => {
    const { compound, combinator } = parts[index]
    if (!matchesCompound(element, compound, scope)) return false
    if (index === 0) return true
    if (combinator === '>') {
      const parent = parentOf(element)
      return parent !== null && matchesFrom(parent, parts, index - 1, scope)
    }
    if (combinator === '+') {
      const before = element.previousElementSibling
      return before !== null && matchesFrom(before, parts, index - 1, scope)
    }
    const next = combinator === '~' ? (current) => current.previousElementSibling : parentOf
    for (let current = next(element); current !== null; current = next(current)) if (matchesFrom(current, parts, index - 1, scope)) return true
    return false
  }
  // The elements a CSS selector matches inside a root, or the whole document for null, through open shadow roots, as
  // Playwright's CSS engine matches: each compound selector of a selector may stand on either side of a shadow root's
  // edge. The browser matches the tree the root is in, and refuses a selector it cannot read; Retest matches the rest,
  // inside shadow roots, compound by compound, with the browser's own matching for each.
  const cssIn = (root, selector) => {
    const scope = root ?? document
    const matched = [...scope.querySelectorAll(selector)]
    const shadows = shadowRoots().filter((shadow) => root === null || holds(root, shadow.host))
    const inShadowTree = root !== null && root.getRootNode() instanceof ShadowRoot
    if (shadows.length === 0 && !inShadowTree) return matched
    const list = splitSelector(selector)
    const scopeElement = root ?? document.documentElement
    if (list.every((parts) => parts.length === 1) && !selector.includes(':scope')) {
      return ordered([...matched, ...shadows.flatMap((shadow) => [...shadow.querySelectorAll(selector)])])
    }
    const candidates = [...(inShadowTree ? scope.querySelectorAll('*') : []), ...shadows.flatMap((shadow) => [...shadow.querySelectorAll('*')])]
    const pierced = candidates.filter((element) => list.some((parts) => parts.length > 0 && matchesFrom(element, parts, parts.length - 1, scopeElement)))
    return ordered([...matched, ...pierced])
  }
  const under = (roots, selector) => {
    if (roots === null) return cssIn(null, selector)
    return ordered(roots.flatMap((root) => cssIn(root, selector)))
  }
  // The innermost elements whose text matches: an element that holds a match is left out for it. Pushed after
  // their children, in a walk of each element's children then its open root's.
  const byText = (wanted, exact, roots) => {
    const matches = textMatcher(wanted, exact)
    const found = []
    const visit = (element) => {
      let text = ''
      let below = false
      for (const child of childrenOf(element)) {
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
      for (const root of roots) for (const child of childrenOf(root)) if (holdsText(child)) visit(child)
      return ordered(found)
    }
    const root = document.body ?? document.documentElement
    if (root !== null) visit(root)
    return ordered(found)
  }
  // By Playwright's rules a label names any element through its aria-label, or through the text of the elements its
  // aria-labelledby names, in the element's own tree, as the browser reads it: a shadow root's ids are its own.
  const byLabelled = ({ text, exact }, roots) => {
    const matches = textMatcher(text, exact)
    const labelledBy = (element) => {
      const tree = element.getRootNode()
      return (element.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter((id) => id !== '').map((id) => tree.getElementById?.(id)?.textContent ?? '').join(' ')
    }
    const labels = (element) => [element.getAttribute('aria-label'), element.hasAttribute('aria-labelledby') ? labelledBy(element) : null]
    return under(roots, '[aria-label], [aria-labelledby]').filter((element) => labels(element).some((label) => label !== null && matches(label)))
  }
  // A file input a label names: through a <label> for it or around it, its aria-label, or the elements its
  // aria-labelledby names. Chrome's tree names an unlabelled file input after its own button's text, which no page
  // wrote and which changes with the browser's language, so a file input is found by its label alone. One that is not
  // shown, or that aria-hidden or inert hides, is left out, as the tree leaves out what it hides.
  const byFileLabel = ({ text, exact }, roots) => {
    const matches = textMatcher(text, exact)
    const labelledBy = (element) => {
      const tree = element.getRootNode()
      return (element.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter((id) => id !== '').map((id) => tree.getElementById?.(id)?.textContent ?? '').join(' ')
    }
    const names = (input) => [...[...(input.labels ?? [])].map(textOf), input.getAttribute('aria-label'), input.hasAttribute('aria-labelledby') ? labelledBy(input) : null]
    const shown = (input) => input.checkVisibility({ visibilityProperty: true }) && input.closest('[aria-hidden="true"], [inert]') === null
    return under(roots, 'input').filter((input) => input.type === 'file' && shown(input) && names(input).some((name) => name !== null && matches(name)))
  }
  // Every word an element in an open root could take its name from: the text and attribute values of the root, and of
  // its host and every host around it, whose own content the root's slots can show.
  const nameWordsOf = (shadow) => {
    const parts = []
    const read = (node) => {
      parts.push(node.textContent ?? '')
      for (const element of node.querySelectorAll('*')) for (const attribute of element.attributes) parts.push(attribute.value)
    }
    read(shadow)
    for (let host = shadow.host; host !== null; ) {
      for (const attribute of host.attributes) parts.push(attribute.value)
      read(host)
      const tree = host.getRootNode()
      host = tree instanceof ShadowRoot ? tree.host : null
    }
    return normalize(parts.join(' ')).toLowerCase()
  }
  // Whether an open root could hold an element the step finds by role or label: one of its candidates, which a custom
  // element always is, since it can give itself a role, and, for a name, every word of it among the root's words, or an
  // element whose name the page never writes.
  const holdsCandidate = (shadow, step) => {
    const candidate = shadow.querySelector(step.shadow.candidates) !== null || [...shadow.querySelectorAll('*')].some((element) => element.localName.includes('-'))
    if (!candidate || step.shadow.named === null) return candidate
    if (step.shadow.unnamed !== null && shadow.querySelector(step.shadow.unnamed) !== null) return true
    const words = nameWordsOf(shadow)
    return step.shadow.named.split(' ').every((word) => words.includes(word))
  }
  // The host of the first open shadow root inside the roots, or in the document for null, that could hold an element
  // the step finds, by its name, or null.
  const shadowHostIn = (roots, step) => {
    const shadow = shadowRoots().find((each) => (roots === null || roots.some((root) => holds(root, each.host))) && holdsCandidate(each, step))
    return shadow === undefined ? null : '<' + shadow.host.localName + '>'
  }
  const findStep = (step, roots, elements) => {
    if (step.by === 'testId') return under(roots, '[data-testid]').filter((element) => element.getAttribute('data-testid') === step.value)
    if (step.by === 'text') return byText(step.text, step.exact, roots)
    if (step.by === 'placeholder') {
      const matches = textMatcher(step.text, step.exact)
      return under(roots, '[placeholder]').filter((element) => matches(element.getAttribute('placeholder') ?? ''))
    }
    if (step.by === 'css') return under(roots, step.selector)
    const fileInputs = step.files === undefined ? [] : byFileLabel(step.files, roots)
    const named = [...elements.slice(step.from, step.from + step.count), ...fileInputs].filter(outsideClosedRoots)
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
  // the last step and it matched nothing, which the count of none already says. A role or label step of an engine whose
  // tree does not look inside shadow roots, which carries its shadow candidates, finds nothing where an open root inside its search
  // could hold what it asks for, and names that root's host.
  const resolve = (query, elements) => {
    openRoots = null
    let roots = null
    const last = query.steps.length - 1
    for (const [index, step] of query.steps.entries()) {
      const host = step.by === 'elements' && step.shadow !== undefined ? shadowHostIn(roots, step) : null
      if (host !== null) return { found: [], empty: null, invalid: null, shadow: host }
      let matched
      try {
        matched = findStep(step, roots, elements)
      } catch (error) {
        if (step.by !== 'css' || !(error instanceof DOMException)) throw error
        return { found: [], empty: null, invalid: { step: index, message: error.message }, shadow: null }
      }
      roots = pickFrom(matched, step.pick)
      if (roots.length > 0) continue
      const said = index === last && matched.length === 0
      return { found: [], empty: said ? null : { step: index, matched: matched.length }, invalid: null, shadow: null }
    }
    return { found: roots ?? [], empty: null, invalid: null, shadow: null }
  }
  // A document inside a frame that is hidden in the page shows none of its elements, whatever its own styles say.
  const isVisible = (element) => {
    if (globalThis.retestFrameHidden === true) return false
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
// An event inside an open shadow root reaches the window named for its host; the guard reads the element it is for
// from the event's path, so an element inside a shadow root is told from the rest of its host.
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
  // The element an event is for, inside open shadow roots too: at the window an event in a shadow tree names its host.
  // A relay's stand-in for an event that has no path of its own names its target itself.
  const targetOf = (event) => {
    try {
      return event.composedPath()[0] ?? event.target
    } catch {
      return event.target
    }
  }
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
      const target = targetOf(event)
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
      } else if (target instanceof Node && reaches(armed.element, target)) {
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
      const landed = point === null ? focusedElement() : elementAt(point.x, point.y)
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
    guard.latest = { token: guard.count, verdict, settle: armed.settle, requested: false }
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
  // Keys go to the focused element of the focused frame: in a frame, the frame itself must hold the focus too. The page's
  // own document is asked nothing more, since a page in a tab the browser does not show has no focus and still takes
  // keys. A driver may give page functions a window of its own, as Firefox's does for its relays, so the document's
  // own window is read from the global.
  const keepsFocus = (element) => focusedElement() === element && (globalThis.window === globalThis.window.top || document.hasFocus())
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
    if (keepsFocus(element)) {
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
    if (chosen.status !== 'chosen') return settled(chosen)
    // An engine that sends no toggle refuses a plan that needs one whatever the page draws, so it does not wait to draw.
    if (intent.toggles === false && !isSelection(control, chosen.options)) {
      const plan = planSelection(control, chosen.options)
      if (plan !== null && plan.keys.some((planned) => planned.toggle)) return settled({ status: 'unsupported', reason: 'toggle', element: describe(control) })
    }
    return { element: control }
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
  ${treeHelper}
  ${describeHelper}
  ${guardHelpers}
  installGuard()
})()`

/** The binding `Runtime.addBinding` gives Retest's world in every document, which the change script calls. */
export const changeBinding: string = 'retestChanged'

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
// fieldset, or the nearest aria-disabled on the element or an ancestor saying true, a shadow root's host included.
const stateHelper = String.raw`
  const isDisabled = (element) => {
    if (element.matches(':disabled')) return true
    for (let current = element; current instanceof Element; current = parentOf(current)) {
      const value = current.getAttribute('aria-disabled')
      if (value === 'true') return true
      if (value === 'false') return false
    }
    return false
  }
`

// What a look reads of a resolved locator's matches: the first `limit` listed with their text and visibility, and for
// a single match its state. Both looks, plain and keyed, read through it, so they read alike.
const observationHelper = String.raw`
  const observationOf = (limit, resolved) => {
    const { found } = resolved
    const items = found.slice(0, limit).map((element) => ({ text: textOf(element), visible: isVisible(element) }))
    const listed = { count: found.length, items, itemsTruncated: found.length > limit }
    const unread = { visible: null, text: null, value: null, checked: null, enabled: null }
    if (found.length !== 1) {
      const empty = resolved.empty === null ? {} : { emptyStep: resolved.empty }
      return { ...listed, ...unread, ...empty }
    }
    const element = found[0]
    const isField = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
    const kind = checkable(element)
    return {
      ...listed,
      visible: isVisible(element),
      text: textOf(element),
      value: isField ? element.value : null,
      checked: kind === null ? null : isChecked(element, kind),
      enabled: !isDisabled(element),
    }
  }
`

// The keys a keyed look gives the elements it lists, kept in Retest's world for the life of the document: one key per
// node, never another node's, held in a WeakMap so a key keeps no node alive. Each key starts with a token this world
// draws when it first keys an element, so a key read in an earlier document, whose world drew another, names nothing
// here. The page cannot reach this world, so it can neither read a key nor move one to another node.
const keysHelper = String.raw`
  const elementKeys = () => {
    if (globalThis.retestKeys === undefined) {
      const token = Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, '0')).join('')
      globalThis.retestKeys = { token, count: 0, keys: new WeakMap() }
    }
    return globalThis.retestKeys
  }
  const keyOf = (element) => {
    const known = elementKeys()
    const kept = known.keys.get(element)
    if (kept !== undefined) return kept
    known.count += 1
    const key = known.token + '-' + known.count
    known.keys.set(element, key)
    return key
  }
  const isKeyed = (element, key) => elementKeys().keys.get(element) === key
`

// Whether a read's one element is the node its query is pinned to, when the query carries a key as query.element; a
// query with none is pinned to nothing. It reads the keys the keyed look keeps straight from their store, which a
// document nothing keyed has none of, so it declares none of that look's helpers and sits beside them in any function.
const pinnedReadHelper = String.raw`
  const pinnedIn = (query, element) => typeof query.element !== 'string' || globalThis.retestKeys?.keys.get(element) === query.element
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
  ${observationHelper}
  const resolved = resolve(query, elements)
  if (resolved.invalid !== null) return { invalid: resolved.invalid }
  if (resolved.shadow !== null) return { shadow: resolved.shadow }
  const observation = observationOf(limit, resolved)
  return { observation, page: pageFacts() }
}`

/**
 * Reads several locators' matches, each exactly as `observe` reads one, all in this one call, so no script of the
 * page runs between them, and gives each element listed the key this document's world keeps for it: the same key for
 * the same node in every read of the document. `queries` holds one query per locator; their `elements` steps take
 * from the elements that follow, as `observe`'s do. Returns a read per query and the page they were read on, or the
 * first CSS selector the page could not read, or the host of an open shadow root, each with its query's place. Never
 * waits, and sends no input.
 */
export const keyedObserveFunction: string = `function observeKeyed(limit, queries, ...elements) {
  ${helpers}
  ${pageFactsHelper}
  ${checkableHelper}
  ${stateHelper}
  ${observationHelper}
  ${keysHelper}
  const reads = []
  for (const [place, query] of queries.entries()) {
    const resolved = resolve(query, elements)
    if (resolved.invalid !== null) return { invalid: resolved.invalid, query: place }
    if (resolved.shadow !== null) return { shadow: resolved.shadow, query: place }
    reads.push({ observation: observationOf(limit, resolved), keys: resolved.found.slice(0, limit).map(keyOf) })
  }
  return { reads, page: pageFacts() }
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
 *
 * Any action may carry `element`, the key a keyed look gave one node: the one match must then be that node, or the
 * look answers `moved` before it focuses, scrolls, arms or reads anything of the element.
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
  ${keysHelper}
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
  if (typeof intent.element === 'string' && !isKeyed(control, intent.element)) return { status: 'moved' }
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
  // The page can reorder matches during the frames. Recheck the pin in the same task that arms the input.
  if (typeof intent.element === 'string') {
    const current = resolve(query, elements).found
    if (current.length !== 1 || current[0] !== control || !isKeyed(current[0], intent.element)) return { status: 'moved' }
  }
  if (!element.isConnected) return blocked('attached')
  if (!isVisible(element)) return blocked('visible')
  if (action !== 'hover' && control.matches(':disabled')) return blocked('enabled')
  if (action === 'fill' && element.readOnly) return blocked('editable')
  if (!sameBox(before, after)) return blocked('stable')
  const point = visibleCentre(after)
  if (point === null) return blocked('in-view')
  const hit = elementAt(point.x, point.y)
  if (hit === null) return blocked('hit-target')
  if (!reaches(element, hit)) return blocked('hit-target', describe(hit))
  if (action === 'select') return finishSelect(intent, element, point)
  if (action === 'check' && isChecked(control, fitted.kind) === intent.checked) return { status: 'unchanged', page: pageFacts() }
  const armed = arm(element, intent.pointer ?? action, action === 'fill' ? null : point, origins)
  if (action === 'fill') {
    element.focus()
    element.select()
    const refusal = armed.leaving === null ? null : { status: 'refused', origin: armed.leaving, leaving: true }
    const unready = refusal ?? (keepsFocus(element) ? null : blocked('focused'))
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
  ${treeHelper}
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
 * such element, or it is not a control that can be checked. A query pinned to one node (`query.element`, a key a keyed
 * look gave it) reads that node only, and null when another is in its place.
 */
export const checkedFunction: string = `function checked(query, ...elements) {
  ${helpers}
  ${checkableHelper}
  ${pinnedReadHelper}
  const { found } = resolve(query, elements)
  if (found.length !== 1 || !pinnedIn(query, found[0])) return null
  const kind = checkable(found[0])
  return kind === null ? null : isChecked(found[0], kind)
}`

/**
 * Whether the one select `query` finds holds exactly the options `choices` name, and the labels of the options it
 * holds, with the page it is on. `lost` when there is not exactly one select, or the choices no longer name options,
 * or, for a query pinned to one node (`query.element`), when another select is in its place. WebKit's list plan is
 * built from this source up to its last line, so that line stays as it is.
 */
export const selectionFunction: string = `function selection(choices, query, ...elements) {
  ${helpers}
  ${pageFactsHelper}
  ${selectHelper}
  ${pinnedReadHelper}
  const { found } = resolve(query, elements)
  const select = found.length === 1 && pinnedIn(query, found[0]) ? found[0] : null
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
  latest.requested = true
  return latest.verdict
}`

/** Whether the verdict request entered this document for the guard armed with `token`. */
export const registrationFunction: string = `function registered(token) {
  const latest = globalThis.retestGuard?.latest
  return latest?.token === token && latest.requested === true
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

/**
 * Reads what a layout look measures, all in this one call, so no script of the page runs between the elements it
 * reads. For each query's one match inside the body it lists that element and every element around it up to the
 * body, as the page lays them out through open shadow roots, each once and after its parent, with its client rect, the parts of its computed style a layout rule reads,
 * whether it holds text of its own, whether it is a field, and how far its content runs past its client box; with
 * `words`, also the first `limit` elements inside it. It reads the viewport's size, the root's client and scroll
 * widths, and the root's and the body's horizontal overflow. It applies no rule: the parent measures what it read.
 * Returns the reading and the page it read it on, or the first CSS selector the page could not read, or the host of an
 * open shadow root, each with its query's place. Never waits, and sends no input.
 */
export const layoutFunction: string = `function readLayout(words, limit, queries, ...elements) {
  ${helpers}
  ${pageFactsHelper}
  const root = document.documentElement
  const body = document.body
  const nodes = []
  const places = new Map()
  const styleOf = (element) => {
    const style = getComputedStyle(element)
    return {
      display: style.display,
      visibility: globalThis.retestFrameHidden === true ? 'hidden' : style.visibility,
      opacity: Number(style.opacity),
      position: style.position,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      textOverflow: style.textOverflow,
      lineClamp: style.getPropertyValue('-webkit-line-clamp'),
    }
  }
  const boxOf = (element) => {
    const rect = element.getBoundingClientRect()
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
  }
  const ownWords = (element) => [...element.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && child.data.trim() !== '')
  const isField = (element) => element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement
  // The element around another as the page lays it out: the slot that shows it, or its parent, or for the top of a
  // shadow tree its host.
  const layoutParent = (element) => element.assignedSlot ?? element.parentElement ?? (element.parentNode instanceof ShadowRoot ? element.parentNode.host : null)
  // The first elements the page shows inside an element, through open shadow roots, up to the limit.
  const shownBelow = (element) => {
    const found = []
    const walk = (node) => {
      for (const child of shownIn(node)) {
        if (found.length >= limit) return
        if (!(child instanceof Element)) continue
        found.push(child)
        walk(child)
      }
    }
    walk(element)
    return found
  }
  // Lists the element after every element around it that is not listed yet, up to the body, which starts every list.
  const placeOf = (element) => {
    const chain = []
    for (let current = element; current !== null && !places.has(current); current = current === body ? null : layoutParent(current)) chain.push(current)
    for (const current of chain.reverse()) {
      const parent = current === body ? -1 : places.get(layoutParent(current))
      const overrun = { across: current.scrollWidth - current.clientWidth, down: current.scrollHeight - current.clientHeight }
      places.set(current, nodes.length)
      nodes.push({ parent, box: boxOf(current), style: styleOf(current), words: ownWords(current), field: isField(current), overrun })
    }
    return places.get(element)
  }
  const targets = []
  for (const [place, query] of queries.entries()) {
    const resolved = resolve(query, elements)
    if (resolved.invalid !== null) return { invalid: resolved.invalid, query: place }
    if (resolved.shadow !== null) return { shadow: resolved.shadow, query: place }
    const { found } = resolved
    const empty = resolved.empty === null ? {} : { emptyStep: resolved.empty }
    const element = found.length === 1 ? found[0] : null
    const inBody = element !== null && body !== null && element !== body && holds(body, element)
    const node = inBody ? placeOf(element) : null
    const inner = inBody && words ? shownBelow(element).map(placeOf) : []
    targets.push({ count: found.length, ...empty, node, inner })
  }
  const page = {
    width: innerWidth,
    height: innerHeight,
    edge: root.clientWidth,
    scrollWidth: root.scrollWidth,
    rootOverflowX: getComputedStyle(root).overflowX,
    bodyOverflowX: body === null ? null : getComputedStyle(body).overflowX,
  }
  return { reading: { targets, nodes, page }, page: pageFacts() }
}`

/**
 * What a page function of another module needs to find a locator's elements as every look here finds them, to
 * describe one, and to read the page it is on: `resolve`, `describe` and `pageFacts`, among the rest.
 */
export const locatorHelpers: string = `${helpers}
${describeHelper}
${pageFactsHelper}`

// The one element a frame's recipe finds in this document, which must be an <iframe> or a <frame>: the frame, or why
// there is none to use, as a look says it: no match, with the step that kept nothing, several, another element, or a
// CSS selector the page could not read.
const frameLookupHelper = String.raw`
  const lookUpFrame = (query, elements) => {
    const resolved = resolve(query, elements)
    if (resolved.invalid !== null) return { status: 'invalid', ...resolved.invalid }
    const { found } = resolved
    if (found.length === 0) return { status: 'missing', empty: resolved.empty }
    if (found.length > 1) return { status: 'ambiguous', count: found.length }
    const [frame] = found
    if (frame instanceof HTMLIFrameElement || frame instanceof HTMLFrameElement) return { status: 'frame', frame }
    return { status: 'element', element: describe(frame) }
  }
`

/**
 * Finds a frame's element in this document by its recipe's query, and gives the element itself, as an object of this
 * world, or, as JSON text, why there is none: as `lookUpFrame` says it. The browser then names the frame the element
 * holds. With `reveal`, a frame out of this document's view is first scrolled just into it, as an action brings its
 * element into view: a frame of another site out of view is never drawn, and runs no animation frame an action waits
 * for. Never waits, and sends no input.
 */
export const frameElementFunction: string = `function frameElement(reveal, query, ...elements) {
  ${helpers}
  ${describeHelper}
  ${frameLookupHelper}
  const looked = lookUpFrame(query, elements)
  if (looked.status !== 'frame') return JSON.stringify(looked)
  const { frame } = looked
  if (reveal) {
    const box = frame.getBoundingClientRect()
    const { offsetLeft, offsetTop, width, height } = visualViewport
    const seen = box.right > offsetLeft && box.left < offsetLeft + width && box.bottom > offsetTop && box.top < offsetTop + height
    if (!seen) frame.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
  }
  return frame
}`

/**
 * Whether a frame's element, `this`, is shown in its own document, as a look reads an element: a frame inside an
 * element that is hidden shows nothing of its document, whatever that document says of its own elements.
 */
export const frameShownFunction: string = `function frameShown() {
  ${helpers}
  return isVisible(this)
}`

/**
 * Tells a frame's document whether the frame is hidden in the page, as `frameShown` read each frame around it. While it
 * is, every look there reads each element hidden, and a layout reads each one's visibility as hidden.
 */
export const frameHiddenFunction: string = `function frameHidden(hidden) {
  globalThis.retestFrameHidden = hidden
  return hidden
}`

/**
 * Places a point of a frame's document in this document, the frame's parent: the point, scaled as the frame's element
 * is drawn, as under a CSS scale, plus the top left corner of that element's content box. `query` finds the
 * element. A point outside this document's view is brought into it, first by the frame's own element, then by the
 * document's scroll. As `prepare` checks an element, it checks the frame's element is shown, waits for it to stand
 * still for a frame of the page's, and checks that the element at the point is the frame's own, so an element here that
 * covers the frame is named. Then, for pointer input (`action`, or null for keys), it arms this document's input guard
 * for the frame's element, in the task of the hit test, so a press another element of this document takes is stopped
 * before any listener hears it. Returns the point, the visual viewport's scale and the guard's token, or why the point
 * cannot be placed, as `lookUpFrame` says it or as a blocked check.
 */
export const placeFunction: string = `async function place(point, action, query, ...elements) {
  ${helpers}
  ${describeHelper}
  ${guardHelpers}
  ${armHelper}
  ${frameLookupHelper}
  const looked = lookUpFrame(query, elements)
  if (looked.status !== 'frame') return looked
  const { frame } = looked
  if (!isVisible(frame)) return { status: 'blocked', check: 'visible', detail: null }
  const view = () => {
    const { offsetLeft, offsetTop, width, height } = visualViewport
    return { left: offsetLeft, top: offsetTop, right: offsetLeft + width, bottom: offsetTop + height }
  }
  const placed = () => {
    const box = frame.getBoundingClientRect()
    const style = getComputedStyle(frame)
    const across = frame.offsetWidth > 0 ? box.width / frame.offsetWidth : 1
    const down = frame.offsetHeight > 0 ? box.height / frame.offsetHeight : 1
    return {
      x: box.left + across * (frame.clientLeft + parseFloat(style.paddingLeft) + point.x),
      y: box.top + down * (frame.clientTop + parseFloat(style.paddingTop) + point.y),
    }
  }
  // A point on the view's last pixel is no point a hit test reaches, so a point needs a pixel of room on every side.
  const inView = ({ x, y }) => {
    const shown = view()
    return x >= shown.left + 1 && x <= shown.right - 1 && y >= shown.top + 1 && y <= shown.bottom - 1
  }
  const boxAfterFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(frame.getBoundingClientRect())))
  if (!inView(placed())) {
    frame.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
    const at = placed()
    const shown = view()
    if (!inView(at)) scrollBy({ left: at.x - (shown.left + shown.right) / 2, top: at.y - (shown.top + shown.bottom) / 2, behavior: 'instant' })
  }
  const before = await boxAfterFrame()
  const after = await boxAfterFrame()
  if (!frame.isConnected) return { status: 'blocked', check: 'attached', detail: null }
  if (before.x !== after.x || before.y !== after.y || before.width !== after.width || before.height !== after.height) return { status: 'blocked', check: 'stable', detail: null }
  const at = placed()
  if (!inView(at)) return { status: 'blocked', check: 'in-view', detail: null }
  const hit = elementAt(at.x, at.y)
  if (hit !== frame) return { status: 'blocked', check: 'hit-target', detail: hit === null ? null : describe(hit) }
  const token = action === null ? null : arm(frame, action, at, null).token
  return { status: 'placed', point: at, scale: visualViewport.scale, token }
}`
