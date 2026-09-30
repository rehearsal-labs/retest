/** Where the worker's answers are counted, in the origin's `localStorage`. */
export const WORKER_ANSWERS_KEY = 'service-worker-answers'

/**
 * A service worker that answers every navigation itself, with a page whose script counts the answer, so a test
 * can tell whether a document came from the worker.
 */
export const SERVICE_WORKER: string = `
const page = '<!doctype html><title>Worker</title><p data-testid="worker-answer">Answered by the service worker</p>' +
  '<script>localStorage.setItem("${WORKER_ANSWERS_KEY}", String(Number(localStorage.getItem("${WORKER_ANSWERS_KEY}") ?? "0") + 1))</script>'
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') event.respondWith(new Response(page, { headers: { 'content-type': 'text/html' } }))
})
`

/** A page that registers the service worker for the whole origin and says when it is ready. */
export const SERVICE_WORKER_PAGE: string = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Service worker</title>
<link rel="icon" href="data:,">
</head>
<body>
<p data-testid="worker">Registering</p>
<script>
navigator.serviceWorker.register('/service-worker.js')
  .then(() => navigator.serviceWorker.ready)
  .then(() => { document.querySelector('[data-testid="worker"]').textContent = 'Ready' })
</script>
</body>
</html>
`
