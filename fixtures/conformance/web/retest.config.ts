import type { RetestConfig } from 'retest'
import { defineConfig, env } from 'retest'
import { conformanceBaseUrl, conformanceTarget, conformanceVariables } from '../config.ts'

// The method cases on the task app: one app on the engine the runner names. The password is the task app's sign-in
// password, typed as the secret `password`.
const config: RetestConfig = defineConfig({
  apps: { web: { ...conformanceTarget(), baseUrl: conformanceBaseUrl() } },
  secrets: { password: env(conformanceVariables.password) },
})

export default config
