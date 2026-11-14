import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Route } from './route.ts'
import { escapeHtml } from './html.ts'
import { HTML_TYPE, JSON_TYPE, queryOf, respondWith } from './route.ts'

// The save answers this long after it arrives unless the edit page was opened with another `wait`, and never later than
// the longest, so a server left waiting still ends its answer.
const defaultWaitMs = 600
const longestWaitMs = 10_000

/** Where a test tells the edit page's Save when told button to submit the form, which it waits for after its click. */
export const TELL_PATH = '/leaving/tell'

/** Where a test lets go of every save the server holds, and reads how many it held. */
export const RELEASE_PATH = '/leaving/release'

/** Where a test reads how many saves the server holds now. */
export const HELD_PATH = '/leaving/held'

/** The heading of the edit page, which the page the save answers with lacks. */
export const EDIT_HEADING = 'Editing: Release checklist'

// Five ways the edit page leaves for the save: the form's own button, a link, a click listener that assigns the address,
// a click listener that submits the form on a timer of 0, and one that submits it once a test tells the server to, long
// after its click has answered. The save answers each with a 500 page. The guard checkbox sets a beforeunload handler,
// which asks before the page leaves.
function editScript(): string {
  return `
const byTestId = (testId) => document.querySelector('[data-testid="' + testId + '"]')
const form = byTestId('edit-form')
byTestId('save-now').addEventListener('click', () => location.assign(form.action))
byTestId('save-soon').addEventListener('click', () => setTimeout(() => form.submit(), 0))
byTestId('save-when-told').addEventListener('click', async () => {
  const told = await fetch('${TELL_PATH}')
  if (told.ok) form.submit()
})
const leaving = (event) => { event.preventDefault(); event.returnValue = '' }
byTestId('guard').addEventListener('change', (event) => {
  if (event.target.checked) addEventListener('beforeunload', leaving)
  else removeEventListener('beforeunload', leaving)
})
`
}

/**
 * The edit page of a task. Every way out of it reaches `/leaving/save`, which answers after `waitMs` with a server error
 * page that has no edit heading and shows an error banner, or, when `held`, once a test asks for RELEASE_PATH. The links
 * to `/leaving/empty` and `/leaving/report` lead to an answer with no content and to a download, which the browser gives
 * up without opening a document, and the `#details` link moves within the document.
 */
