import type { Route } from './route.ts'
import { escapeHtml, htmlPage } from './html.ts'
import { HTML_TYPE, JSON_TYPE, queryOf, respondWith } from './route.ts'

// A page whose requests a test answers itself. Everything it asks the server for is under /routes/api/, and the server
// counts each such request by path, so a test can tell a request it answered never reached the server:
// - the task list it fetches as it loads, and renders;
// - a slow endpoint a button fetches, which shows what came back or the error;
// - an image, whose size the page shows once it loads;
// - a form that posts a task and shows the status of the answer;
// - one task by its id, for a pattern that is a regular expression;
// - a request whose status and its phrase the page shows, and one that the server would redirect, which shows where it
//   ended and what it read there;
// - a frame of the same site that fetches as well, and tells the page what it got, and a page that holds that frame
//   at another address, such as one of another site;
// - a link that opens the page again in a new window;
// - a page a service worker controls, whose worker fetches for it.
const ROUTES_SCRIPT = `
const byTestId = (testId) => document.querySelector('[data-testid="' + testId + '"]')
const show = (testId, text) => { byTestId(testId).textContent = text }
fetch('/routes/api/tasks')
  .then((response) => response.json())
  .then((tasks) => {
    byTestId('tasks').replaceChildren(...tasks.map((task) => Object.assign(document.createElement('li'), { textContent: task.title })))
    show('tasks-status', 'loaded ' + tasks.length)
  })
  .catch((error) => show('tasks-status', 'tasks failed: ' + error.message))
byTestId('slow').addEventListener('click', () => {
  fetch('/routes/api/slow')
    .then(async (response) => show('slow-status', 'slow answered ' + response.status + ' ' + (await response.text())))
    .catch((error) => show('slow-status', 'slow failed: ' + error.message))
})
byTestId('task-7').addEventListener('click', async () => {
  const response = await fetch('/routes/api/tasks/7')
  show('task-status', response.status + ' ' + (await response.text()))
})
byTestId('status').addEventListener('click', () => {
  fetch('/routes/api/status')
    .then((response) => show('status-status', response.status + ' ' + response.statusText))
    .catch((error) => show('status-status', 'status failed: ' + error.message))
})
byTestId('jump').addEventListener('click', () => {
  fetch('/routes/api/jump')
    .then(async (response) => show('jump-status', response.status + ' ' + new URL(response.url).pathname + ' ' + (await response.text())))
    .catch((error) => show('jump-status', 'jump failed: ' + error.message))
})
byTestId('post').addEventListener('click', async () => {
  const response = await fetch('/routes/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: byTestId('title').value }) })
  show('post-status', 'posted ' + response.status + ' ' + (response.headers.get('x-saved-by') ?? 'the server'))
})
const image = byTestId('image')
const sized = () => show('image-status', image.naturalWidth + 'x' + image.naturalHeight)
image.addEventListener('load', sized)
image.addEventListener('error', () => show('image-status', 'image failed'))
if (image.complete && image.naturalWidth > 0) sized()
addEventListener('message', (event) => { if (event.origin === location.origin) show('frame-status', String(event.data)) })
`

/** The page whose requests the routes tests answer. */
export const ROUTES_PAGE: string = htmlPage(
  'Routes',
  `<ul data-testid="tasks"></ul>
<p data-testid="tasks-status">Loading</p>
<p><button type="button" data-testid="slow">Load slowly</button> <span data-testid="slow-status">Not asked</span></p>
<p><button type="button" data-testid="task-7">Open task 7</button> <span data-testid="task-status">Not asked</span></p>
<p><button type="button" data-testid="status">Ask the status</button> <span data-testid="status-status">Not asked</span></p>
<p><button type="button" data-testid="jump">Follow a jump</button> <span data-testid="jump-status">Not asked</span></p>
<p><label>Title <input data-testid="title" autocomplete="off"></label> <button type="button" data-testid="post">Post</button> <span data-testid="post-status">Not posted</span></p>
<p><img data-testid="image" src="/routes/api/image.png" alt="Picture"> <span data-testid="image-status">Not loaded</span></p>
<iframe data-testid="frame" src="/routes/frame" title="Frame" width="300" height="60"></iframe>
<p data-testid="frame-status">Frame waiting</p>
<p><a data-testid="open-popup" href="/routes" target="_blank">Open in a new window</a></p>`,
  ROUTES_SCRIPT,
)

const FRAME_PAGE = htmlPage(
  'Frame',
  '<p data-testid="frame-text">Frame</p>',
  `fetch('/routes/api/frame').then((response) => response.text()).then((text) => parent.postMessage('frame got ' + text, '*'), (error) => parent.postMessage('frame failed: ' + error.message, '*'))`,
)

// A page whose one frame is the frame page at the address its query names, such as one of another site, and which shows
// what that frame tells it, from whatever origin.
function crossPage(frame: string): string {
  return htmlPage(
    'Cross',
    `<iframe data-testid="frame" src="${escapeHtml(frame)}" title="Frame" width="300" height="60"></iframe><p data-testid="frame-status">Frame waiting</p>`,
    `addEventListener('message', (event) => { document.querySelector('[data-testid="frame-status"]').textContent = String(event.data) })`,
  )
}

