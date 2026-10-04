/** The header each fixture client sends to say which it is. Every write to the API must carry a known name. */
export const CLIENT_HEADER = 'x-task-client'

/** The clients the fixture knows. A request naming any other, or none, is logged as `unknown`. */
export type KnownClient = 'web' | 'ios' | 'macos' | 'electron' | 'test'

/** Which client a logged request came from. Only these names are ever written, never the header as sent. */
export type ClientName = KnownClient | 'unknown'

/** Every known client, in the order the README lists them. */
export const KNOWN_CLIENTS: readonly KnownClient[] = ['web', 'ios', 'macos', 'electron', 'test']

const knownClients: ReadonlySet<string> = new Set<string>(KNOWN_CLIENTS)

/**
 * The client a request names in its `x-task-client` header, read against the known list.
 *
 * @example clientOf('ios') // 'ios'
 * @example clientOf('Bearer abc') // 'unknown'
 */
export function clientOf(header: string | string[] | undefined): ClientName {
  return typeof header === 'string' && isKnownClient(header) ? header : 'unknown'
}

/** Whether a text is one of the known clients. */
export function isKnownClient(text: string): text is KnownClient {
  return knownClients.has(text)
}

/** Whether a text is a client name the logs may hold: a known client, or `unknown`. */
export function isClientName(text: string): text is ClientName {
  return text === 'unknown' || isKnownClient(text)
}
