import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Route } from './route.ts'
import type { Sessions } from './sign-in.ts'
import { createHash } from 'node:crypto'
import { text } from 'node:stream/consumers'
import { escapeHtml, htmlPage } from './html.ts'
import { HTML_TYPE, JSON_TYPE, queryOf, respondWith } from './route.ts'
import { STORED_USER_KEY } from './sign-in.ts'

/**
 * A record every signed-in account of the app can read, as a team's shared space holds them: its reference, which the
 * test that made it chose, its title, which several records may share, and the account that made it.
 */
export type SharedRecord = { reference: string; title: string; createdBy: string }

/** What the shared records give a test besides their routes: every record, in the order they were made. */
export type SharedRecords = { routes: Route[]; all(): readonly SharedRecord[] }

const longestText = 200

/**
 * The colour an account's banner is painted in, from its name, so a screenshot shows whose session it is.
 *
 * @example accountColour('owner-a') // [r, g, b], the same every time
 */
export function accountColour(user: string): readonly [number, number, number] {
  const [red = 0, green = 0, blue = 0] = createHash('sha256').update(user).digest()
  return [red, green, blue]
}

const CREATE_SCRIPT = `
const status = document.querySelector('[data-testid="record-status"]')
document.querySelector('[data-testid="stored-user"]').textContent = localStorage.getItem('${STORED_USER_KEY}') ?? ''
document.querySelector('[data-testid="create-record"]').addEventListener('click', async () => {
  const reference = document.querySelector('[data-testid="record-reference"]').value
  const title = document.querySelector('[data-testid="record-title"]').value
  status.textContent = 'Saving…'
  const response = await fetch('/shared/api/records', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reference, title }),
  })
  const answer = await response.json()
  status.textContent = response.ok ? 'Created ' + answer.reference : answer.error
})
`

const READ_SCRIPT = `
document.querySelector('[data-testid="stored-user"]').textContent = localStorage.getItem('${STORED_USER_KEY}') ?? ''
`

/**
 * Records that every signed-in account reads, for tests where one account makes a record and another reads that exact
 * record. Records start empty each time the app starts and are never reset by a browser: a fresh browser context
 * still finds what an earlier attempt made.
 *
 * - `GET /shared` is the page to make a record, for the account the session cookie signs in.
 * - `GET /shared/record?reference=…` shows the record with that reference, and who made it, to any signed-in account.
 * - `POST /shared/api/records` makes a record from `{ reference, title }`, for the signed-in account.
 * - `GET /shared/api/records?title=…` lists the records with that title as JSON, so a check can count them.
 * - `POST /shared/api/seed` makes a record from `{ reference, title, createdBy }` with no session, as a host's own
 *   fixture service would, and `POST /shared/api/delete` removes the one with `{ reference }`.
 * - `GET /shared/holding?name=…&ms=…` is a page whose own script holds the holders counter's `name` for `ms`, so the
 *   hold lasts as long as the page's browser context does, whatever the test is doing meanwhile.
 *
 * Each page paints a banner across its top in the colour of the account it signs in, and shows that account's name
 * and the name the browser kept, so a screenshot and a page's text both say whose session it is.
 */