// A page a service worker controls once it has registered and claimed it; its button fetches through the worker.
const WORKER_PAGE = htmlPage(
  'Worker',
  `<p data-testid="worker-status">Registering</p><p><button type="button" data-testid="worker-fetch">Fetch</button> <span data-testid="worker-answer">Not asked</span></p>`,
  `const show = (testId, text) => { document.querySelector('[data-testid="' + testId + '"]').textContent = text }
navigator.serviceWorker.register('/routes/worker.js').then(() => navigator.serviceWorker.ready).then(() => {
  if (navigator.serviceWorker.controller !== null) show('worker-status', 'controlled')
  else navigator.serviceWorker.addEventListener('controllerchange', () => show('worker-status', 'controlled'))
})
document.querySelector('[data-testid="worker-fetch"]').addEventListener('click', async () => {
  const response = await fetch('/routes/api/worker')
  show('worker-answer', response.status + ' ' + (await response.text()))
})`,
)

// Answers the page's requests to /routes/api/ itself, from the network, so a route on the page never sees them.
const WORKER_SCRIPT = `self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (event) => {
  if (new URL(event.request.url).pathname.startsWith('/routes/api/')) event.respondWith(fetch(event.request))
})
`

/** The picture the server gives for /routes/api/image.png: a PNG of 2 by 1 pixels. */
export const SERVER_IMAGE: Uint8Array = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP4z8DAwPAfAAcAAf9+CLHQAAAAAElFTkSuQmCC', 'base64')

/** A picture a test answers /routes/api/image.png with instead: a PNG of 3 by 2 pixels. */
export const MOCKED_IMAGE: Uint8Array = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAE0lEQVR4nGM8ceLECQYoYGJAAgBJvgMkTY+mlAAAAABJRU5ErkJggg==', 'base64')

/** Every request the routes page made of /routes/api/, counted by method and path, each test app its own. */
export type RouteCounts = Record<string, number>

/** The routes of the routes page, and what reached the server of its endpoints, counted by method and path. */
export function routesRoutes(): Route[] {
  const counts: RouteCounts = {}
  const counted = (key: string): void => {
    counts[key] = (counts[key] ?? 0) + 1
  }
  return [
    ['GET /routes', (_request, response) => respondWith(response, 200, HTML_TYPE, ROUTES_PAGE)],
    ['GET /routes/frame', (_request, response) => respondWith(response, 200, HTML_TYPE, FRAME_PAGE)],
    ['GET /routes/cross', (request, response) => respondWith(response, 200, HTML_TYPE, crossPage(queryOf(request).get('frame') ?? '/routes/frame'))],
    ['GET /routes/worker', (_request, response) => respondWith(response, 200, HTML_TYPE, WORKER_PAGE)],
    ['GET /routes/worker.js', (_request, response) => respondWith(response, 200, 'text/javascript; charset=utf-8', WORKER_SCRIPT)],
    ['GET /routes/counts', (_request, response) => respondWith(response, 200, JSON_TYPE, JSON.stringify(counts))],
    [
      'GET /routes/api/tasks',
      (_request, response) => {
        counted('GET /routes/api/tasks')
        respondWith(response, 200, JSON_TYPE, JSON.stringify([{ title: 'Real task' }]))
      },
    ],
    [
      'POST /routes/api/tasks',
      (request, response) => {
        counted('POST /routes/api/tasks')
        request.resume()
        request.on('end', () => respondWith(response, 201, JSON_TYPE, JSON.stringify({ saved: true })))
      },
    ],
    [
      'GET /routes/api/tasks/7',
      (_request, response) => {
        counted('GET /routes/api/tasks/7')
        respondWith(response, 200, 'text/plain; charset=utf-8', 'task 7 from the server')
      },
    ],
    [
      'GET /routes/api/status',
      (_request, response) => {
        counted('GET /routes/api/status')
        respondWith(response, 200, 'text/plain; charset=utf-8', 'status from the server')
      },
    ],
    [
      'GET /routes/api/jump',
      (_request, response) => {
        counted('GET /routes/api/jump')
        respondWith(response, 200, 'text/plain; charset=utf-8', 'jump from the server')
      },
    ],
    [
      'GET /routes/api/slow',
      (_request, response) => {
        counted('GET /routes/api/slow')
        setTimeout(() => respondWith(response, 200, 'text/plain; charset=utf-8', 'slow from the server'), 200)
      },
    ],
    [
      'GET /routes/api/image.png',
      (_request, response) => {
        counted('GET /routes/api/image.png')
        if (response.destroyed) return
        response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
        response.end(SERVER_IMAGE)
      },
    ],
    [
      'GET /routes/api/frame',
      (_request, response) => {
        counted('GET /routes/api/frame')
        respondWith(response, 200, 'text/plain; charset=utf-8', 'from the server')
      },
    ],
    [
      'GET /routes/api/worker',
      (_request, response) => {
        counted('GET /routes/api/worker')
        respondWith(response, 200, 'text/plain; charset=utf-8', 'from the network')
      },
    ],
  ]
}
