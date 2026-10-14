import type { Route } from './route.ts'
import { text } from 'node:stream/consumers'
import { escapeHtml, htmlPage } from './html.ts'
import { HTML_TYPE, JSON_TYPE, queryOf, respondWith } from './route.ts'

// A checkout whose parts live in frames: an order form in a frame of the same origin, with a notes frame inside it; a
// payment form in a frame of another site, which Chrome runs in a process of its own, whose form posts to its server
// and answers with what arrived, and whose button opens a file picker; a receipt frame a button removes and adds again;
// a copy of the receipt inside an element that is hidden; a frame drawn at half its size; a frame of steps whose next
// step is slow to arrive; a help frame inside an open shadow root; and an element that is not a frame. Each frame's
// status lines say what its controls received, and the order form's save goes to the server, which answers with what it
// was sent. A trap in the order form shows the page's cover over the frame as the mouse arrives. The order form is
// painted magenta and the payment form cyan, so a screenshot shows which of them it holds.

const ORDER_SCRIPT = `
const byTestId = (testId) => document.querySelector('[data-testid="' + testId + '"]')
const show = (testId, words) => { byTestId(testId).textContent = words }
byTestId('save').addEventListener('click', async () => {
  const order = { name: byTestId('name').value, express: byTestId('express').checked, size: byTestId('size').value }
  const response = await fetch('/frames/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(order) })
  show('order-status', (await response.json()).received)
})
byTestId('hover').addEventListener('mouseenter', () => show('hover-status', 'Hovered'))
byTestId('list').addEventListener('wheel', () => show('scroll-status', 'Scrolled'))
byTestId('list').addEventListener('scroll', () => show('list-top', String(Math.round(byTestId('list').scrollTop))))
byTestId('name').addEventListener('keydown', (event) => { if (event.key === 'Enter') show('key-status', 'Enter pressed') })
byTestId('trap').addEventListener('pointerover', () => { parent.document.querySelector('[data-testid="cover"]').hidden = false })
byTestId('trap').addEventListener('click', () => show('order-status', 'Trap pressed'))
`

/** The order form, in a frame of the page's own origin, with a notes frame inside it. */
export const ORDER_FRAME_PAGE: string = htmlPage(
  'Order',
  `<style>body { background: rgb(255, 0, 255) }</style>
<p><label>Name <input data-testid="name" autocomplete="off"></label></p>
<p><label><input type="checkbox" data-testid="express"> Express</label></p>
<p><label>Size <select data-testid="size"><option>Small</option><option>Medium</option><option>Large</option></select></label></p>
<p><button type="button" data-testid="save">Save order</button> <button type="button" data-testid="hover">Hover me</button> <button type="button" data-testid="trap">Trap</button></p>
<div data-testid="list" style="height: 40px; overflow: auto; border: 1px solid"><div style="height: 400px">Long list</div></div>
<p data-testid="clipped" style="width: 120px; overflow: hidden; white-space: nowrap">This label is far too long to fit its box</p>
<p data-testid="order-status">Order ready</p>
<p data-testid="hover-status">Not hovered</p>
<p data-testid="scroll-status">Not scrolled</p>
<p data-testid="list-top">0</p>
<p data-testid="key-status">No key</p>
<iframe title="Notes" src="/frames/notes" style="width: 360px; height: 140px"></iframe>`,
  ORDER_SCRIPT,
)

const NOTES_SCRIPT = `
document.querySelector('[data-testid="add-note"]').addEventListener('click', () => {
  document.querySelector('[data-testid="note-status"]').textContent = 'Note: ' + document.querySelector('[data-testid="note"]').value
})
`

/** A notes form, in a frame inside the order form's frame. */
export const NOTES_FRAME_PAGE: string = htmlPage(
  'Notes',
  `<textarea aria-label="Note" data-testid="note"></textarea> <button type="button" data-testid="add-note">Add note</button>
<p data-testid="note-status">No notes</p>`,
  NOTES_SCRIPT,
)

const PAYMENT_SCRIPT = `
const byTestId = (testId) => document.querySelector('[data-testid="' + testId + '"]')
byTestId('attach').addEventListener('click', () => byTestId('receipt-file').click())
byTestId('receipt-file').addEventListener('change', (event) => { byTestId('attach-status').textContent = 'Attached ' + [...event.target.files].map((file) => file.name).join(', ') })
byTestId('receipt-file').addEventListener('cancel', () => { byTestId('attach-status').textContent = 'Picker closed' })
byTestId('hint').addEventListener('mouseenter', () => { byTestId('hint-status').textContent = 'Hint shown' })
byTestId('terms-text').addEventListener('wheel', () => { byTestId('terms-status').textContent = 'Terms read' })
byTestId('card').addEventListener('keydown', (event) => { if (event.key === 'Tab') byTestId('press-status').textContent = 'Tab pressed' })
`

