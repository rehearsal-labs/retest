import type { BidiClient } from './bidi-client.ts'
import type { Deadline } from '../../protocol/deadline.ts'
import type { StoredCookie, StoredOrigin, StorageState } from '../../protocol/storage-state.ts'
import { s } from '../../protocol/schema.ts'
import { BrowserError } from '../browser-error.ts'
import { readStorageFunction, writeStorageFunction } from '../page-scripts.ts'
import { webOrigin } from '../storage-state.ts'
import { readBidi } from './bidi-client.ts'
import { callInSandbox } from './sandbox.ts'
import { inWindowOrder } from './window-order.ts'

/** A cookie as `storage.getCookies` reports it, with only the fields saved state reads. */
export type FirefoxCookie = {
  name: string
  value: { type: string; value: string }
  domain: string
  path: string
  expiry?: number
  httpOnly: boolean
  secure: boolean
  sameSite?: string
}

const cookiesSchema = s.object({
  cookies: s.array(
    s.object({
      name: s.string(),
      value: s.object({ type: s.string(), value: s.string() }),
      domain: s.string(),
      path: s.string(),
      expiry: s.optional(s.number()),
      httpOnly: s.boolean(),
      secure: s.boolean(),
      sameSite: s.optional(s.string()),
    }),
  ),
})
const itemsSchema = s.array(s.object({ name: s.string(), value: s.string() }))
const readSchema = s.nullable(s.object({ origin: s.string(), items: itemsSchema }))
const contextSchema = s.object({ context: s.string() })
const interceptSchema = s.object({ intercept: s.string() })
const pausedSchema = s.object({
  isBlocked: s.boolean(),
  navigation: s.nullable(s.string()),
  context: s.nullable(s.string()),
  request: s.object({ request: s.string() }),
})

const sameSites: Readonly<Record<string, 'Strict' | 'Lax' | 'None'>> = { strict: 'Strict', lax: 'Lax', none: 'None' }

/** The partition of one user context, which `storage` commands take to read or write that context's cookies alone. */
function partitionOf(userContext: string): { type: 'storageKey'; userContext: string } {
  return { type: 'storageKey', userContext }
}

/**
 * Reads every cookie of a user context, `HttpOnly` ones included. A value that is not a string, which BiDi sends as
 * base64 bytes, is refused rather than saved as something else.
 */
export async function readFirefoxCookies(client: BidiClient, userContext: string, deadline: Deadline): Promise<StoredCookie[]> {
  const params = { partition: partitionOf(userContext) }
  const { cookies } = await client.request('storage.getCookies', params, cookiesSchema, { timeoutMs: deadline.commandTimeoutMs, signal: deadline.signal })
  return cookies.map(storedFirefoxCookie)
}

/**
 * Keeps what saved state records of a cookie Firefox reported: a session cookie has no expiry, which saved state
 * writes as -1, and the same-site rule takes Chrome's spelling.
 *
 * @example storedFirefoxCookie({ name: 'session', value: { type: 'string', value: 'k3' }, domain: 'app.test', path: '/', httpOnly: true, secure: true, sameSite: 'lax' })
 */
export function storedFirefoxCookie(cookie: FirefoxCookie): StoredCookie {
  if (cookie.value.type !== 'string') throw new BrowserError({ class: 'unsupported', message: `Firefox reported the cookie ${JSON.stringify(cookie.name)} as bytes, and saved state keeps text only.` })
  const { name, domain, path, httpOnly, secure } = cookie
  const kept = { name, value: cookie.value.value, domain, path, expires: cookie.expiry ?? -1, httpOnly, secure }
  const sameSite = cookie.sameSite === undefined ? undefined : sameSites[cookie.sameSite]
  return sameSite === undefined ? kept : { ...kept, sameSite }
}

/**
 * The cookie `storage.setCookie` takes for a saved one. A domain written with a leading dot is a domain cookie, and one
 * without is host-only, as Firefox reports them and as Chrome writes them.
 *
 * @example firefoxCookieParam({ name: 'session', value: 'k3', domain: 'app.test', path: '/', expires: -1, httpOnly: true, secure: true })
 */
export function firefoxCookieParam(cookie: StoredCookie): Record<string, unknown> {
  const { name, value, domain, path, expires, httpOnly, secure, sameSite } = cookie
  return {
    name,
    value: { type: 'string', value },
    domain,
    path,
    httpOnly,
    secure,
    ...(expires === -1 ? {} : { expiry: Math.floor(expires) }),
    ...(sameSite === undefined ? {} : { sameSite: sameSite.toLowerCase() }),
  }
}

/**
 * Restores saved state in a user context before any page of it opens: its cookies, then each origin's `localStorage`,
 * written from an empty document Retest serves for that origin, so the site's own scripts find it when they first run
 * and no request reaches the site. Resolves with the origins whose storage it wrote.
 */
