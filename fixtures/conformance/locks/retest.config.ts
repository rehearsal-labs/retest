import type { RetestConfig } from 'retest'
import { defineConfig } from 'retest'
import { conformanceBaseUrl, conformanceTarget } from '../config.ts'

// Shared-state locks under workers: tests in different files that hold the lock `inbox` never run at the same time.
const config: RetestConfig = defineConfig({
  apps: { web: { ...conformanceTarget(), baseUrl: conformanceBaseUrl() } },
  locks: ['inbox'],
})

export default config
