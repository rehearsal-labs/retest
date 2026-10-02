import type { TestContext } from 'node:test'
import type { OwnedPage, PageReading, TextQuery } from '../../src/browser/contract.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BrowserError } from '../../src/browser/browser-error.ts'
import { assertOk, click, goto, observe, openPage, servePages, sharedBrowser, type ServeOptions } from './browser-harness.ts'

const browser = sharedBrowser()

async function sitePage(t: TestContext, pages: Record<string, string>, options?: ServeOptions): Promise<{ url: string; page: OwnedPage }> {
  const site = await servePages(t, pages, options)
  const page = await openPage(t, browser(), site.url)
  assertOk(await goto(page, '/'))
  return { url: site.url, page }
}

function query(text: string, ignoreCase = false): TextQuery {
  return { text, ignoreCase }
}

/** Reads the page until `until` holds, as a host check looks again, or fails when the time runs out. */
async function readUntil(page: OwnedPage, queries: readonly TextQuery[], until: (reading: PageReading) => boolean): Promise<PageReading> {
  const end = performance.now() + 5000
  for (;;) {
    const reading = await page.readPage(queries, 1000)
    if (until(reading)) return reading
    if (performance.now() > end) assert.fail(`the page still reads ${JSON.stringify(reading)}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('the visible text of the top-level document is read as a person reads it, whitespace normalised, and only the answers leave the page', async (t) => {
  const { url, page } = await sitePage(t, {
    '/': `<!doctype html><body>
      <p>Your   order
      is placed.</p>
      <p style="display: none">display none</p><p style="visibility: hidden">visibility hidden</p><p hidden>hidden attribute</p>
      <iframe srcdoc="<p>inside a frame</p>"></iframe>
      <div id="host"></div><div id="slotted"><span>light child</span></div>
      <script>
        document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<p>inside a shadow root</p>'
        document.getElementById('slotted').attachShadow({ mode: 'open' }).innerHTML = '<b>around the slot</b><slot></slot>'
      </script></body>`,
  })
  const queries = [
    query('Your order is placed.'),
    query('  order\tis  '),
    query('YOUR ORDER', true),
    query('YOUR ORDER'),
    query('display none'),
    query('visibility hidden'),
    query('hidden attribute'),
    query('inside a frame'),
    query('inside a shadow root'),
    query('around the slot'),
    query('light child'),
  ]
  assert.deepEqual(await page.readPage(queries, 2000), {
    url: `${url}/`,
    navigating: false,
    found: [true, true, true, false, false, false, false, false, false, false, true],
  })
})

test('the address is the main frame origin and path as of its latest commit, without its query or fragment', async (t) => {
  const moving = `<!doctype html><button data-testid="move" onclick="history.pushState(null, '', '/moved?token=1#top')">Move</button>`
  const { url, page } = await sitePage(t, { '/': moving, '/?code=1234': moving })
  assertOk(await goto(page, '/?code=1234#part'))
  assert.equal((await page.readPage([], 1000)).url, `${url}/`)
  assertOk(await click(page, 'move'))
  await readUntil(page, [], (reading) => reading.url === `${url}/moved`)
})

test('a document about to be replaced is not read: the reading says the page is opening another, then reads the one that arrives', async (t) => {
  const release = Promise.withResolvers<void>()
  const elsewhere = await servePages(t, { '/': '<!doctype html><p>Arrived</p>' }, { hold: () => release.promise })
  const { url, page } = await sitePage(t, {
    '/': `<!doctype html><p>Leaving</p><script>addEventListener('load', () => { location.href = ${JSON.stringify(`${elsewhere.url}/`)} })</script>`,
  })
  const queries = [query('Leaving'), query('Arrived')]
  const pending = await readUntil(page, queries, (reading) => reading.navigating)
  assert.deepEqual(pending, { url: `${url}/`, navigating: true, found: [] })
  release.resolve()
  const arrived = await readUntil(page, queries, (reading) => !reading.navigating && reading.url === `${elsewhere.url}/`)
  assert.deepEqual(arrived.found, [false, true])
})

test('reading sends no input, and moves nothing', async (t) => {
  const { page } = await sitePage(t, {
    '/': `<!doctype html><input data-testid="field"><p data-testid="heard"></p><script>
      const heard = []
      for (const type of ['keydown', 'pointerdown', 'mousedown', 'click', 'focusin', 'input']) {
        addEventListener(type, () => { heard.push(type); document.querySelector('[data-testid="heard"]').textContent = heard.join(' ') }, true)
      }
    </script>`,
  })
  assert.deepEqual((await page.readPage([query('anything')], 1000)).found, [false])
  assert.equal((await observe(page, 'heard')).text, '')
})

test('a page a dialog holds cannot be read, and the error says why', async (t) => {
  const { page } = await sitePage(t, {
    '/': `<!doctype html><button data-testid="warn" onclick="alert('Careful')">Warn</button>`,
  })
  await click(page, 'warn', 2000)
  await assert.rejects(
    page.readPage([query('Warn')], 1000),
    (error) => error instanceof BrowserError && error.failure.class === 'unsupported' && /read the page/.test(error.failure.message),
  )
})

// Only Retest's own function reads the page. A document with no body, such as an XML or SVG one, has no visible
// text, and the reading says so rather than reading as empty text.
test('a document with no body says so, and finds nothing', async (t) => {
  const { url, page } = await sitePage(t, {
    '/': '<!doctype html><title>Feed</title><body><p>Release checklist</p><script>document.body.remove()</script></body>',
  })
  assert.deepEqual(await page.readPage([query('Release checklist'), query('anything', true)], 2000), {
    url: `${url}/`,
    title: 'Feed',
    navigating: false,
    found: [false, false],
    body: false,
  })
})
