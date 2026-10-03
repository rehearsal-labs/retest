import { chromium, defineConfig } from '@rehearsal-labs/retest'

// A config with no evaluation block: no test may ask for an AI check.
const config = defineConfig({ apps: { web: chromium() } })

export default config

declare module '@rehearsal-labs/retest' {
  interface Register {
    config: typeof config
  }
}
