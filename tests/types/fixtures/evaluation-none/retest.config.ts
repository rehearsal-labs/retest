import { chromium, defineConfig } from 'retest'

// A config with no evaluation block: no test may ask for an AI check.
const config = defineConfig({ apps: { web: chromium() } })

export default config

declare module 'retest' {
  interface Register {
    config: typeof config
  }
}
