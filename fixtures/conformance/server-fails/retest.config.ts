import type { RetestConfig } from '@rehearsal-labs/retest'
import { defineConfig } from '@rehearsal-labs/retest'
import { conformanceTarget, conformanceVariables, requiredVariable } from '../config.ts'

// A setup error: the runner names an app server that never listens, so its address never answers within the time
// the config gives it, and every test that needs the app is a setup failure.
const serverUrl = requiredVariable(conformanceVariables.serverUrl)

const config: RetestConfig = defineConfig({
  apps: {
    web: {
      ...conformanceTarget(),
      baseUrl: serverUrl,
      start: { command: requiredVariable(conformanceVariables.serverCommand), ready: serverUrl, timeoutMs: 1500 },
    },
  },
})

export default config
