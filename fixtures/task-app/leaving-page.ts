import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Route } from './route.ts'
import { escapeHtml } from './html.ts'
import { HTML_TYPE, queryOf, respondWith } from './route.ts'

// The save answers this long after it arrives unless the edit page was opened with another `wait`, and never later than
// the longest, so a server left waiting still ends its answer.
const defaultWaitMs = 600
const longestWaitMs = 10_000

/** The heading of the edit page, which the page the save answers with lacks. */
export const EDIT_HEADING = 'Editing: Release checklist'

// Four ways the edit page leaves for the save: the form's own button, a link, a click listener that assigns the address,
// and a click listener that submits the form on a timer of 0. The save answers each with a 500 page. The guard checkbox
// sets a beforeunload handler, which asks before the page leaves.
function editScript(): string {
  return `
const byTestId = (testId) => document.querySelector('[data-testid="' + testId + '"]')
const form = byTestId('edit-form')
byTestId('save-now').addEventListener('click', () => location.assign(form.action))
byTestId('save-soon').addEventListener('click', () => setTimeout(() => form.submit(), 0))
const leaving = (event) => { event.preventDefault(); event.returnValue = '' }
byTestId('guard').addEventListener('change', (event) => {
  if (event.target.checked) addEventListener('beforeunload', leaving)
  else removeEventListener('beforeunload', leaving)
})
`
}

/**
 * The edit page of a task. Every way out of it reaches `/leaving/save`, which answers after `waitMs` with a server error
 * page that has no edit heading and shows an error banner. The links to `/leaving/empty` and `/leaving/report` lead to an
 * answer with no content and to a download, which the browser gives up without opening a document, and the `#details`
 * link moves within the document.
 */
export function renderEditPage(waitMs: number): string {
  const save = `/leaving/save?wait=${waitMs}`
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

/** The routes of the leaving pages. */
export function leavingRoutes(): Route[] {
  const save = (request: IncomingMessage, response: ServerResponse): void => {
    request.resume()
    // The timer does not hold the server's process open, and an answer to a client that left is dropped.
    setTimeout(() => respondWith(response, 500, HTML_TYPE, SAVE_ERROR_PAGE), waitOf(request)).unref()
  }
  return [
    ['GET /leaving/edit', (request, response) => respondWith(response, 200, HTML_TYPE, renderEditPage(waitOf(request)))],
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
