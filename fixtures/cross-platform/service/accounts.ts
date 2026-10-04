import type { KnownClient } from './clients.ts'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** A seeded account. The passwords are test-only, printed in the README, and never logged. */
export type SeededAccount = {
  /** What a person types as the account at sign-in. */
  readonly id: string
  /** What the clients show once signed in. */
  readonly name: string
  readonly password: string
}

/** The two accounts every fresh or reset service starts with. */
export const SEEDED_ACCOUNTS: readonly SeededAccount[] = [
  { id: 'ada', name: 'Ada Example', password: 'ada-fixture-password' },
  { id: 'ben', name: 'Ben Example', password: 'ben-fixture-password' },
]

/**
 * One signed-in client. `id` names the session in the task store's history; the token that proves it is kept apart,
 * so a state file that records who made a change never holds a credential. `client` is the app that signed in, as its
 * `x-task-client` header named it.
 */
export type Session = { readonly id: string; readonly account: string; readonly client: KnownClient }

/** What a sign-in hands back: the bearer token for later requests, and who it signs in. */
export type SignedIn = { readonly token: string; readonly session: Session; readonly name: string }

/** Signed-in sessions, keyed by their bearer token. Kept in memory only: a restart or a reset signs everyone out. */
export class Sessions {
  readonly #byToken = new Map<string, Session>()

  /** Starts a session for a client when the account exists and the password is its own. */
  signIn(account: string, password: string, client: KnownClient): SignedIn | undefined {
    const found = SEEDED_ACCOUNTS.find((candidate) => candidate.id === account)
    if (found === undefined || !samePassword(found.password, password)) return undefined
    const token = randomBytes(24).toString('base64url')
    const session = { id: `session-${randomBytes(6).toString('hex')}`, account: found.id, client }
    this.#byToken.set(token, session)
    return { token, session, name: found.name }
  }

  /** The session an `Authorization: Bearer <token>` header proves, if any. */
  fromAuthorization(header: string | undefined): Session | undefined {
    const token = bearerToken(header)
    return token === undefined ? undefined : this.#byToken.get(token)
  }

  /** Ends the session the header proves. Says whether there was one. */
  signOut(header: string | undefined): boolean {
    const token = bearerToken(header)
    return token !== undefined && this.#byToken.delete(token)
  }

  /** Ends every session, as a reset to the seeded state does. */
  clear(): void {
    this.#byToken.clear()
  }
}

/** The display name of a seeded account. */
export function accountName(account: string): string {
  return SEEDED_ACCOUNTS.find((candidate) => candidate.id === account)?.name ?? account
}

function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer ([A-Za-z0-9_-]{16,128})$/.exec(header ?? '')
  return match?.[1]
}

// Compares digests of equal length, so the comparison takes the same time whatever was typed.
function samePassword(expected: string, given: string): boolean {
  return timingSafeEqual(digest(expected), digest(given))
}

function digest(text: string): Buffer {
  return createHash('sha256').update(text).digest()
}
