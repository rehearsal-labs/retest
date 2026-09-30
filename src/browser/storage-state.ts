import type { IsolatedWorld } from './isolated-world.ts'
import type { ContextHandle } from './origin-document.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { StoredCookie, StoredOrigin, StorageState } from '../protocol/storage-state.ts'
import { s } from '../protocol/schema.ts'
import { readOrigin } from '../protocol/url.ts'
import { BrowserError } from './browser-error.ts'
import { request, sendOptions, type CdpSender } from './cdp-results.ts'
import { inOriginDocuments } from './origin-document.ts'
import { readStorageFunction, writeStorageFunction } from './page-scripts.ts'

/** A cookie as `Storage.getCookies` reports it, with only the fields saved state reads. */
export type BrowserCookie = Omit<StoredCookie, 'sameSite'> & { sameSite?: string; partitionKey?: object }

/** A cookie as `Storage.setCookies` takes it: a host-only cookie is set through `url`, a domain cookie through `domain`. */
export type CookieParam = Omit<StoredCookie, 'domain' | 'expires'> & ({ url: string } | { domain: string }) & { expires?: number }

const sameSites = ['Strict', 'Lax', 'None'] as const

const cookiesSchema = s.object({
  cookies: s.array(
    s.object({
      name: s.string(),
      value: s.string(),
      domain: s.string(),
      path: s.string(),
      expires: s.number(),
      httpOnly: s.boolean(),
      secure: s.boolean(),
      sameSite: s.optional(s.string()),
      partitionKey: s.optional(s.object({})),
    }),
  ),
})
const itemsSchema = s.array(s.object({ name: s.string(), value: s.string() }))
const readSchema = s.nullable(s.object({ origin: s.string(), items: itemsSchema }))

/**
 * Reads every cookie of a browser context. A partitioned cookie is left out: saved state cannot say which site
 * it belongs to, and restored without that it would be shared with every site.
 */
export async function readCookies(browser: CdpSender, browserContextId: string, deadline: Deadline): Promise<StoredCookie[]> {
  const { cookies } = await request(browser, 'Storage.getCookies', { browserContextId }, cookiesSchema, sendOptions(deadline))
  return cookies.flatMap((cookie) => (cookie.partitionKey === undefined ? [storedCookie(cookie)] : []))
}

/**
 * Keeps what saved state records of a cookie.
 *
 * @example storedCookie({ name: 'session', value: 'k3', domain: 'app.test', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' })
 */
export function storedCookie(cookie: BrowserCookie): StoredCookie {
  const { name, value, domain, path, expires, httpOnly, secure } = cookie
  const sameSite = sameSites.find((known) => known === cookie.sameSite)
  const kept = { name, value, domain, path, expires, httpOnly, secure }
  return sameSite === undefined ? kept : { ...kept, sameSite }
}

/**
 * How to set a saved cookie again. Chrome writes a host-only cookie's domain without a leading dot, and only a URL
 * sets a cookie host-only again. A session cookie gets no expiry.
 *
 * @example cookieParam({ name: 'session', value: 'k3', domain: 'app.test', path: '/', expires: -1, httpOnly: true, secure: true })
 */
export function cookieParam(cookie: StoredCookie): CookieParam {
  const { domain, expires, ...rest } = cookie
  const where = domain.startsWith('.') ? { domain } : { url: `${cookie.secure ? 'https' : 'http'}://${domain}${cookie.path}` }
  return { ...rest, ...where, ...(expires === -1 ? {} : { expires }) }
}

/** Reads the `localStorage` of the document in `world`, and the origin it belongs to, or null when it may use none. */
export async function readLocalStorage(world: IsolatedWorld, deadline: Deadline): Promise<StoredOrigin | null> {
  const read = await world.call(readStorageFunction, [], readSchema, deadline)
  return read === null ? null : { origin: read.origin, localStorage: read.items }
}

/**
 * Reads the `localStorage` of origins no page of the context shows now, from documents Retest serves for them.
 * Origins whose storage is empty are left out.
 */
export async function readOriginStorage(context: ContextHandle, origins: readonly string[], deadline: Deadline): Promise<StoredOrigin[]> {
  const read = await inOriginDocuments(context, origins, (world) => readLocalStorage(world, deadline), deadline)
  return read.flatMap((origin) => (origin !== null && origin.localStorage.length > 0 ? [origin] : []))
}

/**
 * Restores saved state in a browser context before any page of it opens: its cookies, then each origin's
 * `localStorage`, written from a document Retest serves, so the site's own scripts find it when they first run.
 * Resolves with the origins whose storage it wrote.
 */
export async function restoreState(context: ContextHandle, state: StorageState, deadline: Deadline): Promise<string[]> {
  const items = new Map<string, StoredOrigin['localStorage']>()
  for (const { origin, localStorage } of state.origins) {
    if (localStorage.length > 0) items.set(webOrigin(origin), localStorage)
  }
  if (state.cookies.length > 0) {
    const params = { cookies: state.cookies.map(cookieParam), browserContextId: context.browserContextId }
    await request(context.connection, 'Storage.setCookies', params, s.object({}), sendOptions(deadline))
  }
  const origins = [...items.keys()]
  await inOriginDocuments(context, origins, async (world, origin) => {
    const written = await world.call(writeStorageFunction, [items.get(origin) ?? []], s.string(), deadline)
    if (written !== origin) throw new BrowserError({ class: 'setup_failed', message: `Retest opened ${written} to restore the storage of ${origin}.` })
  }, deadline)
  return origins
}

/**
 * Checks that saved state names an http or https origin, since restoring any other would write where the state
 * never came from.
 *
 * @example webOrigin('http://127.0.0.1:4173') // 'http://127.0.0.1:4173'
 */
export function webOrigin(origin: string): string {
  if (readOrigin(origin) === origin) return origin
  throw new BrowserError({ class: 'setup_failed', message: `Could not restore the saved state: ${JSON.stringify(origin)} is not an http or https origin.` })
}
