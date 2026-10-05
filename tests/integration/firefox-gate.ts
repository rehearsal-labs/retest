import { isRecord } from '../../src/browser/cdp/message.ts'

// The gate the shared suites hold input back with, on Firefox's protocol: WebDriver BiDi over a WebSocket, which
// `launchFirefox` opens through the socket a test gives it.

/** What the gate holds back: a key going down, a key coming up, or the text of a fill. */
export type FirefoxGatedInput = 'key down' | 'key up' | 'text'

/** What a test does to the input Retest sends Firefox, and hears of the documents that load. */
export type FirefoxInputGate = {
  /** A promise to hold the input back for, or undefined to let it go at once. */
  hold?: (input: FirefoxGatedInput) => Promise<void> | undefined
  /** Hears each document load Firefox tells of, by its address. */
  loaded?: (url: string) => void
}

// The key values WebDriver gives the modifiers, which a press holds around its key.
const modifierValues: ReadonlySet<string> = new Set(['', '', '', ''])
// Commands the gate sends of its own are numbered far above Retest's, and Firefox's answers to them are ones Retest's
// client was never waiting for, which it notes and drops.
const firstOwnCommand = 1_000_000_000

type KeySource = { source: Record<string, unknown>; actions: Record<string, unknown>[] }

/**
 * Opens Firefox's WebDriver BiDi socket behind `gate`. Firefox takes a press as one `input.performActions` whose key
 * goes down and up in one sequence, and a fill's text as one sequence of many keys: the gate tells them apart by how
 * many keys other than modifiers go down. A press is split at its first key up, the keys going down sent at once as a
 * command of the gate's own and the rest held under Retest's own command, so a key up can be held back as on the other
 * engines; Firefox keeps a key held down between two such commands. A fill's sequence is the text.
 *
 * @example await launchFirefox(options, timeoutMs, firefoxGate({ hold: (input) => (input === 'key up' ? new Promise(() => {}) : undefined) }))
 */
export function firefoxGate(gate: FirefoxInputGate): (url: string) => WebSocket {
  return (url) => new GatedFirefoxSocket(url, gate)
}

class GatedFirefoxSocket extends WebSocket {
  readonly #gate: FirefoxInputGate
  #nextOwn = firstOwnCommand
  // Holds keep their order: a later input waits for the one before it to go.
  #queue: Promise<void> = Promise.resolve()

  constructor(url: string, gate: FirefoxInputGate) {
    super(url)
    this.#gate = gate
    this.addEventListener('message', (event) => {
      const message = typeof event.data === 'string' ? parse(event.data) : undefined
      const params = message !== undefined && isRecord(message['params']) ? message['params'] : {}
      if (message?.['method'] === 'browsingContext.load' && typeof params['url'] === 'string') this.#gate.loaded?.(params['url'])
    })
  }

  override send(data: Parameters<WebSocket['send']>[0]): void {
    const message = typeof data === 'string' ? parse(data) : undefined
    const keys = message === undefined ? undefined : keySource(message)
    if (message === undefined || keys === undefined) {
      super.send(data)
      return
    }
    const { params, source, actions } = keys
    const presses = actions.filter((action) => action['type'] === 'keyDown' && typeof action['value'] === 'string' && !modifierValues.has(action['value'])).length
    if (presses !== 1) {
      this.#gated('text', () => super.send(data))
      return
    }
    const firstUp = actions.findIndex((action) => action['type'] === 'keyUp')
    const down = { ...message, id: this.#nextOwn, params: { ...params, actions: [{ ...source, actions: actions.slice(0, firstUp) }] } }
    const up = { ...message, params: { ...params, actions: [{ ...source, actions: actions.slice(firstUp) }] } }
    this.#nextOwn += 1
    this.#gated('key down', () => super.send(JSON.stringify(down)))
    this.#gated('key up', () => super.send(JSON.stringify(up)))
  }

  #gated(input: FirefoxGatedInput, send: () => void): void {
    this.#queue = this.#queue.then(async () => {
      const held = this.#gate.hold?.(input)
      if (held !== undefined) await held
      if (this.readyState === WebSocket.OPEN) send()
    })
  }
}

// The one key source of an `input.performActions` that sends nothing else, its actions, and the command's parameters.
function keySource(message: Record<string, unknown>): (KeySource & { params: Record<string, unknown> }) | undefined {
  if (message['method'] !== 'input.performActions' || !isRecord(message['params'])) return undefined
  const params = message['params']
  const sources = params['actions']
  if (!Array.isArray(sources) || sources.length !== 1) return undefined
  const [source]: unknown[] = sources
  if (!isRecord(source) || source['type'] !== 'key' || !Array.isArray(source['actions'])) return undefined
  const actions = source['actions'].filter((action: unknown): action is Record<string, unknown> => isRecord(action))
  if (actions.length !== source['actions'].length || !actions.some((action) => action['type'] === 'keyUp')) return undefined
  return { params, source, actions }
}

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}
