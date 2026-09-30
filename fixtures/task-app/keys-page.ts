import { htmlPage } from './html.ts'

/** Where a key down in the keys page's frozen field is counted. */
export const KEY_DOWN_PATH = '/keys/down'

// Every part of every keystroke the page hears, from the earliest listener a page can have, and where the focus is.
// The note field hands the focus to a notice as soon as it gets it, as a dialog that opens on focus would. A key down
// in the frozen field reaches the server, and then the page never answers again, so the key cannot be confirmed.
const SCRIPT = `
const show = (testId, value) => { document.querySelector('[data-testid="' + testId + '"]').textContent = value }
const heard = []
for (const type of ['keydown', 'keypress', 'keyup']) {
  addEventListener(type, (event) => {
    heard.push(type + ' ' + event.key)
    show('keys-heard', heard.join(', '))
  }, true)
}
document.addEventListener('focusin', (event) => show('focus', event.target.dataset.testid ?? event.target.localName))
document.querySelector('[data-testid="note"]').addEventListener('focus', () => {
  queueMicrotask(() => document.querySelector('[data-testid="notice"]').focus())
})
document.querySelector('[data-testid="frozen"]').addEventListener('keydown', () => {
  const request = new XMLHttpRequest()
  request.open('POST', '${KEY_DOWN_PATH}', false)
  request.send()
  for (;;) {}
})
`

/** A field whose focus a notice takes, a field that freezes the page on a key down, and every key the page heard. */
export const KEYS_PAGE: string = htmlPage(
  'Keys',
  `<label for="note">Note</label>
<input id="note" data-testid="note" autocomplete="off">
<div data-testid="notice" role="dialog" aria-label="Notice" tabindex="-1">Read this first.</div>
<label for="frozen">Frozen</label>
<input id="frozen" data-testid="frozen" autocomplete="off">
<p>Focus: <span data-testid="focus"></span></p>
<p>Keys heard: <span data-testid="keys-heard"></span></p>`,
  SCRIPT,
)
