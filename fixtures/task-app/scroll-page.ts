import { htmlPage } from './html.ts'

/** Where the scroll page asks for more items. The server counts the asks. */
export const MORE_PATH = '/actions/more'

// The terms show how far they are scrolled, and enable Accept once they are scrolled to their end. The feed asks
// the server for ten more items when the page is scrolled near its end, once at a time. Every wheel event the page
// hears is listed, from the earliest listener a page can have, so a test can tell the page heard none.
const SCRIPT = `
const show = (testId, value) => { document.querySelector('[data-testid="' + testId + '"]').textContent = value }
const byTestId = (testId) => document.querySelector('[data-testid="' + testId + '"]')
const terms = byTestId('terms')
const accept = byTestId('accept')
terms.addEventListener('scroll', () => {
  show('terms-scrolled', String(Math.round(terms.scrollTop)))
  if (terms.scrollTop + terms.clientHeight < terms.scrollHeight - 2) return
  accept.disabled = false
  show('accept-state', 'enabled')
})
const feed = byTestId('feed')
let loading = false
const count = () => show('items-count', String(feed.children.length))
addEventListener('scroll', () => {
  if (loading || scrollY + innerHeight < document.documentElement.scrollHeight - 200) return
  loading = true
  fetch('${MORE_PATH}', { method: 'POST' }).then(() => {
    const start = feed.children.length
    for (let index = 1; index <= 10; index += 1) {
      const item = document.createElement('li')
      item.textContent = 'Item ' + (start + index)
      feed.append(item)
    }
    count()
    loading = false
  })
})
count()
const wheels = []
addEventListener('wheel', (event) => {
  wheels.push(event.target.closest('[data-testid]')?.dataset.testid ?? event.target.localName)
  show('wheels-heard', wheels.join(' '))
}, { capture: true, passive: true })
`

const paragraphs = Array.from({ length: 12 }, (_, index) => `<p>Term ${index + 1}. The service is provided as it is.</p>`).join('\n')
const items = Array.from({ length: 20 }, (_, index) => `<li>Item ${index + 1}</li>`).join('\n')

/**
 * A box of terms whose Accept button is enabled once they are scrolled to their end, and a list a cover sits on, in a
 * narrow row at the top, then a feed that loads ten more items when the page is scrolled near its end. The boxes stay
 * clear of the centre of the viewport, where the page is scrolled, and above the feed, which never moves them.
 */
export const SCROLL_PAGE: string = htmlPage(
  'Scroll',
  `<style>
.boxes { display: flex; gap: 16px; align-items: flex-start }
.boxes > div { width: 150px }
[data-testid="terms"], [data-testid="covered-list"] { height: 120px; overflow: auto; border: 1px solid }
[data-testid="feed"] li { height: 60px }
.covered { position: relative }
.cover { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.1) }
</style>
<div class="boxes">
<div><div data-testid="terms">${paragraphs}</div><button type="button" data-testid="accept" disabled>Accept</button></div>
<div class="covered"><div data-testid="covered-list">${paragraphs}</div><div class="cover" data-testid="list-cover"></div></div>
</div>
<p>Accept is <span data-testid="accept-state">disabled</span>. The terms are scrolled by <span data-testid="terms-scrolled">0</span> pixels.</p>
<p>Items: <span data-testid="items-count"></span>. Wheels heard: <span data-testid="wheels-heard"></span></p>
<ol data-testid="feed">
${items}
</ol>`,
  SCRIPT,
)
