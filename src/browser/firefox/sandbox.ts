import type { BidiClient } from './bidi-client.ts'
import type { Deadline } from '../../protocol/deadline.ts'
import type { Schema } from '../../protocol/schema.ts'
import { parse, s } from '../../protocol/schema.ts'
import { BrowserError } from '../browser-error.ts'

/** The sandbox Retest's page functions run in, in every document: Firefox gives each name a realm of its own. */
export const sandboxName = 'retest'

/**
 * Firefox's sandbox has no Navigation API in the release Retest drives, and the shared input guard listens for the
 * `navigate` event through it. Where the API is missing, the guard gets an object that never fires, so it cannot hold
 * back a navigation the page starts during a fill; the Firefox page reads navigations from Firefox's own events
 * instead, and the guard of the document that arrives still stops any typing meant for the one it replaced. Where the
 * API exists, the guard uses it.
 */
export const navigationShim: string = "if (typeof navigation === 'undefined') globalThis.navigation = { addEventListener() {} };"

/**
 * The events the shared input guard listens for on the window from the start of every document: each kind of input it
 * guards (`guardHelpers` in `page-scripts.ts`) apart from the wheel, which it hears only while a scroll is armed, and
 * the input and change events it reads a select's choice from.
 */
export const relayedEvents: readonly string[] = [
  'pointerdown',
  'mousedown',
  'pointerup',
  'mouseup',
  'click',
  'touchstart',
  'touchend',
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

/** The typing events the relays stop in a document whose guard is not yet installed: every key and text input event. */
export const unguardedTyping: readonly string[] = ['keydown', 'keypress', 'beforeinput', 'input', 'keyup']

/**
 * Relays Retest's preload script adds to the window in its sandbox, before any script of the page runs: one capturing
 * listener for each event the guard hears, which passes the event to the listeners the guard adds later by a call, in
 * the order they were added, until one of them stops it. So the guard hears every event before any listener the page
 * adds, as Chromium's guard does from its own script on every new document.
 *
 * The guard's own listeners are not added by the preload script. On Firefox 133, when the guard's listeners are
 * functions a preload script made, key events they hear sometimes reach no listener added after them and type nothing:
 * about one fill in five, in probes of forty fills over raw BiDi. With relays made by the preload script and the guard's
 * functions by a call, none of 180 fills in three such probes lost a key.
 *
 * So the guard arrives in a new document a moment after it starts, by a call Retest makes once it hears the document
 * commit. Until then the relays stop every typing event the browser delivers, as the guard stops typing no action armed:
 * input reaching a document before its guard is meant for the document it replaced, and a secret on its way is never
 * typed into a document Retest has not guarded. Every action installs the guard in its document before its own input.
 *
 * Firefox 133 sometimes runs the preload script twice in one document, each time in a sandbox of its own under the same
 * name, and sends every later call to only one of them: the first document a new window opens did so in every probe of
 * four windows. The other sandbox's relays never get a guard, and if they stopped unguarded typing they would stop every
 * key after the guard had already counted it as reached, so the page heard nothing and Retest reported the text typed.
 * So the sandbox that calls reach claims the document (`retestClaim`, run by every call `wrapped` makes) with an event
 * of a type only Retest knows, `claimType`, which the script is given; a relay whose own sandbox has not been claimed
 * hears it and stops stopping typing, leaving that to the guard of the sandbox Retest speaks to. Every action reaches
 * its sandbox by a call before its input goes, so no relay of another sandbox stands between that guard and the page.
 *
 * A sandbox can outlive its document: the same probes saw a window's second document run the script again in a sandbox
 * of its first. So the relays are added once in each document a sandbox runs in, and a guard or claim left from the
 * document before goes with that document.
 *
 * `claimType` must be in scope where the script runs.
 */
export const relayScript: string = `(() => {
  if (globalThis.retestRelays !== undefined && globalThis.retestRelaysDocument === globalThis.document) return;
  if (globalThis.retestRelays !== undefined) {
    for (const name of ['retestGuard', 'retestClaimed', 'retestUnclaimed', 'retestUnguardedStray']) delete globalThis[name];
  }
  globalThis.retestRelaysDocument = globalThis.document;
  const relays = new Map();
  const typing = new Set(${JSON.stringify(unguardedTyping)});
  window.addEventListener(claimType, () => {
    if (globalThis.retestClaimed !== true) globalThis.retestUnclaimed = true;
  });
  // Told on every call, since a sandbox may outlive its document and another sandbox may start in the next one.
  globalThis.retestClaim = () => {
    globalThis.retestClaimed = true;
    window.dispatchEvent(new Event(claimType));
  };
  for (const type of ${JSON.stringify(relayedEvents)}) {
    const listeners = new Set();
    relays.set(type, listeners);
    window.addEventListener(type, (event) => {
      if (globalThis.retestGuard === undefined && globalThis.retestUnclaimed !== true && event.isTrusted && typing.has(type) && (event instanceof KeyboardEvent || event instanceof InputEvent)) {
        globalThis.retestUnguardedStray ??= { event: event.type, by: 'the page', origin: location.origin };
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      let stopped = false;
      event.stopImmediatePropagation = () => {
        stopped = true;
        Event.prototype.stopImmediatePropagation.call(event);
      };
      try {
        for (const listener of [...listeners]) {
          listener(event);
          if (stopped) break;
        }
      } finally {
        delete event.stopImmediatePropagation;
      }
    }, { capture: true, passive: false });
  }
  globalThis.retestRelays = relays;
})();`

// The window a page function sees in Retest's sandbox: a capturing listener for an event the document's relays carry
// joins those relays, and any other goes to the window itself. Removing one takes it from both, wherever it was added.
const relayedWindow = `const window = (() => {
  const actual = globalThis.window;
  const relayed = (type, options) => (options === true || options?.capture === true ? globalThis.retestRelays?.get(type) : undefined);
  return {
    addEventListener(type, listener, options) {
      const relay = relayed(type, options);
      if (relay === undefined) actual.addEventListener(type, listener, options);
      else relay.add(listener);
    },
    removeEventListener(type, listener, options) {
      relayed(type, options)?.delete(listener);
      actual.removeEventListener(type, listener, options);
    },
  };
})();`

const callSchema = s.object({
  type: s.enum(['success', 'exception']),
  result: s.optional(s.object({ type: s.string(), value: s.optional(s.string()) })),
  exceptionDetails: s.optional(s.object({ text: s.string() })),
})

/**
 * A page function wrapped so its arguments arrive as one JSON plan, each entry a JSON value or the index of an
 * element reference that follows the plan, and its answer leaves the page as JSON. Values then cross as JSON both
 * ways, whatever BiDi's own value serialization makes of them. The `window` it sees adds a capturing listener for an
 * event the document's relays carry to those relays (`relayScript`), so the guard it installs hears events first.
 *
 * A call may also carry its id and a channel, `started`, which it tells its id through once the function has run up to
 * the promise it answers with: Firefox runs the commands it is sent in no fixed order, so the bridge can know a call
 * waits in the page before it sends the input that call is to hear of.
 *
 * @example wrapped('function readPage(queries) { … }')
 */
export function wrapped(functionDeclaration: string): string {
  return `async function retestCall(plan, id, started, ...references) {
  ${navigationShim}
  ${relayedWindow}
  globalThis.retestClaim?.()
  const call = (${functionDeclaration})
  const values = JSON.parse(plan).map((entry) => ('e' in entry ? references[entry.e] : entry.v))
  const pending = call(...values)
  if (globalThis.retestGuard !== undefined && globalThis.retestUnguardedStray !== undefined) globalThis.retestGuard.stray ??= globalThis.retestUnguardedStray
  if (typeof started === 'function') started(id)
  const value = await pending
  return value === undefined ? '{}' : JSON.stringify({ v: value })
}`
}

/**
 * Runs a page function in Retest's sandbox of a browsing context's current document, with JSON `values`, and
 * validates its answer. A function that throws fails as Retest's page script failing; it never runs page code.
 *
 * @example const origin = await callInSandbox(client, context, writeStorageFunction, [items], s.string(), deadline)
 */
export async function callInSandbox<T>(client: BidiClient, context: string, functionDeclaration: string, values: readonly unknown[], schema: Schema<T>, deadline: Deadline): Promise<T> {
  const params = {
    functionDeclaration: wrapped(functionDeclaration),
    arguments: [{ type: 'string', value: JSON.stringify(values.map((value) => ({ v: value }))) }],
    target: { context, sandbox: sandboxName },
    awaitPromise: true,
    resultOwnership: 'none',
  }
  const answer = await client.request('script.callFunction', params, callSchema, { timeoutMs: deadline.commandTimeoutMs, signal: deadline.signal })
  if (answer.type === 'exception') throw new BrowserError({ class: 'setup_failed', message: `Retest's page script failed: ${answer.exceptionDetails?.text ?? 'it threw'}` })
  const text = answer.result?.value
  const decoded: unknown = text === undefined ? undefined : JSON.parse(text)
  const value: unknown = typeof decoded === 'object' && decoded !== null && 'v' in decoded ? decoded.v : undefined
  const parsed = parse(schema, value)
  if (!parsed.ok) throw new BrowserError({ class: 'setup_failed', message: "Retest's page script answered in a form it cannot read." })
  return parsed.value
}
