import type { Route } from './route.ts'
import { queryOf } from './route.ts'
import { answerLater, defectOf, PAGE_HELPERS, sendJson, sendPage, workflowPage } from './workflow-page.ts'

/** The reports the dashboard lists once they arrive. */
export const REPORTS: readonly string[] = ['Weekly sales', 'Open tickets', 'Release health']

/** How long the page waits before it asks for the reports, and how long the server takes to answer. */
export const LOAD_DELAY_MS = 300

/** The route that finishes every export waiting on the server, as a test that releases them asks for it. */
export const EXPORT_RELEASE_PATH = '/workflow/api/export/release'

/** How long the server holds an export nobody releases, so a page that is never released still gets an answer. */
const EXPORT_LONGEST_MS = 15_000

// The page waits a moment before it asks, the server a moment before it answers, and Export stays disabled until
// the reports are in. An export stays "Preparing export…" until the server answers it, and the server holds it until
// a test asks for EXPORT_RELEASE_PATH, so a check of that state never races a timer. `?first-load=fails` makes the first answer an error the page offers to try again. The
// `spinner-stays` defect never hides the loading line once the reports arrive, as a forgotten state update would.
const REPORTS_SCRIPT = `${PAGE_HELPERS}
const failFirst = new URLSearchParams(location.search).get('first-load') === 'fails'
let attempt = 0
const load = () => {
  attempt += 1
  byTestId('loading').hidden = false
  byTestId('load-error').hidden = true
  setTimeout(async () => {
    const response = await fetch(withDefect('/workflow/api/reports?attempt=' + attempt + (failFirst ? '&first-load=fails' : '')))
    if (!response.ok) {
      byTestId('loading').hidden = true
      byTestId('load-error').hidden = false
      return
    }
    const reports = await response.json()
    byTestId('reports').replaceChildren(...reports.map((name) => {
      const item = document.createElement('li')
      item.dataset.testid = 'report-row'
      item.textContent = name
      return item
    }))
    if (pageDefect !== 'spinner-stays') byTestId('loading').hidden = true
    byTestId('export').disabled = false
  }, ${LOAD_DELAY_MS})
}
byTestId('retry').addEventListener('click', load)
byTestId('export').addEventListener('click', async () => {
  byTestId('export-status').textContent = 'Preparing export…'
  const response = await fetch(withDefect('/workflow/api/export'))
  byTestId('export-status').textContent = response.ok ? 'Export ready: ' + byTestId('reports').children.length + ' reports' : 'Export failed'
})
load()
`

const REPORTS_PAGE = workflowPage(
  'Reports',
  `<p role="status" data-testid="loading">Loading reports…</p>
<div role="alert" data-testid="load-error" hidden>Could not load reports. <button type="button" data-testid="retry">Try again</button></div>
<ul data-testid="reports"></ul>
<p><button type="button" data-testid="export" disabled>Export</button></p>
<p role="status" data-testid="export-status"></p>`,
  REPORTS_SCRIPT,
)

/**
 * Family 10, wait for loading and asynchronous UI state: a dashboard that shows a loading line, asks for its
 * reports after a timer, gets them from a slow server, and enables Export only once they are in. An export finishes
 * once a test releases it. Defects: `spinner-stays` keeps the loading line, and `never-answers` makes the server
 * hold the request until the browser gives up.
 */
export function asyncRoutes(): Route[] {
  const exports = new Set<() => void>()
  return [
    [
      'GET /workflow/api/export',
      (_request, response) => {
        const finish = (): void => {
          exports.delete(finish)
          sendJson(response, 200, { ready: true })
        }
        exports.add(finish)
        answerLater(response, EXPORT_LONGEST_MS, finish)
        response.on('close', () => exports.delete(finish))
      },
    ],
    [
      `POST ${EXPORT_RELEASE_PATH}`,
      (request, response) => {
        request.resume()
        const waiting = [...exports]
        for (const finish of waiting) finish()
        sendJson(response, 200, { released: waiting.length })
      },
    ],
    ['GET /workflow/reports', (_request, response) => sendPage(response, REPORTS_PAGE)],
    [
      'GET /workflow/api/reports',
      (request, response) => {
        const query = queryOf(request)
        if (defectOf(request) === 'never-answers') {
          answerLater(response, Number.POSITIVE_INFINITY, () => sendJson(response, 504, { error: 'The reports took too long.' }))
          return
        }
        const fails = query.get('first-load') === 'fails' && query.get('attempt') === '1'
        answerLater(response, LOAD_DELAY_MS, () => (fails ? sendJson(response, 503, { error: 'The reports are not available.' }) : sendJson(response, 200, REPORTS)))
      },
    ],
  ]
}
