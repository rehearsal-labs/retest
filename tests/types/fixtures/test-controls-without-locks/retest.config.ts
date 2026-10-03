import { chromium, defineConfig } from '@rehearsal-labs/retest'

// A config that declares no locks.
const config = defineConfig({ apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173' }) } })

export default config

declare module '@rehearsal-labs/retest' {
  interface Register {
    config: typeof config
  }
}
