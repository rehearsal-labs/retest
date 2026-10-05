import type { RetestConfig } from '@rehearsal-labs/retest'
import { defineConfig } from '@rehearsal-labs/retest'
import { conformanceBaseUrl, conformanceTarget } from '../config.ts'

// Filtering: the runner keeps tests by a part of their title with --grep, and only those run.
const config: RetestConfig = defineConfig({
  apps: { web: { ...conformanceTarget(), baseUrl: conformanceBaseUrl() } },
})

export default config
