import type { Route } from './route.ts'
import { htmlPage } from './html.ts'
import { HTML_TYPE, respondWith } from './route.ts'

const TEXT_TYPE = 'text/plain; charset=utf-8'

// The opener reads the partner's origin from its own address, `/popups?partner=<origin>`, since the partner is a second
// task app on another port. It shows in its status line what came back from each page it opened.
const OPENER_SCRIPT = `
const byTestId = (testId) => document.querySelector('[data-testid="' + testId + '"]')
const show = (text) => { byTestId('status').textContent = text }
const partner = new URLSearchParams(location.search).get('partner') ?? location.origin
byTestId('help').addEventListener('click', () => window.open('/popups/help'))
byTestId('partner').addEventListener('click', () => window.open(partner + '/popups/partner', 'partner', 'width=480,height=640'))
byTestId('flash').addEventListener('click', () => {
  const opened = window.open('/popups/closing')
  const timer = setInterval(() => {
    if (!opened.closed) return
    clearInterval(timer)
    show('Popup closed')
  }, 20)
})
byTestId('dialogs').addEventListener('click', () => window.open('/dialogs'))
byTestId('size').addEventListener('click', () => window.open('/popups/size'))
byTestId('again').addEventListener('click', () => window.open('/popups'))
byTestId('alerting').addEventListener('click', () => window.open('/popups/alerting'))
addEventListener('message', (event) => {
  if (event.origin === partner && event.data && typeof event.data.signedIn === 'string') show('Signed in as ' + event.data.signedIn)
})
`

/**
 * A page that opens others: a link with a target, a button that opens a page of its own origin, a sign-in on the
 * partner's origin that answers back, a page that closes itself, the dialogs page, a page that shows its own size, this
 * page again, and a page that shows an alert when the test signals it.
 */
export const POPUPS_PAGE: string = htmlPage(
  'Popups',
  `<p><a href="/popups/terms" target="_blank" data-testid="terms">Terms</a></p>
<p>
<button type="button" data-testid="help">Open help</button>
<button type="button" data-testid="partner">Sign in with Partner</button>
<button type="button" data-testid="flash">Open and close</button>
<button type="button" data-testid="dialogs">Open dialogs</button>
<button type="button" data-testid="size">Open size</button>
<button type="button" data-testid="again">Open popups</button>
<button type="button" data-testid="alerting">Open alerting</button>
</p>
<p role="status" data-testid="status">Ready</p>`,
  OPENER_SCRIPT,
)

/** The terms a link opens in a new page: a form that shows what it saved. */
export const TERMS_PAGE: string = htmlPage(
  'Terms',
  `<p><label>Email <input data-testid="email" autocomplete="off"></label> <button type="button" data-testid="save">Save</button></p>
<p role="status" data-testid="saved"></p>`,
  `document.querySelector('[data-testid="save"]').addEventListener('click', () => {
  document.querySelector('[data-testid="saved"]').textContent = 'Saved ' + document.querySelector('[data-testid="email"]').value
})`,
)

/** A page of the opener's own origin. */
export const HELP_PAGE: string = htmlPage('Help', '<p data-testid="help-text">Ask us anything.</p>')

/** The partner's first page, which sends the popup on to its sign-in at once, as an OAuth popup does. */
export const PARTNER_PAGE: string = htmlPage('Partner', '<p>Redirecting</p>', `location.replace('/popups/partner/sign-in')`)

// The sign-in answers the page that opened it, then closes, a moment after the click, as a sign-in popup does.
const SIGN_IN_SCRIPT = `
document.querySelector('[data-testid="sign-in"]').addEventListener('click', () => {
  const email = document.querySelector('[data-testid="partner-email"]').value
  opener.postMessage({ signedIn: email }, '*')
  setTimeout(() => window.close(), 300)
})
`

/** The partner's sign-in, on its own origin. */
export const PARTNER_SIGN_IN_PAGE: string = htmlPage(
  'Sign in to Partner',
  `<p><label>Email <input data-testid="partner-email" autocomplete="off"></label></p>
<p><label>Password <input data-testid="partner-password" type="password" autocomplete="off"></label></p>
<p><button type="button" data-testid="sign-in">Sign in</button></p>`,
  SIGN_IN_SCRIPT,
)

/** A page that closes itself a moment after it loads. */
export const CLOSING_PAGE: string = htmlPage('Closing', '<p>Closing</p>', 'setTimeout(() => window.close(), 300)')

/** A page that shows the size of its viewport, as `innerWidth` by `innerHeight`. */
export const SIZE_PAGE: string = htmlPage('Size', '<p data-testid="size"></p>', `document.querySelector('[data-testid="size"]').textContent = innerWidth + 'x' + innerHeight`)

// The alerting page tells the server it is ready once it has read the signal count, then waits for the test's signal
// to the dialogs page's routes, shows its alert, and tells the server the alert was answered, as the later button does.
const ALERTING_SCRIPT = `
const signals = async () => Number(await (await fetch('/dialogs/signal')).text())
;(async () => {
  const before = await signals()
  await fetch('/popups/alerting/ready', { method: 'POST' })
  while (await signals() === before) await new Promise((resolve) => setTimeout(resolve, 20))
  alert('From the page it opened')
  await fetch('/dialogs/alerted', { method: 'POST' })
  document.querySelector('[data-testid="alerted"]').textContent = 'Alerted'
})()
`

/** A page that shows an alert once the test signals it. */
export const ALERTING_PAGE: string = htmlPage('Alerting', '<p data-testid="alerted">Waiting</p>', ALERTING_SCRIPT)

/**
 * The routes of the popups pages. Every task app serves them, so a second one is the partner's origin. A test reads
 * /popups/alerting/ready for how many alerting pages are waiting for its signal.
 */
export function popupRoutes(): Route[] {
  let alertingReady = 0
  return [
    ['GET /popups/size', (_request, response) => respondWith(response, 200, HTML_TYPE, SIZE_PAGE)],
    ['GET /popups/alerting', (_request, response) => respondWith(response, 200, HTML_TYPE, ALERTING_PAGE)],
    ['GET /popups/alerting/ready', (_request, response) => respondWith(response, 200, TEXT_TYPE, String(alertingReady))],
    [
      'POST /popups/alerting/ready',
      (_request, response) => {
        alertingReady += 1
        respondWith(response, 200, TEXT_TYPE, String(alertingReady))
      },
    ],
    ['GET /popups', (_request, response) => respondWith(response, 200, HTML_TYPE, POPUPS_PAGE)],
    ['GET /popups/terms', (_request, response) => respondWith(response, 200, HTML_TYPE, TERMS_PAGE)],
    ['GET /popups/help', (_request, response) => respondWith(response, 200, HTML_TYPE, HELP_PAGE)],
    ['GET /popups/partner', (_request, response) => respondWith(response, 200, HTML_TYPE, PARTNER_PAGE)],
    ['GET /popups/partner/sign-in', (_request, response) => respondWith(response, 200, HTML_TYPE, PARTNER_SIGN_IN_PAGE)],
    ['GET /popups/closing', (_request, response) => respondWith(response, 200, HTML_TYPE, CLOSING_PAGE)],
  ]
}
