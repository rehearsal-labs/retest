import { htmlPage } from './html.ts'

/** Where the choices page reports each click on its locked setting. The server counts them. */
export const TOGGLE_PATH = '/actions/toggle'

// Every change the page hears, with whether it was trusted, and the state of every control, shown as text so a
// look can read it. Clicks on each checkable control are counted from the earliest listener a page can have, so a
// test can tell a control was clicked once, or never. The locked setting cancels every click, and reports it.
const SCRIPT = `
const show = (testId, value) => { document.querySelector('[data-testid="' + testId + '"]').textContent = value }
const byTestId = (testId) => document.querySelector('[data-testid="' + testId + '"]')
const heard = []
for (const type of ['input', 'change']) {
  addEventListener(type, (event) => {
    heard.push(type + ':' + (event.target.dataset.testid ?? event.target.localName) + ':' + event.isTrusted)
    show('changes-heard', heard.join(' '))
  }, true)
}
const clicks = new Map()
const pointer = []
for (const type of ['pointerdown', 'mousedown', 'click']) {
  addEventListener(type, (event) => {
    const testId = event.target.closest('[data-testid]')?.dataset.testid ?? event.target.localName
    if (type === 'click') clicks.set(testId, (clicks.get(testId) ?? 0) + 1)
    pointer.push(type + ':' + testId)
    show('clicks-heard', [...clicks].map(([name, count]) => name + '=' + count).join(' '))
    show('pointer-heard', pointer.join(' '))
  }, true)
}
const states = () => {
  show('country-shown', byTestId('country').value || 'none')
  show('toppings-shown', [...byTestId('toppings').selectedOptions].map((option) => option.value).join(',') || 'none')
  show('city-shown', byTestId('city').value)
  const checks = ['agree', 'newsletter', 'locked', 'small', 'large', 'covered'].map((testId) => testId + '=' + byTestId(testId).checked)
  checks.push('remember=' + byTestId('remember').getAttribute('aria-checked'))
  show('checks-shown', checks.join(' '))
}
states()
addEventListener('change', states)
const remember = byTestId('remember')
remember.addEventListener('click', () => {
  remember.setAttribute('aria-checked', String(remember.getAttribute('aria-checked') !== 'true'))
  states()
})
byTestId('locked').addEventListener('click', (event) => {
  event.preventDefault()
  fetch('${TOGGLE_PATH}', { method: 'POST' })
})
byTestId('add-peru').addEventListener('click', () => setTimeout(() => byTestId('country').append(new Option('Peru', 'pe')), 300))
const coverOnHover = byTestId('hover-covered')
coverOnHover.addEventListener('pointerover', () => { byTestId('hover-cover').hidden = false }, { once: true })
`

const STYLE = `
<style>
.switch { display: inline-flex; gap: 8px; align-items: center; padding: 4px; border: 1px solid }
.switch input { position: absolute; opacity: 0; width: 0; height: 0; margin: 0 }
.slider { display: inline-block; width: 32px; height: 16px; border-radius: 8px; background: #ccc }
.covered { position: relative; display: inline-block; padding: 4px }
.cover { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.1) }
</style>`

/**
 * Three selects and the checkable controls `check` and `uncheck` meet: a native checkbox, an element whose role is
 * checkbox, a hidden checkbox ticked through its styled label, a setting that cancels every click, a radio group,
 * and a checkbox a cover sits on, and one it covers when the pointer arrives.
 */
export const CHOICES_PAGE: string = htmlPage(
  'Choices',
  `${STYLE}
<label for="country">Country</label>
<select id="country" data-testid="country">
<option value="">Choose a country</option>
<option value="ca">Canada</option>
<option value="mx">Mexico</option>
<option value="us">United States</option>
<option value="fr" disabled>France</option>
<optgroup label="Closed" disabled><option value="de">Germany</option></optgroup>
</select>
<button type="button" data-testid="add-peru">Add Peru</button>
<label for="toppings">Toppings</label>
<select id="toppings" data-testid="toppings" multiple size="4">
<option value="cheese" selected>Cheese</option>
<option value="olives">Olives</option>
<option value="basil">Basil</option>
<option value="garlic">Garlic</option>
</select>
<label for="city">City</label>
<select id="city" data-testid="city">
<option value="paris-fr">Paris</option>
<option value="paris-tx">  Paris </option>
<option value="rome">Rome</option>
</select>
<p><label><input type="checkbox" data-testid="agree"> I agree</label></p>
<p><span role="checkbox" aria-checked="false" tabindex="0" data-testid="remember">Remember me</span></p>
<p><label class="switch" data-testid="newsletter-label"><input type="checkbox" data-testid="newsletter"><span class="slider"></span> Newsletter</label></p>
<p><label><input type="checkbox" data-testid="locked"> Locked setting</label></p>
<fieldset><legend>Size</legend>
<label><input type="radio" name="size" value="small" data-testid="small" checked> Small</label>
<label><input type="radio" name="size" value="large" data-testid="large"> Large</label>
</fieldset>
<p><span class="covered"><input type="checkbox" data-testid="covered"><span class="cover" data-testid="cover"></span></span></p>
<p><span class="covered"><input type="checkbox" data-testid="hover-covered"><span class="cover" data-testid="hover-cover" hidden></span></span></p>
<p>Country: <span data-testid="country-shown"></span></p>
<p>Toppings: <span data-testid="toppings-shown"></span></p>
<p>City: <span data-testid="city-shown"></span></p>
<p>Checks: <span data-testid="checks-shown"></span></p>
<p>Changes heard: <span data-testid="changes-heard"></span></p>
<p>Clicks heard: <span data-testid="clicks-heard"></span></p>
<p>Pointer heard: <span data-testid="pointer-heard"></span></p>`,
  SCRIPT,
)
