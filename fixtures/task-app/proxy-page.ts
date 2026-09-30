/** Where the proxy check page lives. Its service worker controls every address under it. */
export const PROXY_CHECK_PATH = '/proxy-check/'

// Every kind of request a page makes: its document, a fetch, a frame of another site, a service worker's script
// and a fetch the worker makes itself. The page shows what each answered, so a server that refuses a request
// that did not come through the proxy shows as "refused", and a refused frame never says it loaded.
const SCRIPT = `
const show = (testId, value) => { document.querySelector('[data-testid="' + testId + '"]').textContent = value }
addEventListener('message', (event) => { if (event.data === 'framed') show('frame-status', 'loaded') })
const read = (response) => (response.ok ? response.text() : 'refused')
const otherSite = location.hostname === 'localhost' ? '127.0.0.1' : 'localhost'
document.querySelector('[data-testid="frame"]').src = 'http://' + otherSite + ':' + location.port + '${PROXY_CHECK_PATH}frame'
fetch('${PROXY_CHECK_PATH}data').then(read).then((text) => show('page-fetch', text), () => show('page-fetch', 'failed'))
navigator.serviceWorker.register('${PROXY_CHECK_PATH}worker.js')
  .then(() => navigator.serviceWorker.ready)
  .then(() => navigator.serviceWorker.controller ?? new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })))
  .then(() => fetch('${PROXY_CHECK_PATH}via-worker'))
  .then(read)
  .then((text) => show('worker-fetch', text), () => show('worker-fetch', 'failed'))
`

/** A page that makes every kind of request, and shows what its fetch and its service worker's fetch answered. */
export const PROXY_CHECK_PAGE: string = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Proxy check</title>
<link rel="icon" href="data:,">
</head>
<body>
<p>Page fetch: <span data-testid="page-fetch">waiting</span></p>
<p>Worker fetch: <span data-testid="worker-fetch">waiting</span></p>
<p>Frame: <span data-testid="frame-status">waiting</span></p>
<iframe data-testid="frame" title="Another site"></iframe>
<script>${SCRIPT}</script>
</body>
</html>
`

/** The frame of another site the proxy check page shows, which tells the page it loaded. */
export const PROXY_CHECK_FRAME = `<!doctype html><title>Frame</title><p>Framed</p><script>parent.postMessage('framed', '*')</script>`

/** A service worker that answers `via-worker` with a fetch of its own, so that request comes from the worker. */
export const PROXY_CHECK_WORKER: string = `
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (event) => {
  if (new URL(event.request.url).pathname === '${PROXY_CHECK_PATH}via-worker') event.respondWith(fetch('${PROXY_CHECK_PATH}from-worker'))
})
`
