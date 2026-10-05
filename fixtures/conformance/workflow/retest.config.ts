import type { RetestConfig } from '@rehearsal-labs/retest'
import { defineConfig, env } from '@rehearsal-labs/retest'
import { conformanceBaseUrl, conformanceTarget, conformanceVariables } from '../config.ts'

// The forty basic workflow cases of docs/plans/public-beta/workflow-cases.md, families 1 to 10, on the engine the
// runner names. The password is the workflow sign-in password, typed as the secret `password`; the states are the
// ones family 3 saves.
const config: RetestConfig = defineConfig({
  apps: { web: { ...conformanceTarget(), baseUrl: conformanceBaseUrl() } },
  secrets: { password: env(conformanceVariables.workflowPassword) },
  states: ['signed-in', 'admin'],
})

export default config
