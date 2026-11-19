import { chromium, defineConfig } from 'retest'

// Two apps and nothing else: no default app, secrets, test ids, tags or states.
const config = defineConfig({
  apps: { owner: chromium(), member: chromium() },
})

export default config

declare module 'retest' {
  interface Register {
    config: typeof config
  }
}
