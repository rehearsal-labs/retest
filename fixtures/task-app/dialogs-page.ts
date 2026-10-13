import type { Route } from './route.ts'
import { htmlPage } from './html.ts'
import { HTML_TYPE, respondWith } from './route.ts'

const TEXT_TYPE = 'text/plain; charset=utf-8'

// Each button opens a dialog and shows what came of it in the status line, so a test reads the page, not the dialog.
// The later button waits for a signal the test sends, then alerts and says so, so a test opens a dialog while nothing
// runs and knows when it was answered without a timer racing its own commands. The guard checkbox sets a beforeunload
// handler, which asks before the page leaves. The echo button repeats the field's value in an alert, which is how a
// page can show a secret it was given.
const DIALOGS_SCRIPT = `
const byTestId = (testId) => document.querySelector('[data-testid="' + testId + '"]')
const show = (text) => { byTestId('status').textContent = text }
byTestId('alert').addEventListener('click', () => { alert('Saved the task'); show('Alerted') })
byTestId('confirm').addEventListener('click', () => show(confirm('Delete this task?') ? 'Deleted' : 'Kept'))
byTestId('prompt').addEventListener('click', () => {
  const answer = prompt('New name?', 'Release checklist')
  show(answer === null ? 'No answer' : 'Renamed to ' + answer)
})
byTestId('two').addEventListener('click', () => {
  alert('First of two')
  show(confirm('Second of two?') ? 'Second accepted' : 'Second dismissed')
})
const signals = async () => Number(await (await fetch('/dialogs/signal')).text())
byTestId('later').addEventListener('click', async () => {
  const before = await signals()
  show('Waiting for the signal')
  while (await signals() === before) await new Promise((resolve) => setTimeout(resolve, 20))
  alert('Later')
  await fetch('/dialogs/alerted', { method: 'POST' })
  show('After the alert')
})
byTestId('echo').addEventListener('click', () => alert('You typed ' + byTestId('secret').value))
const leaving = (event) => { event.preventDefault(); event.returnValue = '' }
byTestId('guard').addEventListener('change', (event) => {
  if (event.target.checked) addEventListener('beforeunload', leaving)
  else removeEventListener('beforeunload', leaving)
})
`

/**
 * A page of dialogs: an alert, a confirm, a prompt, two in a row, one a signal opens, an echo and a guard on leaving, and
 * a button that is never enabled, for a command that fails of its own accord while a dialog opens.
 */
export const DIALOGS_PAGE: string = htmlPage(
  'Dialogs',
  `<p>
<button type="button" data-testid="alert">Save</button>
<button type="button" data-testid="confirm">Delete</button>
<button type="button" data-testid="prompt">Rename</button>
<button type="button" data-testid="two">Two dialogs</button>
<button type="button" data-testid="later">Later</button>
<button type="button" data-testid="never" disabled>Never</button>
</p>
<p><label>Secret <input data-testid="secret" type="password" autocomplete="off"></label> <button type="button" data-testid="echo">Echo</button></p>
<p><label><input type="checkbox" data-testid="guard"> Warn before leaving</label></p>
<p role="status" data-testid="status">Ready</p>`,
  DIALOGS_SCRIPT,
)

/** Where a test goes to leave the dialogs page. */
export const DIALOGS_NEXT_PAGE: string = htmlPage('Next', '<p data-testid="arrived">Arrived</p>')

/**
 * The routes of the dialogs pages. A test posts to /dialogs/signal to have the later button's alert open, and reads
 * /dialogs/alerted for how many of those alerts were answered; each count is the server's own.
 */
export function dialogRoutes(): Route[] {
  let signals = 0
  let alerted = 0
  return [
    ['GET /dialogs', (_request, response) => respondWith(response, 200, HTML_TYPE, DIALOGS_PAGE)],
    ['GET /dialogs/next', (_request, response) => respondWith(response, 200, HTML_TYPE, DIALOGS_NEXT_PAGE)],
    ['GET /dialogs/signal', (_request, response) => respondWith(response, 200, TEXT_TYPE, String(signals))],
    [
      'POST /dialogs/signal',
      (_request, response) => {
        signals += 1
        respondWith(response, 200, TEXT_TYPE, String(signals))
      },
    ],
    ['GET /dialogs/alerted', (_request, response) => respondWith(response, 200, TEXT_TYPE, String(alerted))],
    [
      'POST /dialogs/alerted',
      (_request, response) => {
        alerted += 1
        respondWith(response, 200, TEXT_TYPE, String(alerted))
      },
    ],
  ]
}
