import { escapeHtml, htmlPage } from './html.ts'

// Pages that produce every console, runtime error and network record Retest captures, each with a word of its own,
// so a check can find each record and tell it from every other. Release 1's diagnostic fixtures: the set is frozen,
// and a change to what a page emits is a change to the gates that read it.

/** The word each record of the main page carries, which a check looks for. */
export const DIAGNOSTICS_WORDS = {
  log: 'diagnostic log message',
  debug: 'diagnostic debug message',
  info: 'diagnostic info message',
  warning: 'diagnostic warning message',
  error: 'diagnostic error message',
  frame: 'from the same-process frame',
  remoteFrame: 'from the out-of-process frame',
  worker: 'from the dedicated worker',
  workerFetched: 'the worker fetched',
  frameFetched: 'the frame fetched',
  remoteFrameFetched: 'the other site fetched',
  serviceWorker: 'the service worker answered a navigation',
  workerPage: 'answered by the service worker',
  uncaught: 'thrown from the script',
  rejection: 'rejected with nobody to catch it',
  getterRan: 'the getter ran',
} as const

/** A query value in the page's addresses that is not a known secret, which no record may keep. */
export const OPAQUE_TOKEN = 'opaque-query-token-5309'

// Every request the page sends, and what the page logs when each settles, so a check knows each has finished.
const MAIN_SCRIPT = `
const words = ${JSON.stringify(DIAGNOSTICS_WORDS)}
console.log(words.log, 42, { saved: true, title: 'Release checklist' }, [1, 2, 3])
console.debug(words.debug)
console.info(words.info)
console.warn(words.warning)
console.error(words.error)
console.table([{ task: 'Release checklist' }])
console.count('diagnostic count')
console.assert(false, 'diagnostic assertion')
console.trace('diagnostic trace')
// A getter the console never calls: Retest reads only what Chrome previews.
console.dir({ get danger() { document.title = words.getterRan; return 1 } })
// The frames and the worker each say when their own fetch has finished, so the page knows they ran.
const heard = new Set()
const told = new Promise((resolve) => {
  const hear = (text) => {
    console.log(text)
    heard.add(text.split(' ').slice(0, 3).join(' '))
    if (heard.size === 3) resolve()
  }
  window.addEventListener('message', (event) => hear(String(event.data)))
  new Worker('/diagnostics/worker.js').addEventListener('message', (event) => hear(String(event.data)))
})
const requests = [
  fetch('/diagnostics/data?token=${OPAQUE_TOKEN}').then((response) => response.text()),
  fetch('/diagnostics/missing').then((response) => response.text()),
  fetch('/diagnostics/broken').then((response) => response.text()),
  fetch('/diagnostics/redirect/1').then((response) => response.text()),
  fetch(document.body.dataset.refused).catch(() => 'refused'),
]
fetch('/diagnostics/hang').catch(() => undefined)
const thrower = document.createElement('script')
thrower.src = '/diagnostics/thrower.js?token=${OPAQUE_TOKEN}'
document.body.append(thrower)
Promise.reject(new Error(words.rejection))
Promise.allSettled([...requests, told]).then(() => { document.querySelector('[data-testid="status"]').textContent = 'Done' })
`

/**
 * The main page: each console level and several other console types, a getter the console must not call, a frame of
 * its own origin and one of another site, a dedicated worker that logs and fetches, an uncaught error from a script
 * whose address holds a token, an unhandled rejection, a successful fetch, a 404, a 500, a redirect of two hops, a
 * fetch to a closed port and one that never finishes. `Done` shows once every fetch but the last has settled.
 */
export function renderDiagnosticsPage(refusedUrl: string, remoteFrameUrl: string): string {
  return htmlPage(
    'Diagnostics',
    `<p data-testid="status">Waiting</p>
<iframe title="Same origin" src="/diagnostics/frame"></iframe>
<iframe title="Other site" src="${escapeHtml(remoteFrameUrl)}"></iframe>`,
    MAIN_SCRIPT,
  ).replace('<body>', `<body data-refused="${escapeHtml(refusedUrl)}">`)
}

/** The frame of the page's own origin, which Chrome renders in the page's process. */
export const FRAME_PAGE: string = htmlPage(
  'Frame',
  '<p>Frame</p>',
  `console.log(${JSON.stringify(DIAGNOSTICS_WORDS.frame)}); fetch('/diagnostics/data?from=frame').then((response) => response.text().then(() => parent.postMessage(${JSON.stringify(DIAGNOSTICS_WORDS.frameFetched)} + ' ' + response.status, '*')))`,
)

/** The frame of another site, which Chrome renders in a process of its own. */
export const REMOTE_FRAME_PAGE: string = htmlPage(
  'Remote frame',
  '<p>Remote frame</p>',
  `console.log(${JSON.stringify(DIAGNOSTICS_WORDS.remoteFrame)}); fetch('/diagnostics/data?from=remote-frame').then((response) => response.text().then(() => parent.postMessage(${JSON.stringify(DIAGNOSTICS_WORDS.remoteFrameFetched)} + ' ' + response.status, '*')))`,
)

/** A dedicated worker that logs, fetches, and tells the page the status it got. */
export const WORKER_SCRIPT: string = `
console.log(${JSON.stringify(DIAGNOSTICS_WORDS.worker)})
fetch('/diagnostics/data?from=worker').then((response) => response.text().then(() => postMessage(${JSON.stringify(DIAGNOSTICS_WORDS.workerFetched)} + ' ' + response.status)))
`

