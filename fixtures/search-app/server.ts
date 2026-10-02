import type { ServerResponse } from 'node:http'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { renderSearchPage } from './page.ts'

export type SearchAppOptions = {
  /** How long the API waits before it answers. */
  apiDelayMs?: number
  /** How long the page waits after typing before it asks the server. */
  debounceMs?: number
}

export type SearchApp = {
  /** The app's origin, such as `http://127.0.0.1:53124`. */
  readonly url: string
  /** How many requests of any kind the server has received. */
  requests(): number
  close(): Promise<void>
}

export const defaultApiDelayMs = 150
export const defaultDebounceMs = 300

/** The titles the app searches. Exactly three contain "release". */
export const ITEMS: readonly string[] = [
  'Release checklist',
  'Release notes',
  'Prepare the release branch',
  'Plan the sprint',
  'Fix the sign-in bug',
  'Write the onboarding guide',
  'Review pull requests',
  'Update the dependencies',
  'Rotate the API keys',
  'Archive old tasks',
  'Design the settings page',
  'Migrate the database',
  'Add the export button',
  'Translate the help pages',
  'Measure the cold start',
  'Draft the pricing page',
  'Set up the staging server',
  'Clean the test fixtures',
  'Record the demo video',
  'Answer support tickets',
]

const HTML = 'text/html; charset=utf-8'
const JSON_TYPE = 'application/json; charset=utf-8'
const TEXT = 'text/plain; charset=utf-8'

/**
 * Starts the search app on an ephemeral loopback port. Its page answers at once; its API answers after
 * `apiDelayMs`, so the app's own waiting, not the runner's, sets the pace of a test.
 *
 * @example const app = await startSearchApp({ apiDelayMs: 150, debounceMs: 300 })
 */
export async function startSearchApp(options: SearchAppOptions = {}): Promise<SearchApp> {
  const apiDelayMs = options.apiDelayMs ?? defaultApiDelayMs
  const page = renderSearchPage(options.debounceMs ?? defaultDebounceMs)
  const timers = new Set<NodeJS.Timeout>()
  let requests = 0
  let closing: Promise<void> | undefined

  function answerLater(response: ServerResponse, body: string): void {
    const timer = setTimeout(() => {
      timers.delete(timer)
      respond(response, 200, JSON_TYPE, body)
    }, apiDelayMs)
    timers.add(timer)
  }

  const server = createServer((request, response) => {
    requests += 1
    if (request.method !== 'GET') {
      respond(response, 405, TEXT, 'Only GET')
      return
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    switch (url.pathname) {
      case '/':
        respond(response, 200, HTML, page)
        return
      case '/api/items':
        answerLater(response, JSON.stringify({ items: ITEMS }))
        return
      case '/api/search': {
        const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
        answerLater(response, JSON.stringify({ items: ITEMS.filter((title) => title.toLowerCase().includes(query)) }))
        return
      }
      default:
        respond(response, 404, TEXT, 'Not found')
    }
  })

  async function close(): Promise<void> {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    const closed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    server.closeAllConnections()
    await closed
  }

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('The search app has no TCP address.')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests: () => requests,
    close: () => (closing ??= close()),
  }
}

function respond(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  response.end(body)
}
