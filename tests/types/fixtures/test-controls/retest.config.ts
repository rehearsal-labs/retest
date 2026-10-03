import { app, chrome, chromium, defineConfig } from '@rehearsal-labs/retest'

// Locks to hold, and screens sized by a viewport alone.
const config = defineConfig({
  apps: {
    web: chromium({ baseUrl: 'http://127.0.0.1:4173', viewport: { width: 1280, height: 720 } }),
    sizes: app({ targets: { wide: chrome({ viewport: { width: 1920, height: 1080 } }), phone: chrome({ emulate: 'Pixel 9' }) } }),
  },
  defaultApp: 'web',
  locks: ['inbox', 'staging-account'],
})

export default config

declare module '@rehearsal-labs/retest' {
  interface Register {
    config: typeof config
  }
}
