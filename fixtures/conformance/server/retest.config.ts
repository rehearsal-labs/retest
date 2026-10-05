import type { RetestConfig } from '@rehearsal-labs/retest'
import { defineConfig } from '@rehearsal-labs/retest'
import { conformanceTarget, conformanceVariables, requiredVariable } from '../config.ts'

// One app-server command with readiness and cleanup: the run starts fixtures/app-server, waits until its address
// answers, and stops its whole process group when the run ends. The runner names the command and the address.
const serverUrl = requiredVariable(conformanceVariables.serverUrl)

const config: RetestConfig = defineConfig({
  apps: {
    web: {
      ...conformanceTarget(),
      baseUrl: serverUrl,
      start: { command: requiredVariable(conformanceVariables.serverCommand), ready: serverUrl, timeoutMs: 15000 },
    },
  },
})

export default config
