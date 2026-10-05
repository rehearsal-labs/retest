import type { RetestConfig } from '@rehearsal-labs/retest'
import { defineConfig } from '@rehearsal-labs/retest'
import { conformanceBaseUrl, conformanceTarget } from '../config.ts'

// Failure handling after input was sent: the runner starts the task app in a mode whose save button never confirms
// its press, or whose save never answers, then stops the run or ends the browser it reported at the moment that
// matters, and reads what the run recorded.
const config: RetestConfig = defineConfig({
  apps: { web: { ...conformanceTarget(), baseUrl: conformanceBaseUrl() } },
})

export default config
