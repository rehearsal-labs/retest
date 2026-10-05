import type { RetestConfig } from '@rehearsal-labs/retest'
import { defineConfig } from '@rehearsal-labs/retest'
import { conformanceBaseUrl, conformanceTarget } from '../config.ts'

// Shared-state locks under workers: tests in different files that hold the lock `inbox` never run at the same time.
const config: RetestConfig = defineConfig({
  apps: { web: { ...conformanceTarget(), baseUrl: conformanceBaseUrl() } },
  locks: ['inbox'],
})

export default config
