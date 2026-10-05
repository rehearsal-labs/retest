import type { RetestConfig } from '@rehearsal-labs/retest'
import { defineConfig } from '@rehearsal-labs/retest'
import { conformanceBaseUrl, conformanceTarget } from '../config.ts'

// test.only: without CI it narrows the run to what it marks; with CI set the run refuses it before any test runs.
const config: RetestConfig = defineConfig({
  apps: { web: { ...conformanceTarget(), baseUrl: conformanceBaseUrl() } },
})

export default config
