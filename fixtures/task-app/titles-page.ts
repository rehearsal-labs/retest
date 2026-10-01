import { escapeHtml, htmlPage } from './html.ts'

// A link, a form Enter submits, a button that moves to a new path within the document and names it, and a button
// that sets the title after a moment, which is no navigation.
const START_SCRIPT = `
const byTestId = (testId) => document.querySelector('[data-testid="' + testId + '"]')
byTestId('push').addEventListener('click', () => {
  document.title = 'Pushed'
  history.pushState({}, '', '/titles/pushed')
})
byTestId('retitle').addEventListener('click', () => setTimeout(() => { document.title = 'Retitled' }, 100))
`

/** A page of each way to leave it: a link, a form, a new path within the document, and a title set later. */
export const TITLES_PAGE: string = htmlPage(
  'Titles',
  `<p><a href="/titles/next" data-testid="next">Next</a></p>
<form action="/titles/next" method="get"><label for="query">Search</label> <input id="query" name="q" data-testid="query" autocomplete="off"></form>
<p><button type="button" data-testid="push">Push</button> <button type="button" data-testid="retitle">Retitle</button></p>`,
  START_SCRIPT,
)

/** Where every way out of the titles page leads. */
export const NEXT_TITLE_PAGE: string = htmlPage('Next', '<p data-testid="arrived">Arrived</p>')

/** A page that sends the browser to the next page on its own, a moment after it loads. */
export const REDIRECTING_PAGE: string = htmlPage(
  'Redirecting',
  '<p>Redirecting</p>',
  `addEventListener('load', () => setTimeout(() => { location.href = '/titles/next' }, 100))`,
)

/** A form that sends the name typed into it to the echo page, which makes it that page's title. */
export const GREETING_PAGE: string = htmlPage(
  'Greeting',
  '<form action="/titles/echo" method="get"><label for="name">Name</label> <input id="name" name="title" autocomplete="off"></form>',
)

/**
 * A page whose title is `title`, escaped as HTML text, so that control characters and whatever a test asks for
 * reach `document.title` as written.
 */
export function renderTitledPage(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="data:,">
</head>
<body>
<p data-testid="titled">Titled</p>
</body>
</html>
`
}
