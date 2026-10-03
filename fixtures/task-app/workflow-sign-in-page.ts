import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Route } from './route.ts'
import { randomUUID } from 'node:crypto'
import { escapeHtml } from './html.ts'
import { queryOf } from './route.ts'
import { cookieOf, defectOf, handled, PAGE_HELPERS, readJson, redirect, sendJson, sendPage, stringField, workflowPage } from './workflow-page.ts'

/** The one password the workflow sign-in accepts, for any user name. */
export const WORKFLOW_PASSWORD = 'violet 2210 harbour'

/** The cookie that holds a workflow session. It is HTTP only, so page scripts never read it. */
export const WORKFLOW_SESSION_COOKIE = 'workflow-session'

/** Where the sign-in page keeps the user name, so the account page can show the browser kept it. */
const STORED_USER_KEY = 'workflow-user'

/** Where the account page keeps the project the person pinned. */
const PINNED_KEY = 'workflow-pinned'

const projects = ['Apollo', 'Borealis'] as const

// The form posts as JSON and moves to the account page on success. The page's own `defect` query goes on to the
// sign-in request, so a broken sign-in page reaches the broken server path.
const SIGN_IN_SCRIPT = `${PAGE_HELPERS}
byTestId('sign-in-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const user = document.getElementById('user').value
  const password = document.getElementById('password').value
  byTestId('sign-in-error').textContent = ''
  const response = await fetch(withDefect('/workflow/api/sign-in'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user, password }),
  })
  if (!response.ok) {
    byTestId('sign-in-error').textContent = (await response.json()).error
    return
  }
  localStorage.setItem('${STORED_USER_KEY}', user)
  location.assign('/workflow/account')
})
`

function signInPage(signedOut: boolean): string {
  const notice = signedOut ? '<p role="status" data-testid="signed-out-notice">You are signed out.</p>\n' : ''
  return workflowPage(
    'Sign in',
    `${notice}<form data-testid="sign-in-form" novalidate>
<p><label for="user">User name</label> <input id="user" autocomplete="off"></p>
<p><label for="password">Password</label> <input id="password" type="password" autocomplete="off"></p>
<p><button type="submit">Sign in</button></p>
</form>
<p role="alert" data-testid="sign-in-error"></p>`,
    SIGN_IN_SCRIPT,
  )
}

// Projects come from an API that needs the session cookie, so a page that only looks signed in shows none. Sign
// out forgets the user name the browser kept, then posts the form.
const ACCOUNT_SCRIPT = `${PAGE_HELPERS}
byTestId('stored-user').textContent = localStorage.getItem('${STORED_USER_KEY}') ?? ''
const showPinned = () => { byTestId('pinned').textContent = localStorage.getItem('${PINNED_KEY}') ?? 'nothing' }
showPinned()
byTestId('pin')?.addEventListener('click', () => {
  localStorage.setItem('${PINNED_KEY}', 'Apollo')
  showPinned()
})
byTestId('sign-out-form')?.addEventListener('submit', () => localStorage.removeItem('${STORED_USER_KEY}'))
fetch('/workflow/api/account/projects').then(async (response) => {
  if (!response.ok) {
    byTestId('projects-status').textContent = 'Sign in to see your projects'
    return
  }
  const names = await response.json()
  byTestId('projects').replaceChildren(...names.map((name) => {
    const item = document.createElement('li')
    item.dataset.testid = 'project'
    item.textContent = name
    return item
  }))
  byTestId('projects-status').textContent = names.length + ' projects'
})
`

function accountPage(user: string | undefined, defect: string | undefined): string {
  const signOutAction = defect === 'keeps-session' ? '/workflow/api/sign-out?defect=keeps-session' : '/workflow/api/sign-out'
  const controls =
    user === undefined
      ? '<p><a href="/workflow/sign-in">Sign in</a></p>'
      : `<p><button type="button" data-testid="pin">Pin Apollo</button></p>
<form method="post" action="${signOutAction}" data-testid="sign-out-form"><button type="submit">Sign out</button></form>`
  return workflowPage(
    'Account',
    `<p data-testid="account">${user === undefined ? 'Signed out' : `Signed in as ${escapeHtml(user)}`}</p>
<p>Kept in this browser: <span data-testid="stored-user"></span></p>
<p>Pinned project: <span data-testid="pinned"></span></p>
<h2>Your projects</h2>
<ul data-testid="projects"></ul>
<p role="status" data-testid="projects-status">Loading projects…</p>
${controls}`,
    ACCOUNT_SCRIPT,
  )
}

/**
 * Families 2 and 3, password sign-in, sign-out and saved sign-in state: a sign-in page, an account page whose
 * projects need the session, and a sign-out that ends the session on the server. `?defect=signs-in-as-guest` on
 * the sign-in page signs every user in as guest; `?defect=keeps-session` on the account page signs out without
 * ending the session, so only the page looks signed out.
 */
export function signInRoutes(): Route[] {
  const sessions = new Map<string, string>()
  const userOf = (request: IncomingMessage): string | undefined => {
    const token = cookieOf(request, WORKFLOW_SESSION_COOKIE)
    return token === undefined ? undefined : sessions.get(token)
  }

  async function signIn(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request)
    const user = stringField(body, 'user')?.trim() ?? ''
    if (user === '' || stringField(body, 'password') !== WORKFLOW_PASSWORD) {
      sendJson(response, 401, { error: 'Wrong user name or password' })
      return
    }
    const token = randomUUID()
    sessions.set(token, defectOf(request) === 'signs-in-as-guest' ? 'guest' : user)
    response.setHeader('set-cookie', `${WORKFLOW_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`)
    sendJson(response, 200, { signedIn: true })
  }

  return [
    ['GET /workflow/sign-in', (request, response) => sendPage(response, signInPage(queryOf(request).has('signed-out')))],
    ['POST /workflow/api/sign-in', (request, response) => handled(signIn(request, response), response)],
    ['GET /workflow/account', (request, response) => sendPage(response, accountPage(userOf(request), defectOf(request)))],
    [
      'GET /workflow/api/account/projects',
      (request, response) => {
        if (userOf(request) === undefined) sendJson(response, 401, { error: 'Sign in to see your projects' })
        else sendJson(response, 200, projects)
      },
    ],
    [
      'POST /workflow/api/sign-out',
      (request, response) => {
        request.resume()
        if (defectOf(request) !== 'keeps-session') {
          const token = cookieOf(request, WORKFLOW_SESSION_COOKIE)
          if (token !== undefined) sessions.delete(token)
          response.setHeader('set-cookie', `${WORKFLOW_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
        }
        redirect(response, '/workflow/sign-in?signed-out')
      },
    ],
  ]
}
