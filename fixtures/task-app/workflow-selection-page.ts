import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Route } from './route.ts'
import { defectOf, handled, PAGE_HELPERS, readJson, scriptValue, sendJson, sendPage, stringField, Visitors, workflowPage } from './workflow-page.ts'

type Preferences = { plan: string; seats: string; updates: boolean; summary: boolean; alerts: boolean; theme: string }

const plans = [
  { value: 'free', label: 'Free', price: '$0 a month' },
  { value: 'team', label: 'Team', price: '$12 a month' },
  { value: 'business', label: 'Business', price: '$30 a month' },
] as const

const seatCounts = ['10', '25', '50'] as const
const themes = ['light', 'dark', 'system'] as const

function defaults(): Preferences {
  return { plan: 'free', seats: '10', updates: true, summary: false, alerts: true, theme: 'light' }
}

// The page shows every control's state as one line of text, so a test can read a checkbox or a radio group
// without a matcher for checked state. Seats only exist on the Business plan. The page is drawn from the
// preferences the server saved, so a reload shows what was kept.
const PREFERENCES_SCRIPT = (saved: Preferences): string => `${PAGE_HELPERS}
const saved = ${scriptValue(saved)}
const prices = ${scriptValue(Object.fromEntries(plans.map((plan) => [plan.value, plan.price])))}
const form = byTestId('preferences-form')
const read = () => ({
  plan: form.elements.plan.value,
  seats: form.elements.seats.value,
  updates: form.elements.updates.checked,
  summary: form.elements.summary.checked,
  alerts: form.elements.alerts.checked,
  theme: form.elements.theme.value,
})
const describe = (preferences) => [
  'plan=' + preferences.plan,
  'seats=' + (preferences.plan === 'business' ? preferences.seats : 'none'),
  'updates=' + (preferences.updates ? 'on' : 'off'),
  'summary=' + (preferences.summary ? 'on' : 'off'),
  'alerts=' + (preferences.alerts ? 'on' : 'off'),
  'theme=' + preferences.theme,
].join(' ')
const refresh = () => {
  const current = read()
  byTestId('seats-field').hidden = current.plan !== 'business'
  byTestId('price').textContent = prices[current.plan]
  byTestId('current').textContent = describe(current)
}
form.elements.plan.value = saved.plan
form.elements.seats.value = saved.seats
form.elements.updates.checked = saved.updates
form.elements.summary.checked = saved.summary
form.elements.alerts.checked = saved.alerts
form.elements.theme.value = saved.theme
refresh()
form.addEventListener('change', refresh)
form.addEventListener('submit', async (event) => {
  event.preventDefault()
  const response = await fetch(withDefect('/workflow/api/preferences'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(read()) })
  byTestId('saved').textContent = 'Saved ' + describe(await response.json())
})
`

function preferencesPage(saved: Preferences): string {
  const planOptions = plans.map((plan) => `<option value="${plan.value}">${plan.label}</option>`).join('')
  const seatOptions = seatCounts.map((count) => `<option value="${count}">${count} seats</option>`).join('')
  const themeRadios = themes.map((theme) => `<label><input type="radio" name="theme" value="${theme}"> ${theme[0]?.toUpperCase()}${theme.slice(1)}</label>`).join('\n')
  const checkbox = (name: string, label: string): string => `<p><label><input type="checkbox" name="${name}"> ${label}</label></p>`
  return workflowPage(
    'Preferences',
    `<form data-testid="preferences-form">
<p><label for="plan">Plan</label> <select id="plan" name="plan">${planOptions}</select> <span data-testid="price"></span></p>
<p data-testid="seats-field"><label for="seats">Seats</label> <select id="seats" name="seats">${seatOptions}</select></p>
${checkbox('updates', 'Product updates')}
${checkbox('summary', 'Weekly summary')}
${checkbox('alerts', 'Security alerts')}
<fieldset><legend>Theme</legend>
${themeRadios}
</fieldset>
<p><button type="submit">Save preferences</button></p>
</form>
<p>Current: <span data-testid="current"></span></p>
<p role="status" data-testid="saved"></p>`,
    PREFERENCES_SCRIPT(saved),
  )
}

function booleanField(body: unknown, name: string): boolean {
  return typeof body === 'object' && body !== null && name in body && Reflect.get(body, name) === true
}

function oneOf<Value extends string>(choices: readonly Value[], value: string | undefined, fallback: Value): Value {
  return choices.find((choice) => choice === value) ?? fallback
}

// The `ignores-checkbox` defect keeps the weekly summary off whatever the form sent, as a field left out of a
// server's update would.
async function savePreferences(preferences: Preferences, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJson(request)
  Object.assign(preferences, {
    plan: oneOf(plans.map((plan) => plan.value), stringField(body, 'plan'), 'free'),
    seats: oneOf(seatCounts, stringField(body, 'seats'), '10'),
    updates: booleanField(body, 'updates'),
    summary: defectOf(request) === 'ignores-checkbox' ? false : booleanField(body, 'summary'),
    alerts: booleanField(body, 'alerts'),
    theme: oneOf(themes, stringField(body, 'theme'), 'light'),
  })
  sendJson(response, 200, preferences)
}

/**
 * Family 7, select options, checkboxes and radios: a preferences form with a plan select whose Business option
 * reveals a seats select, three checkboxes and a theme radio group, saved on the server per visitor.
 * `?defect=ignores-checkbox` saves the weekly summary as off whatever was sent.
 */
export function selectionRoutes(): Route[] {
  const preferences = new Visitors(defaults)
  return [
    ['GET /workflow/preferences', (request, response) => sendPage(response, preferencesPage(preferences.of(request, response)))],
    ['POST /workflow/api/preferences', (request, response) => handled(savePreferences(preferences.of(request, response), request, response), response)],
  ]
}