/** A payment form, served by another site, whose form posts to its own server. */
export const PAYMENT_FRAME_PAGE: string = htmlPage(
  'Payment',
  `<style>body { background: rgb(0, 255, 255) }</style>
<form method="post" action="/frames/pay">
<p><label>Card number <input name="card" data-testid="card" autocomplete="off"></label></p>
<p><label>Plan <select name="plan"><option>Monthly</option><option>Yearly</option></select></label></p>
<p><label><input type="checkbox" name="terms" value="yes"> I agree to the terms</label></p>
<p><button type="button" data-testid="hint">Show hint</button> <span data-testid="hint-status">Hint hidden</span></p>
<div data-testid="terms-text" style="height: 40px; overflow: auto; border: 1px solid"><div style="height: 300px">Terms</div></div>
<p data-testid="terms-status">Terms unread</p>
<p data-testid="press-status">No key</p>
<p><input type="file" data-testid="receipt-file" hidden> <button type="button" data-testid="attach">Attach a receipt</button> <span data-testid="attach-status">No receipt</span></p>
<p><button>Pay</button></p>
</form>`,
  PAYMENT_SCRIPT,
)

/** The page a payment's post answers with: what the server received. */
export function renderPaidPage(form: URLSearchParams): string {
  const card = form.get('card') ?? ''
  const received = `Paid with card ending ${card.replace(/\s+/g, '').slice(-4)} on the ${form.get('plan') ?? 'no'} plan, terms ${form.get('terms') ?? 'no'}`
  return htmlPage('Paid', `<p>Thank you</p><p data-testid="paid">${escapeHtml(received)}</p>`)
}

const RECEIPT_SCRIPT = `
const byTestId = (testId) => document.querySelector('[data-testid="' + testId + '"]')
byTestId('copy').addEventListener('click', () => byTestId('copy-file').click())
byTestId('copy-file').addEventListener('change', (event) => { byTestId('copy-status').textContent = 'Attached ' + [...event.target.files].map((file) => file.name).join(', ') })
byTestId('copy-file').addEventListener('cancel', () => { byTestId('copy-status').textContent = 'Picker closed' })
`

/** A receipt, in a frame a button on the page removes and adds again, whose button opens a file picker. */
export const RECEIPT_FRAME_PAGE: string = htmlPage(
  'Receipt',
  `<p data-testid="receipt">Receipt 1001</p>
<p><input type="file" data-testid="copy-file" hidden> <button type="button" data-testid="copy">Attach a copy</button> <span data-testid="copy-status">No copy</span></p>`,
  RECEIPT_SCRIPT,
)

const SCALED_SCRIPT = `
for (const side of ['left', 'right']) {
  document.querySelector('[data-testid="' + side + '"]').addEventListener('click', () => {
    document.querySelector('[data-testid="side-status"]').textContent = side + ' pressed'
  })
}
`

/** Two buttons side by side, in a frame the page draws at half its size. */
export const SCALED_FRAME_PAGE: string = htmlPage(
  'Sides',
  `<button type="button" data-testid="left" style="position: absolute; left: 0; top: 0; width: 280px; height: 100px">Left</button>
<button type="button" data-testid="right" style="position: absolute; left: 300px; top: 0; width: 280px; height: 100px">Right</button>
<p data-testid="side-status" style="position: absolute; left: 0; top: 100px">Nothing pressed</p>`,
  SCALED_SCRIPT,
)

/** One step of several, whose next step the server answers only after `STEP_DELAY_MS`. */
export function renderStepPage(step: number): string {
  const script = `
document.querySelector('[data-testid="next"]').addEventListener('click', () => { location.href = '/frames/step?n=${step + 1}' })
document.querySelector('[data-testid="done"]').addEventListener('click', () => {
  document.querySelector('[data-testid="step-status"]').textContent = 'Done on step ${step}'
})
`
  return htmlPage(
    `Step ${step}`,
    `<button type="button" data-testid="next">Next</button> <button type="button" data-testid="done">Done</button> <p data-testid="step-status">Step ${step}</p>`,
    script,
  )
}

/** How long the server takes to answer any step after the first. */
export const STEP_DELAY_MS = 1500

const HELP_SCRIPT = `
document.querySelector('[data-testid="ask"]').addEventListener('click', () => {
  document.querySelector('[data-testid="help-status"]').textContent = 'Question sent'
})
`

/** A help form, in a frame inside an open shadow root of the page. */
export const HELP_FRAME_PAGE: string = htmlPage('Help', `<button type="button" data-testid="ask">Ask</button> <p data-testid="help-status">No question</p>`, HELP_SCRIPT)

