import type { Deadline } from '../../protocol/deadline.ts'
import type { StoredCookie, StoredOrigin } from '../../protocol/storage-state.ts'
import type { IsolatedWorld } from '../isolated-world.ts'
import type { WebKitConnection } from './connection.ts'
import { s } from '../../protocol/schema.ts'
import { BrowserError } from '../browser-error.ts'
import { readProtocol } from '../cdp-results.ts'
import { writeStorageFunction } from '../page-scripts.ts'
import { readLocalStorage, storedCookie, webOrigin } from '../storage-state.ts'

/** A page Retest opens in a context for its own use: one that serves an empty document for every address it opens. */
export type SidePage = {
  /** Opens `url` and waits for its empty document; fails when it could not. */
  open(url: string, deadline: Deadline): Promise<void>
  readonly world: IsolatedWorld
  close(timeoutMs: number): Promise<void>
}

const cookieSchema = s.object({
  name: s.string(),
  value: s.string(),
  domain: s.string(),
  path: s.string(),
  expires: s.number(),
  httpOnly: s.boolean(),
  secure: s.boolean(),
  session: s.boolean(),
  sameSite: s.optional(s.string()),
  partitionKey: s.optional(s.string()),
})
const cookiesSchema = s.object({ cookies: s.array(cookieSchema) })

/** A cookie as `Playwright.getAllCookies` reports it, with only the fields saved state reads. */
export type WebKitCookie = { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; session: boolean; sameSite?: string; partitionKey?: string }

/**
 * A WebKit cookie as saved state keeps it: a session cookie expires at -1, and any other in seconds since the epoch,
 * which WebKit reports in milliseconds.
 *
 * @example cookieFromWebKit({ name: 'id', value: 'k3', domain: 'app.test', path: '/', expires: 1791150000000, httpOnly: true, secure: false, session: false, sameSite: 'Lax' }).expires // 1791150000
 */
export function cookieFromWebKit(cookie: WebKitCookie): StoredCookie {
  const { name, value, domain, path, httpOnly, secure } = cookie
  return storedCookie({ name, value, domain, path, httpOnly, secure, expires: cookie.session ? -1 : cookie.expires / 1000, ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }) })
}

/**
 * A saved cookie as `Playwright.setCookies` takes it. WebKit takes the domain as saved state has it, a host-only one
 * without a leading dot, and its expiry in milliseconds since the epoch.
 *
 * @example cookieForWebKit({ name: 'id', value: 'k3', domain: 'app.test', path: '/', expires: -1, httpOnly: true, secure: false })
 */
export function cookieForWebKit(cookie: StoredCookie): Record<string, unknown> {
  const { name, value, domain, path, httpOnly, secure, expires, sameSite } = cookie
  const session = expires === -1
  return { name, value, domain, path, httpOnly, secure, session, ...(session ? {} : { expires: expires * 1000 }), ...(sameSite === undefined ? {} : { sameSite }) }
}

/**
 * Reads every cookie of a browser context. A partitioned cookie is left out, as Chromium's reading leaves it out:
 * saved state cannot say which site it belongs to.
 */
export async function readContextCookies(connection: WebKitConnection, browserContextId: string, deadline: Deadline): Promise<StoredCookie[]> {
  const answer = await connection.send('Playwright.getAllCookies', { browserContextId }, { timeoutMs: deadline.commandTimeoutMs })
  const { cookies } = readProtocol(cookiesSchema, answer, { method: 'Playwright.getAllCookies' })
  return cookies.flatMap((cookie) => (cookie.partitionKey === undefined || cookie.partitionKey === '' ? [cookieFromWebKit(cookie)] : []))
}

/** Sets saved cookies in a browser context before any page of it opens. */
export async function restoreCookies(connection: WebKitConnection, browserContextId: string, cookies: readonly StoredCookie[], deadline: Deadline): Promise<void> {
  if (cookies.length === 0) return
  await connection.send('Playwright.setCookies', { browserContextId, cookies: cookies.map(cookieForWebKit) }, { timeoutMs: deadline.commandTimeoutMs })
}

/**
 * Runs `work` in an empty document of each origin, in a page Retest opens in the context for that alone and closes
 * afterwards. Every request the page makes is answered by Retest, so no request reaches the site and none of its code
 * runs.
 */
export async function inOriginDocuments<T>(openSidePage: (deadline: Deadline) => Promise<SidePage>, origins: readonly string[], work: (world: IsolatedWorld, origin: string) => Promise<T>, deadline: Deadline): Promise<T[]> {
  if (origins.length === 0) return []
  const page = await openSidePage(deadline)
  try {
    const results: T[] = []
    for (const origin of origins) {
      await page.open(new URL('/', origin).href, deadline)
      results.push(await work(page.world, origin))
    }
    return results
  } finally {
    await page.close(deadline.commandTimeoutMs).catch(() => {
      // The context's end closes the page with it, and the error that matters is the work's own.
    })
  }
}

/** Reads the `localStorage` of origins no page of the context shows now. Origins whose storage is empty are left out. */
export async function readOtherOrigins(openSidePage: (deadline: Deadline) => Promise<SidePage>, origins: readonly string[], deadline: Deadline): Promise<StoredOrigin[]> {
  const read = await inOriginDocuments(openSidePage, origins, (world) => readLocalStorage(world, deadline), deadline)
  return read.flatMap((origin) => (origin !== null && origin.localStorage.length > 0 ? [origin] : []))
}

/**
 * Writes each saved origin's `localStorage` from an empty document of that origin, so the site's own scripts find it
 * when they first run. Resolves with the origins it wrote.
 */
export async function restoreOrigins(openSidePage: (deadline: Deadline) => Promise<SidePage>, origins: readonly StoredOrigin[], deadline: Deadline): Promise<string[]> {
  const items = new Map<string, StoredOrigin['localStorage']>()
  for (const { origin, localStorage } of origins) if (localStorage.length > 0) items.set(webOrigin(origin), localStorage)
  const named = [...items.keys()]
  await inOriginDocuments(openSidePage, named, async (world, origin) => {
    const written = await world.call(writeStorageFunction, [items.get(origin) ?? []], s.string(), deadline)
    if (written !== origin) throw new BrowserError({ class: 'setup_failed', message: `Retest opened ${written} to restore the storage of ${origin}.` })
  }, deadline)
  return named
}
