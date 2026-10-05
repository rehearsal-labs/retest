import { guardScript } from '../page-scripts.ts'

// Retest's input guard must hear every input event before any listener of the page, which in Chromium it does from
// Retest's own isolated world, installed in each document before the page's scripts run. WebKit's protocol runs a
// script that early only in the page's main world (`Page.setBootstrapScript`), and Retest's user world exists only
// once the driver hears of it, after the page's first scripts. So the work is split. A small relay runs first in the
// main world: it captures the DOM functions it uses before the page can replace them, puts the first listener of the
// window's capture phase on every event the guard watches, and hands each trusted event, synchronously, to the user
// world as a private event on the same target, named by a secret only the driver knows. In the user world the shared
// guard from `page-scripts.ts` decides, unchanged: the relay there passes it a stand-in for the event with the real
// event's type, target and kind, and when the guard stops it, the main-world relay stops the real event before any
// listener of the page hears it. A document Retest has not yet reached has no user-world guard; there the relay stops
// trusted typing as the guard would stop stray typing, and hands what it stopped to the guard once it arrives.
// Nothing of either relay is reachable by the page: its listeners hold the functions they captured, and the secret
// appears in no global and no DOM node.

/** Every event the shared guard listens for on the window, the select watch's input and change included. */
export const relayedEvents: readonly string[] = [
  'pointerdown',
  'touchstart',
  'mousedown',
  'pointerup',
  'touchend',
  'mouseup',
  'click',
  'keydown',
  'keypress',
  'beforeinput',
  'input',
  'keyup',
  'pointerover',
  'pointermove',
  'mouseover',
  'mousemove',
  'change',
]

/** Events the guard listens for only while an action that needs them is armed: the wheel, which is not passive. */
export const relayedWhileArmed: readonly string[] = ['wheel']

/** The events typing sends, which a document with no guard yet stops, as the guard stops stray typing. */
const typingEvents: readonly string[] = ['keydown', 'beforeinput', 'input', 'keyup']

/**
 * The main-world relay, which `Page.setBootstrapScript` runs at the start of every document before the page's own
 * scripts. It also tells the driver when the document changes, through `retestChanged`, the binding the driver added
 * to the main world, which it takes off the window before the page can see it. The binding carries no page content.
 *
 * @example await send('Page.setBootstrapScript', { source: bootstrapScript('retest-4e1c') })
 */
export function bootstrapScript(secret: string): string {
  return `(() => {
  const secret = ${JSON.stringify(secret)}
  const tell = globalThis.retestChanged
  try { delete globalThis.retestChanged } catch {}
  const add = EventTarget.prototype.addEventListener
  const remove = EventTarget.prototype.removeEventListener
  const dispatch = EventTarget.prototype.dispatchEvent
  const prevent = Event.prototype.preventDefault
  const stopNow = Event.prototype.stopImmediatePropagation
  const typeOf = Object.getOwnPropertyDescriptor(Event.prototype, 'type').get
  const targetOf = Object.getOwnPropertyDescriptor(Event.prototype, 'target').get
  const getAttribute = Element.prototype.getAttribute
  const localNameOf = Object.getOwnPropertyDescriptor(Element.prototype, 'localName').get
  const Custom = CustomEvent
  const Keyboard = KeyboardEvent
  const Input = InputEvent
  const ElementClass = Element
  const Observer = MutationObserver
  const observe = Observer.prototype.observe
  const serialize = JSON.stringify
  const typing = ${JSON.stringify(typingEvents)}
  let relayed = false
  let stray = null
  const describe = (element) => {
    let text = '<' + localNameOf.call(element)
    for (const name of ['id', 'class', 'data-testid']) {
      const value = getAttribute.call(element, name)
      if (value !== null) text += ' ' + name + '="' + value + '"'
    }
    return text + '>'
  }
  const kindOf = (event) => (event instanceof Keyboard ? 'keyboard' : event instanceof Input ? 'input' : 'other')
  const relay = (event) => {
    if (!event.isTrusted) return
    const type = typeOf.call(event)
    const target = targetOf.call(event)
    const kind = kindOf(event)
    if (!relayed) {
      if (!typing.includes(type) || kind === 'other') return
      prevent.call(event)
      stopNow.call(event)
      stray ??= { event: type, by: target instanceof ElementClass ? describe(target) : 'the page', origin: location.origin }
      return
    }
    const passed = dispatch.call(target ?? window, new Custom(secret + '-' + type, { cancelable: true, bubbles: false, detail: kind }))
    if (!passed) {
      prevent.call(event)
      stopNow.call(event)
    }
  }
  const options = { capture: true, passive: false }
  for (const type of ${JSON.stringify(relayedEvents)}) add.call(window, type, relay, options)
  add.call(window, secret + '-listen', (event) => add.call(window, String(event.detail), relay, options), { capture: true })
  add.call(window, secret + '-unlisten', (event) => remove.call(window, String(event.detail), relay, options), { capture: true })
  add.call(window, secret + '-hello', (event) => {
    relayed = true
    prevent.call(event)
    if (stray !== null) dispatch.call(window, new Custom(secret + '-stray', { detail: serialize(stray) }))
  }, { capture: true })
  if (typeof tell === 'function') observe.call(new Observer(() => tell('')), document, { subtree: true, childList: true, attributes: true, characterData: true })
})()`
}

