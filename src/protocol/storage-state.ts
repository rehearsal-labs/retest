import { s, type Schema } from './schema.ts'

/** A cookie as saved sign-in state keeps it. `expires` is in seconds since the epoch, or -1 for a session cookie. */
export type StoredCookie = {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

/** One origin's `localStorage`, as name and value pairs. */
export type StoredOrigin = { origin: string; localStorage: { name: string; value: string }[] }

/**
 * A browser context's sign-in state: its cookies, and `localStorage` for each origin its page visited. It holds
 * session cookies, so it stays in the run folder until the run ends and never enters an event or a report.
 */
export type StorageState = { cookies: StoredCookie[]; origins: StoredOrigin[] }

export const storageStateSchema: Schema<StorageState> = s.object({
  cookies: s.array(
    s.object({
      name: s.string(),
      value: s.string(),
      domain: s.string(),
      path: s.string(),
      expires: s.number({ min: -1 }),
      httpOnly: s.boolean(),
      secure: s.boolean(),
      sameSite: s.optional(s.enum(['Strict', 'Lax', 'None'])),
    }),
  ),
  origins: s.array(
    s.object({
      origin: s.string(),
      localStorage: s.array(s.object({ name: s.string(), value: s.string() })),
    }),
  ),
})