const CHECKOUT_SCRIPT = `
const byTestId = (testId) => document.querySelector('[data-testid="' + testId + '"]')
byTestId('cover-toggle').addEventListener('click', () => { byTestId('cover').hidden = !byTestId('cover').hidden })
byTestId('cover').addEventListener('click', () => { byTestId('top-status').textContent = 'Cover pressed' })
byTestId('receipt-toggle').addEventListener('click', () => {
  const slot = byTestId('receipt-slot')
  if (slot.firstElementChild === null) {
    const frame = document.createElement('iframe')
    frame.title = 'Receipt'
    frame.src = '/frames/receipt'
    slot.append(frame)
    byTestId('receipt-toggle').textContent = 'Remove receipt'
  } else {
    slot.firstElementChild.remove()
    byTestId('receipt-toggle').textContent = 'Add receipt'
  }
})
customElements.define('help-panel', class extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot !== null) return
    this.attachShadow({ mode: 'open' }).innerHTML = '<iframe title="Help" src="/frames/help" style="width: 360px; height: 120px"></iframe>'
  }
})
`

/**
 * The checkout: the order frame, the payment frame of `payment`, an origin of another site, below the fold, the receipt
 * frame, the help panel, the hidden, scaled and steps frames, and an element that is not a frame. A cover hides the
 * order frame when toggled, and says when it is pressed.
 */
export function renderFramesPage(payment: string): string {
  return htmlPage(
    'Checkout with frames',
    `<p><button type="button" data-testid="cover-toggle">Cover the order</button> <button type="button" data-testid="receipt-toggle">Remove receipt</button></p>
<div style="position: relative">
<iframe title="Order form" data-testid="order-frame" src="/frames/order" style="width: 480px; height: 400px; border: 4px solid; padding: 6px"></iframe>
<div data-testid="cover" hidden style="position: absolute; inset: 0; background: white">Covered</div>
</div>
<div data-testid="receipt-slot"><iframe title="Receipt" src="/frames/receipt" style="width: 300px; height: 80px"></iframe></div>
<help-panel></help-panel>
<div style="visibility: hidden"><iframe title="Hidden receipt" data-testid="hidden-frame" src="/frames/receipt" style="width: 300px; height: 80px"></iframe></div>
<div style="transform: scale(0.5); transform-origin: 0 0; width: 300px; height: 60px"><iframe title="Sides" data-testid="scaled-frame" src="/frames/scaled" style="width: 600px; height: 120px; border: 0"></iframe></div>
<iframe title="Steps" data-testid="steps-frame" src="/frames/step?n=1" style="width: 300px; height: 80px"></iframe>
<div data-testid="not-a-frame">Not a frame</div>
<p data-testid="top-status">Top ready</p>
<div style="height: 400px"></div>
<iframe title="Secure payment" data-testid="payment-frame" src="${escapeHtml(payment)}/frames/payment" style="width: 480px; height: 420px; border: 2px solid"></iframe>`,
    CHECKOUT_SCRIPT,
  )
}

// The payment frame's origin, from the page's address, or this server's own when none is given.
function paymentOrigin(given: string | null): string {
  const url = given === null ? null : URL.parse(given)
  return url !== null && (url.protocol === 'http:' || url.protocol === 'https:') ? url.origin : ''
}

/** The routes of the frames pages. The order form's save answers with what it received. */
export function framesRoutes(): Route[] {
  return [
    ['GET /frames', (request, response) => respondWith(response, 200, HTML_TYPE, renderFramesPage(paymentOrigin(queryOf(request).get('payment'))))],
    ['GET /frames/order', (_request, response) => respondWith(response, 200, HTML_TYPE, ORDER_FRAME_PAGE)],
    [
      'POST /frames/orders',
      (request, response) => {
        text(request)
          .then((body) => {
            const order: unknown = JSON.parse(body)
            const fields = typeof order === 'object' && order !== null ? order : {}
            const read = (key: string): string => String(key in fields ? Reflect.get(fields, key) : '')
            const received = `Saved ${read('size')} order for ${read('name')}, express ${read('express')}`
            respondWith(response, 200, JSON_TYPE, JSON.stringify({ received }))
          })
          .catch(() => response.destroy())
      },
    ],
    ['GET /frames/notes', (_request, response) => respondWith(response, 200, HTML_TYPE, NOTES_FRAME_PAGE)],
    ['GET /frames/payment', (_request, response) => respondWith(response, 200, HTML_TYPE, PAYMENT_FRAME_PAGE)],
    [
      'POST /frames/pay',
      (request, response) => {
        text(request)
          .then((body) => respondWith(response, 200, HTML_TYPE, renderPaidPage(new URLSearchParams(body))))
          .catch(() => response.destroy())
      },
    ],
    ['GET /frames/receipt', (_request, response) => respondWith(response, 200, HTML_TYPE, RECEIPT_FRAME_PAGE)],
    ['GET /frames/scaled', (_request, response) => respondWith(response, 200, HTML_TYPE, SCALED_FRAME_PAGE)],
    [
      'GET /frames/step',
      (request, response) => {
        const step = Math.max(1, Number.parseInt(queryOf(request).get('n') ?? '1', 10) || 1)
        const answer = () => respondWith(response, 200, HTML_TYPE, renderStepPage(step))
        if (step === 1) answer()
        else setTimeout(answer, STEP_DELAY_MS)
      },
    ],
    ['GET /frames/help', (_request, response) => respondWith(response, 200, HTML_TYPE, HELP_FRAME_PAGE)],
  ]
}
