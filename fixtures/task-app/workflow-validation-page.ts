import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Route } from './route.ts'
import { queryOf } from './route.ts'
import { defectOf, handled, PAGE_HELPERS, readJson, scriptValue, sendJson, sendPage, stringField, workflowPage } from './workflow-page.ts'

/** An email address that already has an account, which only the server knows. */
export const TAKEN_EMAIL = 'taken@example.com'

/** What the sign-up form says about each field it refuses. */
export const SIGN_UP_ERRORS = {
  name: 'Enter your name',
  email: 'Enter an email address like name@example.com',
  password: 'Use at least 8 characters',
  confirmation: 'The passwords do not match',
  terms: 'Accept the terms to continue',
  taken: 'That email already has an account',
} as const

type SignUp = { name: string; email: string; password: string; confirmation: string; terms: boolean }

type Problems = Partial<Record<keyof SignUp, string>>

// The page and the server judge a sign-up by these same rules. The `accepts-short-password` defect drops the
// length rule from both, as a regression in shared validation code would.
const rulesSource = (defect: string | undefined): string => `(form) => {
  const problems = {}
  if (form.name.trim() === '') problems.name = ${scriptValue(SIGN_UP_ERRORS.name)}
  if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(form.email.trim())) problems.email = ${scriptValue(SIGN_UP_ERRORS.email)}
  if (${defect === 'accepts-short-password' ? 'false' : 'form.password.length < 8'}) problems.password = ${scriptValue(SIGN_UP_ERRORS.password)}
  if (form.confirmation !== form.password) problems.confirmation = ${scriptValue(SIGN_UP_ERRORS.confirmation)}
  if (!form.terms) problems.terms = ${scriptValue(SIGN_UP_ERRORS.terms)}
  return problems
}`

const fields = ['name', 'email', 'password', 'confirmation', 'terms'] as const

function problemsOf(form: SignUp, defect: string | undefined): Problems {
  const problems: Problems = {}
  if (form.name.trim() === '') problems.name = SIGN_UP_ERRORS.name
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) problems.email = SIGN_UP_ERRORS.email
  if (defect !== 'accepts-short-password' && form.password.length < 8) problems.password = SIGN_UP_ERRORS.password
  if (form.confirmation !== form.password) problems.confirmation = SIGN_UP_ERRORS.confirmation
  if (!form.terms) problems.terms = SIGN_UP_ERRORS.terms
  return problems
}

// The form checks itself on submit and sends nothing while a field is wrong. Each error sits under its field;
// changing a field clears its own error and no other. The server checks again and may refuse a taken email.
const SIGN_UP_SCRIPT = (defect: string | undefined): string => `${PAGE_HELPERS}
const rules = ${rulesSource(defect)}
const form = byTestId('sign-up-form')
const read = () => ({
  name: form.elements.name.value,
  email: form.elements.email.value,
  password: form.elements.password.value,
  confirmation: form.elements.confirmation.value,
  terms: form.elements.terms.checked,
})
const show = (problems) => {
  for (const field of ${scriptValue(fields)}) byTestId(field + '-error').textContent = problems[field] ?? ''
  const count = Object.keys(problems).length
  byTestId('error-summary').textContent = count === 0 ? '' : count === 1 ? 'Fix 1 problem to continue' : 'Fix ' + count + ' problems to continue'
}
for (const field of ${scriptValue(fields)}) {
  form.elements[field].addEventListener(field === 'terms' ? 'change' : 'input', () => {
    byTestId(field + '-error').textContent = ''
  })
}
form.addEventListener('submit', async (event) => {
  event.preventDefault()
  const values = read()
  const problems = rules(values)
  show(problems)
  if (Object.keys(problems).length > 0) return
  const response = await fetch(withDefect('/workflow/api/sign-ups'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) })
  const answer = await response.json()
  if (!response.ok) {
    show(answer.problems)
    return
  }
  form.hidden = true
  byTestId('welcome').textContent = 'Welcome, ' + answer.name
})
`

function signUpPage(defect: string | undefined): string {
  const field = (name: string, label: string, type: string): string =>
    `<p><label for="${name}">${label}</label> <input id="${name}" name="${name}" type="${type}" autocomplete="off" aria-describedby="${name}-error"></p>
<p data-testid="${name}-error" id="${name}-error"></p>`
  return workflowPage(
    'Create an account',
    `<p role="alert" data-testid="error-summary"></p>
<form data-testid="sign-up-form" novalidate>
${field('name', 'Name', 'text')}
${field('email', 'Email', 'email')}
${field('password', 'Password', 'password')}
${field('confirmation', 'Confirm password', 'password')}
<p><label><input type="checkbox" name="terms" aria-describedby="terms-error"> I accept the terms</label></p>
<p data-testid="terms-error" id="terms-error"></p>
<p><button type="submit">Create account</button></p>
</form>
<p role="status" data-testid="welcome"></p>`,
    SIGN_UP_SCRIPT(defect),
  )
}

function signUpOf(body: unknown): SignUp {
  const terms = typeof body === 'object' && body !== null && 'terms' in body && body.terms === true
  return {
    name: stringField(body, 'name') ?? '',
    email: stringField(body, 'email') ?? '',
    password: stringField(body, 'password') ?? '',
    confirmation: stringField(body, 'confirmation') ?? '',
    terms,
  }
}

/**
 * Family 6, show validation errors: a sign-up form that checks every field on submit and sends nothing while one
 * is wrong, and a server that checks again and refuses a taken email. `GET /workflow/api/sign-ups?name=Ada` says
 * how many sign-ups under that name reached the server. `?defect=accepts-short-password` drops the length rule.
 */
export function validationRoutes(): Route[] {
  const received = new Map<string, number>()
  const accounts = new Set<string>([TAKEN_EMAIL])

  async function signUp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const form = signUpOf(await readJson(request))
    received.set(form.name, (received.get(form.name) ?? 0) + 1)
    const problems = problemsOf(form, defectOf(request))
    const email = form.email.trim().toLowerCase()
    if (problems.email === undefined && accounts.has(email)) problems.email = SIGN_UP_ERRORS.taken
    if (Object.keys(problems).length > 0) {
      sendJson(response, 422, { problems })
      return
    }
    accounts.add(email)
    sendJson(response, 201, { name: form.name.trim() })
  }

  return [
    ['GET /workflow/sign-up', (request, response) => sendPage(response, signUpPage(defectOf(request)))],
    ['POST /workflow/api/sign-ups', (request, response) => handled(signUp(request, response), response)],
    ['GET /workflow/api/sign-ups', (request, response) => sendJson(response, 200, { received: received.get(queryOf(request).get('name') ?? '') ?? 0 })],
  ]
}
