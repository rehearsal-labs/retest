import type { RetestConfig } from 'retest'
import { defineConfig, env } from 'retest'
import { conformanceBaseUrl, conformanceTarget, conformanceVariables } from '../config.ts'

// The forty basic workflow cases of docs/compatibility/workflow-cases.md, families 1 to 10, on the engine the
// runner names. The password is the workflow sign-in password, typed as the secret `password`; the states are the
// ones family 3 saves.
const config: RetestConfig = defineConfig({
  apps: { web: { ...conformanceTarget(), baseUrl: conformanceBaseUrl() } },
  secrets: { password: env(conformanceVariables.workflowPassword) },
  states: ['signed-in', 'admin'],
})

export default config
