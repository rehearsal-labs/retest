import type { Same } from './support/same.ts'
import { chromium, defineConfig, env, type SecretContext, type SecretSource } from '@rehearsal-labs/retest'

// A secret's function is called with a signal, aborted once Retest stops waiting for the value. It is the project's
// own AbortSignal, so the function can hand it to fetch. None of these configs is registered.
export const signal: Same<SecretContext['signal'], AbortSignal> = true

export async function readCode({ signal: stop }: SecretContext): Promise<string> {
  const response = await fetch('http://127.0.0.1:4173/outbox/latest', { signal: stop })
  return response.text()
}

export const source: SecretSource = readCode

export const secrets = defineConfig({
  apps: { web: chromium() },
  secrets: {
    code: readCode,
    token: async ({ signal: stop }) => (stop.aborted ? '' : 'token'),
    fixed: () => 'correct horse',
    password: env('TEST_PASSWORD'),
  },
})

export const wrongContext = defineConfig({
  apps: { web: chromium() },
  secrets: { code: (context: { timeoutMs: number }) => String(context.timeoutMs) }, // type-error TS2322 Property 'timeoutMs' is missing in type 'SecretContext'
})
