import type { RetestConfig } from 'retest'
import { defineConfig } from 'retest'
import { conformanceBaseUrl, conformanceTarget } from '../config.ts'

// Filtering: the runner keeps tests by a part of their title with --grep, and only those run.
const config: RetestConfig = defineConfig({
  apps: { web: { ...conformanceTarget(), baseUrl: conformanceBaseUrl() } },
})

export default config
