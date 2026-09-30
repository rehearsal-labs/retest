import { randomUUID } from 'node:crypto'
import { escapeHtml } from './html.ts'

/** The one password the task app accepts, for any user name. */
export const TASK_APP_PASSWORD = 'correct horse battery staple'

/** The cookie that holds a signed-in session. It is HTTP only, so page scripts never read it. */
export const SESSION_COOKIE = 'task-app-session'

/** A cookie that remembers the user name for a day, so saved state has one with an expiry. */
export const REMEMBER_COOKIE = 'task-app-remember'

/** Where the sign-in page keeps the user name, so the account page can show it came back. */
export const STORED_USER_KEY = 'signed-in-user'

const SIGN_IN_SCRIPT = `
const status = document.querySelector('[data-testid="sign-in-status"]')
document.querySelector('[data-testid="sign-in"]').addEventListener('click', async () => {
  const user = document.querySelector('[data-testid="user"]').value
  const password = document.querySelector('[data-testid="password"]').value
  status.textContent = 'Signing in…'
  const response = await fetch('/api/sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user, password }),
  })
  if (!response.ok) {
    status.textContent = 'Wrong user name or password'
    return
  }
  localStorage.setItem('${STORED_USER_KEY}', user)
  location.assign('/account')
})
`

const ACCOUNT_SCRIPT = `
document.querySelector('[data-testid="stored-user"]').textContent = localStorage.getItem('${STORED_USER_KEY}') ?? ''
`

export const SIGN_IN_PAGE: string = page(
  'Sign in',
  `<label for="user">User name</label>
<input id="user" data-testid="user" autocomplete="off">
<label for="password">Password</label>
<input id="password" data-testid="password" type="password" autocomplete="off">
<button type="button" data-testid="sign-in">Sign in</button>
<p data-testid="sign-in-status"></p>`,
  SIGN_IN_SCRIPT,
)

/** Signed-in sessions, keyed by the token in each one's cookie. */
export class Sessions {
  readonly #users = new Map<string, string>()

  /** Starts a session for a user who gave the right password, and returns the cookies to set. */
  signIn(body: unknown): string[] | undefined {
    if (typeof body !== 'object' || body === null || !('user' in body) || !('password' in body)) return undefined
    const { user, password } = body
    if (typeof user !== 'string' || user === '' || password !== TASK_APP_PASSWORD) return undefined
    return this.open(user)
  }

  /** Starts a session for a user the app has already checked, and returns the cookies to set. */
  open(user: string): string[] {
    const token = randomUUID()
    this.#users.set(token, user)
    return [
      `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`,
      `${REMEMBER_COOKIE}=${encodeURIComponent(user)}; Path=/; Max-Age=86400; SameSite=Strict`,
    ]
  }

  /** The user a request's cookies sign in, if any. */
  userOf(cookieHeader: string | undefined): string | undefined {
    for (const pair of (cookieHeader ?? '').split(';')) {
      const [name, token] = pair.trim().split('=')
      if (name === SESSION_COOKIE && token !== undefined) return this.#users.get(token)
    }
    return undefined
  }
}

/** The account page, which shows who the session cookie signs in and the user name the browser kept. */
export function renderAccountPage(user: string | undefined): string {
  const session = user === undefined ? 'Signed out' : `Signed in as ${escapeHtml(user)}`
  return page(
    'Account',
    `<p data-testid="account">${session}</p>
<p>Saved in this browser: <span data-testid="stored-user"></span></p>`,
    ACCOUNT_SCRIPT,
  )
}

function page(title: string, main: string, script: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<link rel="icon" href="data:,">
</head>
<body>
<main>
<h1>${title}</h1>
${main}
</main>
<script>${script}</script>
</body>
</html>
`
}