/** A script that throws from a function of its own, so the error's stack names the script's address. */
export const THROWER_SCRIPT: string = `
function throwFromScript() { throw new Error(${JSON.stringify(DIAGNOSTICS_WORDS.uncaught)}) }
setTimeout(throwFromScript, 0)
`

/** A page with nothing to say: no console message and no request after its own document. */
export const QUIET_PAGE: string = htmlPage('Quiet', '<p data-testid="quiet">Quiet</p>')

/**
 * A page that logs `count` messages of `size` characters each and sends `fetches` requests, for the limits. Each
 * message begins with its number. With `throws`, an uncaught error follows the messages. `Done` shows once every
 * request has settled.
 */
export function renderFloodPage(count: number, size: number, fetches: number, throws: boolean): string {
  const script = `
for (let index = 0; index < ${count}; index += 1) console.log(String(index).padEnd(${size}, 'x'))
${throws ? "setTimeout(() => { throw new Error('after the flood') }, 0)" : ''}
const requests = Array.from({ length: ${fetches} }, (_, index) => fetch('/diagnostics/data?flood=' + index).then((response) => response.text()))
Promise.allSettled(requests).then(() => { document.querySelector('[data-testid="status"]').textContent = 'Done' })
`
  return htmlPage('Flood', '<p data-testid="status">Waiting</p>', script)
}

/**
 * A page that sends what is typed into it everywhere a page can leak it: a console message, an error, a query, a
 * path, an Authorization header, a cookie and the address of a script that throws. `Sent` shows once every request
 * has settled.
 */
export const SECRETS_PAGE: string = htmlPage(
  'Secrets',
  `<label>Secret <input data-testid="secret" type="password"></label>
<label>Token <input data-testid="token" type="password"></label>
<button data-testid="send" type="button">Send</button>
<p data-testid="status">Waiting</p>`,
  `
document.querySelector('[data-testid="send"]').addEventListener('click', () => {
  const value = document.querySelector('[data-testid="secret"]').value
  const token = document.querySelector('[data-testid="token"]').value
  const encoded = encodeURIComponent(value)
  document.cookie = 'session=' + encoded
  console.log('the secret is ' + value)
  // Places where Chrome itself cuts a long text before Retest sees it, or where a cut of Retest's own would fall.
  console.log({ token, note: 'x'.repeat(40) + value + 'y'.repeat(80), quoted: value })
  console.log(eval('(() => "' + 'z'.repeat(63) + token + '")'))
  console.error(new Error('failed with ' + value))
  const script = document.createElement('script')
  script.src = '/diagnostics/thrower.js?secret=' + encoded
  document.body.append(script)
  setTimeout(() => { throw new Error('uncaught with ' + value) }, 0)
  Promise.allSettled([
    fetch('/diagnostics/data?secret=' + encoded + '&token=${OPAQUE_TOKEN}', { headers: { authorization: 'Bearer ' + value, 'x-api-key': value } }),
    fetch('/diagnostics/echo/' + encoded),
  ]).then(() => { document.querySelector('[data-testid="status"]').textContent = 'Sent' })
})
`,
)

/** A page whose request never finishes, for a test the run stops while it waits. */
export const PENDING_PAGE: string = htmlPage('Pending', '<p data-testid="status">Waiting</p>', "console.log('waiting for the hanging request'); fetch('/diagnostics/hang')")

/** The markers a page can carry, each with a page and an endpoint of its own. */
export const MARKERS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'] as const

/**
 * A page that logs its own marker and fetches an address that holds it, so a check can tell its records from every
 * other test's. `Done` shows once the fetch has finished.
 */
export function renderMarkerPage(marker: string): string {
  const script = `console.log(${JSON.stringify(`marker ${marker}`)}); fetch('/diagnostics/marker/${marker}/data').then((response) => response.text()).then(() => { document.querySelector('[data-testid="status"]').textContent = 'Done' })`
  return htmlPage(`Marker ${marker}`, `<p data-testid="marker">${escapeHtml(marker)}</p><p data-testid="status">Waiting</p>`, script)
}

/** Registers the service worker for its own folder and says when it is ready. */
export const WORKER_SCOPE_REGISTER_PAGE: string = htmlPage(
  'Register',
  '<p data-testid="worker">Registering</p>',
  `navigator.serviceWorker.register('/diagnostics/worker-scope/sw.js').then(() => navigator.serviceWorker.ready).then(() => { document.querySelector('[data-testid="worker"]').textContent = 'Ready' })`,
)

/** What the server answers in the worker's folder when no worker answers first. */
export const WORKER_SCOPE_SERVER_PAGE: string = htmlPage('Not from the worker', '<p data-testid="answer">Answered by the server</p>')

/**
 * A service worker that answers each navigation in its folder with a page of its own, logging as it does, and passes
 * every other request of the page it controls on to the network.
 */
export const WORKER_SCOPE_SCRIPT: string = `
const page = '<!doctype html><title>Worker page</title><link rel="icon" href="data:,"><p data-testid="answer">' + ${JSON.stringify(DIAGNOSTICS_WORDS.workerPage)} + '</p>' +
  '<script>console.log(' + JSON.stringify(${JSON.stringify(DIAGNOSTICS_WORDS.workerPage)}) + "); fetch('/diagnostics/data?from=worker-page')</script>"
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') {
    console.log(${JSON.stringify(DIAGNOSTICS_WORDS.serviceWorker)})
    event.respondWith(new Response(page, { headers: { 'content-type': 'text/html' } }))
    return
  }
  event.respondWith(fetch(event.request))
})
`
