import { randomInt, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { htmlPage } from './html.ts'
import { TASK_APP_PASSWORD } from './sign-in.ts'

/** The cookie that ties a sign-in waiting for its code to the code the app sent. */
export const PENDING_COOKIE = 'task-app-pending'

/** The first step: a user name and a password, which send a one-time code. */
export const CODE_SIGN_IN_PAGE: string = htmlPage(
  'Sign in with a code',
  `<form method="post" action="/code/send">
<label for="user">User name</label>
<input id="user" name="user" data-testid="user" autocomplete="off">
<label for="password">Password</label>
<input id="password" name="password" data-testid="password" type="password" autocomplete="off">
<button data-testid="send-code">Send code</button>
</form>`,
)

/** The second step: the code the app sent. Enter in the field submits it. */
export const CODE_PAGE: string = htmlPage(
  'Enter the code',
  `<form method="post" action="/code/verify">
<label for="code">Code</label>
<input id="code" name="code" data-testid="code" autocomplete="off">
<button data-testid="verify">Verify</button>
</form>`,
)

/** The page a refused step answers with. */
export function renderRefusal(reason: string): string {
  return htmlPage('Not signed in', `<p data-testid="refusal">${reason}</p>`)
}

/**
 * Sign-ins waiting for their one-time code, keyed by the token in each one's cookie. Each code is sent by writing it
 * to the outbox, when there is one, as a mail server would deliver it: the file holds the last code sent.
 */
export class CodeSignIns {
  readonly #pending = new Map<string, { user: string; code: string }>()
  readonly #sent: string[] = []
  readonly #outbox: string | undefined

  constructor(outbox: string | undefined) {
    this.#outbox = outbox
  }

  /** Sends a new code to a user who gave the right password, and returns the cookie that waits for it. */
  send(form: URLSearchParams): string | undefined {
    const user = form.get('user') ?? ''
    if (user === '' || form.get('password') !== TASK_APP_PASSWORD) return undefined
    const code = String(randomInt(10_000_000, 100_000_000))
    const token = randomUUID()
    this.#pending.set(token, { user, code })
    this.#sent.push(code)
    if (this.#outbox !== undefined) writeFileSync(this.#outbox, `${code}\n`)
    return `${PENDING_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`
  }

  /** The user the code signs in, for the sign-in the cookie names. A code signs in once. */
  verify(cookieHeader: string | undefined, form: URLSearchParams): string | undefined {
    const token = cookieValue(cookieHeader, PENDING_COOKIE)
    const pending = token === undefined ? undefined : this.#pending.get(token)
    if (token === undefined || pending === undefined || form.get('code') !== pending.code) return undefined
    this.#pending.delete(token)
    return pending.user
  }

  /** Every code sent, oldest first. */
  sent(): readonly string[] {
    return [...this.#sent]
  }
}

function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  for (const pair of (cookieHeader ?? '').split(';')) {
    const [key, value] = pair.trim().split('=')
    if (key === name) return value
  }
  return undefined
}
