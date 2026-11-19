import { chromium, defineConfig } from 'retest'

// A config that declares no locks.
const config = defineConfig({ apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173' }) } })

export default config

declare module 'retest' {
  interface Register {
    config: typeof config
  }
}
