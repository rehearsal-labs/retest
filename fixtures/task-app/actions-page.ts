import { escapeHtml } from './html.ts'

// Shows which field has the focus and every key down the page heard, from the earliest listener a page can
// have. The server counts presses of the button, and the page shows how many it answered, so a test can tell a
// key was delivered once, and when the page never heard one.
const SCRIPT = `
const show = (testId, value) => { document.querySelector('[data-testid="' + testId + '"]').textContent = value }
const heard = []
addEventListener('keydown', (event) => {
  heard.push(event.key + (event.shiftKey ? ':shift' : ''))
  show('keys-heard', heard.join(' '))
}, true)
document.addEventListener('focusin', (event) => show('focus', event.target.dataset.testid ?? event.target.localName))
let answered = 0
document.querySelector('[data-testid="count"]').addEventListener('click', () => {
  fetch('/actions/click', { method: 'POST' }).then(() => show('clicks-answered', String((answered += 1))))
})
`

/** A form to submit with Enter, two fields to move between, and a button whose presses the server counts. */
export const ACTIONS_PAGE: string = page(
  'Actions',
  `<form method="post" action="/actions/submit">
<label for="query">Search</label>
<input id="query" name="query" data-testid="query" autocomplete="off">
<button data-testid="search">Search</button>
</form>
<label for="first">First</label>
<input id="first" data-testid="first" autocomplete="off">
<label for="second">Second</label>
<input id="second" data-testid="second" autocomplete="off">
<button type="button" data-testid="count">Count</button>
<p>Focus: <span data-testid="focus"></span></p>
<p>Keys heard: <span data-testid="keys-heard"></span></p>
<p>Clicks answered: <span data-testid="clicks-answered">0</span></p>
<script>${SCRIPT}</script>`,
)

/** The page a submitted search answers with. */
export function renderSubmittedPage(query: string): string {
  return page('Submitted', `<p data-testid="submitted">Searched for ${escapeHtml(query)}</p>`)
}

function page(title: string, main: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<link rel="icon" href="data:,">
</head>
<body>
<main>
<h1>${title}</h1>
${main}
</main>
</body>
</html>
`
}
