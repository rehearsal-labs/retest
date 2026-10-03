import type { Route } from './route.ts'
import { escapeHtml, htmlPage } from './html.ts'
import { HTML_TYPE, JSON_TYPE, queryOf, respondWith } from './route.ts'

/** How long a hold lasts at most, so a page that asks for longer, or is never released, still answers. */
const longestHoldMs = 20_000

type Holder = { current: number; most: number; holds: number }

/**
 * Routes that count how many visitors hold a named thing at once, as tests that share outside state would.
 *
 * - `GET /holders/hold?name=inbox&ms=300` holds `inbox` for `ms` milliseconds, then answers with a page whose
 *   `overlap` is the most holders of `inbox` the hold saw at once, itself included. With `until=2` it answers as
 *   soon as that many hold it at once, which shows two visitors overlapping without waiting out the whole hold. With
 *   `release=1` it holds until `GET /holders/release?name=inbox`, so a test decides when the hold ends.
 * - `GET /holders?name=inbox` answers `{ current, most, holds }` as JSON: holders now, the most at once since the
 *   app started, and how many holds began.
 */
export function holderRoutes(): Route[] {
  const holders = new Map<string, Holder>()
  const waiting = new Set<() => void>()
  const releases = new Map<string, Set<() => void>>()
  const holderOf = (name: string): Holder => {
    const known = holders.get(name)
    if (known !== undefined) return known
    const holder = { current: 0, most: 0, holds: 0 }
    holders.set(name, holder)
    return holder
  }
  return [
    [
      'GET /holders/hold',
      (request, response) => {
        const query = queryOf(request)
        const name = query.get('name') ?? ''
        const holdMs = Math.min(longestHoldMs, Math.max(0, Number(query.get('ms') ?? '0') || 0))
        const until = Number(query.get('until') ?? '0') || 0
        const released = query.get('release') === '1'
        const holder = holderOf(name)
        holder.current += 1
        holder.holds += 1
        holder.most = Math.max(holder.most, holder.current)
        let seen = holder.current
        for (const notify of waiting) notify()
        let finished = false
        const finish = (): void => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          waiting.delete(watch)
          releases.get(name)?.delete(finish)
          holder.current -= 1
          const main = `<p>Held <span data-testid="held-name">${escapeHtml(name)}</span>.</p><p>Most holders at once: <span data-testid="overlap">${seen}</span></p>`
          respondWith(response, 200, HTML_TYPE, htmlPage('Held', main))
        }
        const watch = (): void => {
          seen = Math.max(seen, holder.current)
          if (until > 0 && seen >= until) finish()
        }
        const timer = setTimeout(finish, released ? longestHoldMs : holdMs)
        timer.unref()
        if (released) releases.set(name, (releases.get(name) ?? new Set()).add(finish))
        waiting.add(watch)
        watch()
        response.on('close', finish)
      },
    ],
    [
      'GET /holders/release',
      (request, response) => {
        const held = [...(releases.get(queryOf(request).get('name') ?? '') ?? [])]
        for (const finish of held) finish()
        respondWith(response, 200, JSON_TYPE, JSON.stringify({ released: held.length }))
      },
    ],
    [
      'GET /holders',
      (request, response) => {
        const holder = holderOf(queryOf(request).get('name') ?? '')
        respondWith(response, 200, JSON_TYPE, JSON.stringify(holder))
      },
    ],
  ]
}