export function renderEditPage(waitMs: number, held: boolean): string {
  const save = `/leaving/save?wait=${waitMs}${held ? '&held=1' : ''}`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Edit task</title>
<link rel="icon" href="data:,">
</head>
<body>
<main>
<h1 data-testid="task-heading">${escapeHtml(EDIT_HEADING)}</h1>
<form data-testid="edit-form" method="post" action="${escapeHtml(save)}">
<label>Due date <input name="due" value="2026-11-20" data-testid="due"></label>
<button data-testid="save">Save</button>
</form>
<p>
<a href="${escapeHtml(save)}" data-testid="save-link">Save by link</a>
<button type="button" data-testid="save-now">Save now</button>
<button type="button" data-testid="save-soon">Save soon</button>
<button type="button" data-testid="save-when-told">Save when told</button>
</p>
<p>
<a href="/leaving/empty" data-testid="empty-link">Nothing</a>
<a href="/leaving/report" data-testid="report-link">Report</a>
<a href="#details" data-testid="details-link">Details</a>
</p>
<p><label><input type="checkbox" data-testid="guard"> Warn before leaving</label></p>
<p id="details" data-testid="details">Details</p>
</main>
<script>${editScript()}</script>
</body>
</html>
`
}

/** What the save answers with: a server error page with its own heading and an error banner. */
export const SAVE_ERROR_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Server error</title>
<link rel="icon" href="data:,">
</head>
<body>
<main>
<h1>Something went wrong</h1>
<p role="alert" data-testid="error-banner">The task could not be saved.</p>
</main>
</body>
</html>
`

/**
 * A page that holds the edit page in a frame, from `origin` when given, so a frame of another site runs in a process of
 * its own, and from the page's own origin otherwise.
 */
export function renderFramedPage(origin: string, waitMs: number): string {
  const source = `${origin}/leaving/edit?wait=${waitMs}`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Tasks</title>
<link rel="icon" href="data:,">
</head>
<body>
<main>
<h1>Tasks</h1>
<iframe title="Edit task" src="${escapeHtml(source)}" width="600" height="400"></iframe>
</main>
</body>
</html>
`
}

function waitOf(request: IncomingMessage): number {
  const asked = Number(queryOf(request).get('wait') ?? defaultWaitMs)
  return Number.isInteger(asked) && asked >= 0 ? Math.min(asked, longestWaitMs) : defaultWaitMs
}

function heldOf(request: IncomingMessage): boolean {
  return queryOf(request).get('held') === '1'
}

type Later = {
  /** How long the request waits at most, so a server left waiting still answers. */
  readonly ms: number
  /** The answer once its time comes, or once the requests in `waiting` are answered. */
  readonly answer: () => void
  /** The answer when `ms` passes first, `answer` when not given. */
  readonly late?: () => void
  /** Where the request waits to be answered with the others, as a test asks. */
  readonly waiting?: Set<() => void>
}

// The timer does not hold the server's process open, and a request whose client left stops waiting, its answer dropped.
function answerLater(response: ServerResponse, { ms, answer, late = answer, waiting }: Later): void {
  const stop = (): void => {
    clearTimeout(timer)
    waiting?.delete(settle)
  }
  const settle = (): void => {
    stop()
    answer()
  }
  const timer = setTimeout(() => {
    stop()
    late()
  }, ms)
  timer.unref()
  waiting?.add(settle)
  response.on('close', stop)
}

/** Answers every request waiting in `waiting`, and says how many there were. */
function answerAll(waiting: Set<() => void>): number {
  const all = [...waiting]
  for (const settle of all) settle()
  return all.length
}

/** The routes of the leaving pages. */
export function leavingRoutes(): Route[] {
  const heldSaves = new Set<() => void>()
  const tellings = new Set<() => void>()
  const save = (request: IncomingMessage, response: ServerResponse): void => {
    request.resume()
    const answer = (): void => respondWith(response, 500, HTML_TYPE, SAVE_ERROR_PAGE)
    if (heldOf(request)) answerLater(response, { ms: longestWaitMs, answer, waiting: heldSaves })
    else answerLater(response, { ms: waitOf(request), answer })
  }
  return [
    ['GET /leaving/edit', (request, response) => respondWith(response, 200, HTML_TYPE, renderEditPage(waitOf(request), heldOf(request)))],
    [
      `GET ${TELL_PATH}`,
      (_request, response) =>
        answerLater(response, {
          ms: longestWaitMs,
          answer: () => respondWith(response, 200, JSON_TYPE, '{}'),
          // A page nobody told stays where it is.
          late: () => respondWith(response, 504, JSON_TYPE, '{}'),
          waiting: tellings,
        }),
    ],
    [
      `POST ${TELL_PATH}`,
      (request, response) => {
        request.resume()
        respondWith(response, 200, JSON_TYPE, JSON.stringify({ told: answerAll(tellings) }))
      },
    ],
    [
      `POST ${RELEASE_PATH}`,
      (request, response) => {
        request.resume()
        respondWith(response, 200, JSON_TYPE, JSON.stringify({ released: answerAll(heldSaves) }))
      },
    ],
    [`GET ${HELD_PATH}`, (_request, response) => respondWith(response, 200, JSON_TYPE, JSON.stringify({ held: heldSaves.size }))],
    ['GET /leaving/framed', (request, response) => respondWith(response, 200, HTML_TYPE, renderFramedPage(queryOf(request).get('frame') ?? '', waitOf(request)))],
    ['POST /leaving/save', save],
    ['GET /leaving/save', save],
    ['GET /leaving/empty', (_request, response) => respondWith(response, 204, 'text/plain; charset=utf-8', '')],
    [
      'GET /leaving/report',
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="report.txt"', 'cache-control': 'no-store' })
        response.end('report')
      },
    ],
  ]
}