/**
 * The user-world relay, then the shared guard, which the driver evaluates in Retest's user world of a document before
 * any other call reaches it. The relay takes the listeners the guard puts on the window for the events the main world
 * hands over, and calls them, in the order the guard added them, with a stand-in for each event. It answers whether
 * the main-world relay is in this document: where it is not, as in a document that was open before the driver set it
 * up, the guard listens to the window itself, after any listener the page added first.
 *
 * @example await send('Runtime.evaluate', { expression: guardInstallScript('retest-4e1c'), contextId, returnByValue: true })
 */
export function guardInstallScript(secret: string): string {
  return `(() => {
  if (globalThis.retestRelay === undefined) {
    const secret = ${JSON.stringify(secret)}
    const realAdd = EventTarget.prototype.addEventListener
    const realRemove = EventTarget.prototype.removeEventListener
    const relayed = new Set(${JSON.stringify([...relayedEvents, ...relayedWhileArmed])})
    const whileArmed = new Set(${JSON.stringify(relayedWhileArmed)})
    const listeners = new Map()
    const relay = { present: false, stray: null }
    const tellMain = (type, detail) => window.dispatchEvent(new CustomEvent(secret + '-' + type, { detail }))
    Object.defineProperty(window, 'addEventListener', {
      configurable: true,
      writable: true,
      value: function (type, listener, options) {
        if (this !== window || !relay.present || !relayed.has(type)) return realAdd.call(this, type, listener, options)
        const list = listeners.get(type) ?? []
        if (!list.includes(listener)) list.push(listener)
        listeners.set(type, list)
        if (whileArmed.has(type) && list.length === 1) tellMain('listen', type)
      },
    })
    Object.defineProperty(window, 'removeEventListener', {
      configurable: true,
      writable: true,
      value: function (type, listener, options) {
        if (this !== window || !relay.present || !relayed.has(type)) return realRemove.call(this, type, listener, options)
        const list = (listeners.get(type) ?? []).filter((each) => each !== listener)
        listeners.set(type, list)
        if (whileArmed.has(type) && list.length === 0) tellMain('unlisten', type)
      },
    })
    for (const type of relayed) {
      realAdd.call(window, secret + '-' + type, (forwarded) => {
        forwarded.stopImmediatePropagation()
        const list = listeners.get(type) ?? []
        if (list.length === 0) return
        const prototype = forwarded.detail === 'keyboard' ? KeyboardEvent.prototype : forwarded.detail === 'input' ? InputEvent.prototype : Event.prototype
        let stopped = false
        const halt = () => { stopped = true }
        const event = Object.create(prototype, {
          type: { value: type },
          isTrusted: { value: true },
          target: { value: forwarded.target },
          preventDefault: { value: halt },
          stopPropagation: { value: halt },
          stopImmediatePropagation: { value: halt },
        })
        for (const listener of [...list]) {
          listener.call(window, event)
          if (stopped) break
        }
        if (stopped) forwarded.preventDefault()
      }, { capture: true })
    }
    realAdd.call(window, secret + '-stray', (event) => { relay.stray = JSON.parse(String(event.detail)) }, { capture: true })
    const hello = new CustomEvent(secret + '-hello', { cancelable: true })
    relay.present = !window.dispatchEvent(hello)
    globalThis.retestRelay = relay
  }
  ${guardScript}
  const guard = globalThis.retestGuard
  if (guard !== undefined && guard.stray === null && globalThis.retestRelay.stray !== null) guard.stray = globalThis.retestRelay.stray
  return globalThis.retestRelay.present
})()`
}
