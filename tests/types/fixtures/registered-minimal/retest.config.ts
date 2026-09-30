import { chromium, defineConfig } from '@rehearsal-labs/retest'

// Two apps and nothing else: no default app, secrets, test ids, tags or states.
const config = defineConfig({
  apps: { owner: chromium(), member: chromium() },
})

export default config

declare module '@rehearsal-labs/retest' {
  interface Register {
    config: typeof config
  }
}