export async function restoreFirefoxState(client: BidiClient, userContext: string, state: StorageState, deadline: Deadline): Promise<string[]> {
  const options = () => ({ timeoutMs: deadline.commandTimeoutMs, signal: deadline.signal })
  for (const cookie of state.cookies) {
    await client.request('storage.setCookie', { cookie: firefoxCookieParam(cookie), partition: partitionOf(userContext) }, s.object({}), options())
  }
  const items = new Map<string, StoredOrigin['localStorage']>()
  for (const { origin, localStorage } of state.origins) if (localStorage.length > 0) items.set(webOrigin(origin), localStorage)
  const origins = [...items.keys()]
  await inFirefoxOriginDocuments(client, userContext, origins, async (context, origin) => {
    const written = await callInSandbox(client, context, writeStorageFunction, [items.get(origin) ?? []], s.string(), deadline)
    if (written !== origin) throw new BrowserError({ class: 'setup_failed', message: `Retest opened ${written} to restore the storage of ${origin}.` })
  }, deadline)
  return origins
}

/**
 * Reads the `localStorage` of origins no page of the context shows now, from empty documents Retest serves for them.
 * Origins whose storage is empty are left out.
 */
export async function readFirefoxOriginStorage(client: BidiClient, userContext: string, origins: readonly string[], deadline: Deadline): Promise<StoredOrigin[]> {
  const read = await inFirefoxOriginDocuments(client, userContext, origins, (context) => callInSandbox(client, context, readStorageFunction, [], readSchema, deadline), deadline)
  return read.flatMap((origin) => (origin !== null && origin.items.length > 0 ? [{ origin: origin.origin, localStorage: origin.items }] : []))
}

/**
 * Opens each origin in a background tab of the user context, with an empty document Retest serves itself through a
 * BiDi network intercept, and runs `work` with that tab. No request reaches the site and none of its code runs: the
 * tab's document requests are answered by Retest and every other request is refused. Closes the tab afterwards.
 */
export async function inFirefoxOriginDocuments<T>(
  client: BidiClient,
  userContext: string,
  origins: readonly string[],
  work: (context: string, origin: string) => Promise<T>,
  deadline: Deadline,
): Promise<T[]> {
  if (origins.length === 0) return []
  const options = () => ({ timeoutMs: deadline.commandTimeoutMs, signal: deadline.signal })
  // Firefox's own words, which name no page content, are kept, so a failure here says what Firefox found.
  const { context } = await inWindowOrder(client, deadline, () => client.request('browsingContext.create', { type: 'tab', userContext, background: true }, contextSchema, { ...options(), keepErrorMessage: true }))
  const stop = client.on('network.beforeRequestSent', (params) => answerPaused(client, context, params, deadline))
  let intercept: string | undefined
  try {
    await client.request('session.subscribe', { events: ['network.beforeRequestSent'], contexts: [context] }, s.object({}), options())
    intercept = (await client.request('network.addIntercept', { phases: ['beforeRequestSent'], contexts: [context] }, interceptSchema, options())).intercept
    const results: T[] = []
    for (const origin of origins) {
      await client.request('browsingContext.navigate', { context, url: new URL('/', origin).href, wait: 'complete' }, s.object({ navigation: s.nullable(s.string()), url: s.string() }), options())
      results.push(await work(context, origin))
    }
    return results
  } finally {
    stop()
    if (intercept !== undefined) await client.send('network.removeIntercept', { intercept }, options()).catch(() => undefined)
    await client.send('session.unsubscribe', { events: ['network.beforeRequestSent'], contexts: [context] }, options()).catch(() => undefined)
    await inWindowOrder(client, deadline, () => client.send('browsingContext.close', { context }, options())).catch(() => {
      // Removing the user context closes the tab with it, and the error that matters is the work's own.
    })
  }
}

// Answers the tab's navigation with an empty page and refuses anything else, such as a favicon.
function answerPaused(client: BidiClient, context: string, params: unknown, deadline: Deadline): void {
  let paused
  try {
    paused = readBidi(pausedSchema, params, 'network.beforeRequestSent')
  } catch {
    return
  }
  if (paused.context !== context || !paused.isBlocked) return
  const request = paused.request.request
  const answer = paused.navigation === null
    ? client.send('network.failRequest', { request }, { timeoutMs: deadline.commandTimeoutMs, signal: deadline.signal })
    : client.send('network.provideResponse', {
        request,
        statusCode: 200,
        reasonPhrase: 'OK',
        headers: [{ name: 'content-type', value: { type: 'string', value: 'text/html; charset=utf-8' } }],
        body: { type: 'string', value: '<!doctype html>' },
      }, { timeoutMs: deadline.commandTimeoutMs, signal: deadline.signal })
  answer.catch(() => {
    // A request left unanswered fails the navigation waiting on it, which reports the problem.
  })
}
