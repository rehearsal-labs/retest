import type { RetestConfig } from '@rehearsal-labs/retest'
import { defineConfig, env } from '@rehearsal-labs/retest'
import { conformanceBaseUrl, conformanceTarget, conformanceVariables } from '../config.ts'

// Web participants: named apps on one origin, each signed in as its own account from its own saved state. The owner
// and the member make and read a record; the four others prove four sessions stay apart in one test. The password
// is the task app's sign-in password, typed as the secret `password`.
const baseUrl = conformanceBaseUrl()
const participant = (): ReturnType<typeof conformanceTarget> & { readonly baseUrl: string } => ({ ...conformanceTarget(), baseUrl })

const config: RetestConfig = defineConfig({
  apps: { owner: participant(), member: participant(), alpha: participant(), beta: participant(), gamma: participant(), delta: participant() },
  states: ['owner-account', 'member-account', 'alpha-signed-in', 'beta-signed-in', 'gamma-signed-in', 'delta-signed-in'],
  secrets: { password: env(conformanceVariables.password) },
})

export default config
