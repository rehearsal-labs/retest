import type { Route } from './route.ts'
import { htmlPage } from './html.ts'
import { HTML_TYPE, respondWith } from './route.ts'

// A checkout built from custom elements, each with an open shadow root, so every finder has something to look through:
// a panel whose root holds a heading, a field with a <label for>, a button with an aria-label, a button an element of
// the same root covers, a checkbox, a select and a status line; a card field two roots deep; a list whose items repeat in roots of their own beside items in the
// document; a card that shows the page's own children through slots; two buttons of a design system, whose roots hold
// a <button> that shows the host's own text or element through a slot; and a box with a closed root, which nothing
// outside it may see into. The status lines say what each control last received, so a test reads the page.
const SHADOW_SCRIPT = `
const status = (root, text) => { root.querySelector('[data-testid="status"]').textContent = text }
customElements.define('card-field', class extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot !== null) return
    this.attachShadow({ mode: 'open' }).innerHTML = '<input aria-label="Card number" data-testid="card" autocomplete="off">'
  }
})
customElements.define('checkout-panel', class extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot !== null) return
    const root = this.attachShadow({ mode: 'open' })
    root.innerHTML = \`
      <h2>Checkout</h2>
      <p><label for="coupon">Coupon</label> <input id="coupon" data-testid="coupon" placeholder="Coupon code" autocomplete="off"></p>
      <p><card-field></card-field></p>
      <p><input aria-labelledby="outside-name" data-testid="unnamed" autocomplete="off"></p>
      <p><label><input type="checkbox" data-testid="gift"> Gift wrap</label></p>
      <p><label for="speed">Delivery</label> <select id="speed" data-testid="speed"><option>Standard</option><option>Express</option></select></p>
      <p><button class="primary" data-testid="pay">Pay</button> <button aria-label="Close panel">x</button></p>
      <p style="position: relative"><button data-testid="covered">Covered</button><span data-testid="overlay" style="position: absolute; inset: 0; background: white"></span></p>
      <p data-testid="total">$42.00</p>
      <p role="status" data-testid="status">Ready</p>\`
    const card = () => root.querySelector('card-field').shadowRoot.querySelector('input').value
    root.querySelector('[data-testid="pay"]').addEventListener('click', () => {
      status(root, 'Paid with card ' + card() + ' and coupon ' + root.querySelector('#coupon').value)
    })
    root.querySelector('[aria-label="Close panel"]').addEventListener('click', () => status(root, 'Closed'))
    root.querySelector('[data-testid="gift"]').addEventListener('change', (event) => status(root, event.target.checked ? 'Gift wrapped' : 'No gift wrap'))
    root.querySelector('#speed').addEventListener('change', (event) => status(root, 'Delivery ' + event.target.value))
    root.querySelector('#coupon').addEventListener('keydown', (event) => { if (event.key === 'Enter') status(root, 'Coupon applied') })
  }
})
customElements.define('task-item', class extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot !== null) return
    const name = document.createElement('span')
    name.className = 'task-name'
    name.dataset.testid = 'task'
    name.textContent = this.getAttribute('name')
    this.attachShadow({ mode: 'open' }).append(name)
  }
})
customElements.define('info-card', class extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot !== null) return
    this.attachShadow({ mode: 'open' }).innerHTML = '<h3>Note: <slot name="title"></slot></h3><p class="body"><slot></slot></p>'
  }
})
customElements.define('secret-box', class extends HTMLElement {
  connectedCallback() {
    if (this.closed !== undefined) return
    this.closed = this.attachShadow({ mode: 'closed' })
    this.closed.innerHTML = '<button data-testid="sealed">Sealed button</button><p>Sealed text</p>'
  }
})
customElements.define('scroll-feed', class extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot !== null) return
    const root = this.attachShadow({ mode: 'open' })
    root.innerHTML = '<div data-testid="feed" style="height: 80px; overflow: auto; border: 1px solid"><div style="height: 600px">Feed</div></div><p data-testid="feed-status">Not scrolled</p>'
    root.querySelector('[data-testid="feed"]').addEventListener('wheel', () => { root.querySelector('[data-testid="feed-status"]').textContent = 'Scrolled' })
  }
})
customElements.define('my-button', class extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot !== null) return
    const root = this.attachShadow({ mode: 'open' })
    root.innerHTML = '<button type="button"><slot></slot></button>'
    root.querySelector('button').addEventListener('click', () => { document.querySelector('[data-testid="buy-status"]').textContent = 'Pressed ' + this.textContent.trim() })
  }
})
customElements.define('hover-tip', class extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot !== null) return
    const root = this.attachShadow({ mode: 'open' })
    root.innerHTML = '<button data-testid="tip">Help</button><span data-testid="tip-status">Tip hidden</span>'
    root.querySelector('button').addEventListener('mouseenter', () => { root.querySelector('[data-testid="tip-status"]').textContent = 'Tip shown' })
  }
})
`

/** A page whose controls and text live in open shadow roots, nested two deep, with slots, and one closed root. */
export const SHADOW_CHECKOUT_PAGE: string = htmlPage(
  'Shadow checkout',
  `<span id="outside-name">Outside name</span>
<checkout-panel data-testid="panel"></checkout-panel>
<ul data-testid="tasks">
<li><task-item name="Task one"></task-item></li>
<li class="task-name" data-testid="task">Task two</li>
<li><task-item name="Task three"></task-item></li>
</ul>
<info-card data-testid="info"><span slot="title">Shipping</span>Free over $50</info-card>
<secret-box data-testid="secret"></secret-box>
<scroll-feed></scroll-feed>
<hover-tip></hover-tip>
<p><my-button data-testid="pay-now">Pay now</my-button> <my-button data-testid="refund"><b>Refund</b></my-button></p>
<p data-testid="buy-status">Nothing pressed</p>
<p data-testid="after">After the roots</p>`,
  SHADOW_SCRIPT,
)

/** The routes of the shadow page. */
export function shadowRoutes(): Route[] {
  return [['GET /shadow', (_request, response) => respondWith(response, 200, HTML_TYPE, SHADOW_CHECKOUT_PAGE)]]
}