export function sharedRecords(sessions: Sessions): SharedRecords {
  const records: SharedRecord[] = []
  const create = (record: SharedRecord, response: ServerResponse): void => {
    if (records.some((each) => each.reference === record.reference)) return respondWith(response, 409, JSON_TYPE, JSON.stringify({ error: `A record already has the reference ${record.reference}.` }))
    records.push(record)
    respondWith(response, 201, JSON_TYPE, JSON.stringify({ reference: record.reference }))
  }
  const routes: Route[] = [
    ['GET /shared', (request, response) => respondWith(response, 200, HTML_TYPE, createPage(sessions.userOf(request.headers.cookie)))],
    [
      'GET /shared/holding',
      (request, response) => {
        const query = queryOf(request)
        const hold = `/holders/hold?name=${encodeURIComponent(query.get('name') ?? '')}&ms=${encodeURIComponent(query.get('ms') ?? '0')}`
        const script = `fetch(${JSON.stringify(hold)}).catch(() => undefined)`
        respondWith(response, 200, HTML_TYPE, htmlPage('Holding', '<p data-testid="holding">Holding in the background</p>', script))
      },
    ],
    [
      'GET /shared/record',
      (request, response) => {
        const reference = queryOf(request).get('reference') ?? ''
        const user = sessions.userOf(request.headers.cookie)
        respondWith(response, 200, HTML_TYPE, recordPage(user, user === undefined ? undefined : records.find((each) => each.reference === reference)))
      },
    ],
    [
      'POST /shared/api/records',
      (request, response) => {
        const user = sessions.userOf(request.headers.cookie)
        readBody(request)
          .then((body) => {
            if (user === undefined) return respondWith(response, 401, JSON_TYPE, JSON.stringify({ error: 'Sign in to make a record.' }))
            const fields = readFields(body, ['reference', 'title'])
            if (fields === undefined) return respondWith(response, 400, JSON_TYPE, JSON.stringify({ error: 'Give a reference and a title.' }))
            create({ reference: fields['reference'] ?? '', title: fields['title'] ?? '', createdBy: user }, response)
          })
          .catch(() => response.destroy())
      },
    ],
    [
      'GET /shared/api/records',
      (request, response) => {
        const title = queryOf(request).get('title')
        respondWith(response, 200, JSON_TYPE, JSON.stringify({ records: records.filter((each) => title === null || each.title === title) }))
      },
    ],
    [
      'POST /shared/api/seed',
      (request, response) => {
        readBody(request)
          .then((body) => {
            const fields = readFields(body, ['reference', 'title', 'createdBy'])
            if (fields === undefined) return respondWith(response, 400, JSON_TYPE, JSON.stringify({ error: 'Give a reference, a title and createdBy.' }))
            create({ reference: fields['reference'] ?? '', title: fields['title'] ?? '', createdBy: fields['createdBy'] ?? '' }, response)
          })
          .catch(() => response.destroy())
      },
    ],
    [
      'POST /shared/api/delete',
      (request, response) => {
        readBody(request)
          .then((body) => {
            const fields = readFields(body, ['reference'])
            const index = fields === undefined ? -1 : records.findIndex((each) => each.reference === fields['reference'])
            if (index === -1) return respondWith(response, 404, JSON_TYPE, JSON.stringify({ error: 'No record has that reference.' }))
            records.splice(index, 1)
            respondWith(response, 200, JSON_TYPE, JSON.stringify({ deleted: fields?.['reference'] }))
          })
          .catch(() => response.destroy())
      },
    ],
  ]
  return { routes, all: () => records.map((record) => ({ ...record })) }
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return text(request).then((body) => {
    try {
      return JSON.parse(body)
    } catch {
      return undefined
    }
  })
}

// Each field must be text of 1 to 200 characters; anything else is refused whole.
function readFields(body: unknown, names: readonly string[]): Record<string, string> | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const fields: Record<string, string> = {}
  for (const name of names) {
    const value: unknown = Object.entries(body).find(([key]) => key === name)?.[1]
    if (typeof value !== 'string' || value.trim() === '' || value.length > longestText) return undefined
    fields[name] = value
  }
  return fields
}

function banner(user: string): string {
  const [red, green, blue] = accountColour(user)
  return `<div data-testid="account-banner" style="position:fixed;top:0;left:0;right:0;height:56px;background:rgb(${red},${green},${blue})"></div>
<div style="height:64px"></div>
<p data-testid="shared-account">Signed in as ${escapeHtml(user)}</p>
<p>Saved in this browser: <span data-testid="stored-user"></span></p>`
}

function createPage(user: string | undefined): string {
  if (user === undefined) return htmlPage('Shared records', '<p data-testid="shared-account">Signed out</p><p>Sign in to make a record.</p>')
  const main = `${banner(user)}
<label for="reference">Reference</label>
<input id="reference" data-testid="record-reference" autocomplete="off">
<label for="title">Title</label>
<input id="title" data-testid="record-title" autocomplete="off">
<button type="button" data-testid="create-record">Create record</button>
<p data-testid="record-status"></p>`
  return htmlPage('Shared records', main, CREATE_SCRIPT)
}

function recordPage(user: string | undefined, record: SharedRecord | undefined): string {
  if (user === undefined) return htmlPage('Shared record', '<p data-testid="shared-account">Signed out</p><p data-testid="record-missing">Sign in to read records.</p>')
  const shown =
    record === undefined
      ? '<p data-testid="record-missing">No record has that reference.</p>'
      : `<dl>
<dt>Title</dt><dd data-testid="record-title-shown">${escapeHtml(record.title)}</dd>
<dt>Reference</dt><dd data-testid="record-reference-shown">${escapeHtml(record.reference)}</dd>
<dt>Made by</dt><dd data-testid="record-owner">${escapeHtml(record.createdBy)}</dd>
</dl>`
  return htmlPage('Shared record', `${banner(user)}\n${shown}`, READ_SCRIPT)
}
