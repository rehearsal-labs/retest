import { chromium, defineConfig, env } from '@rehearsal-labs/retest'

// A web app with its server and an emulated phone, with the test ids, secret and tags sync.ts checks against.
const testIds = ['new-task', 'task-title', 'save-task', 'task-count'] as const

const config = defineConfig({
  apps: {
    phone: chromium({ emulate: 'Pixel 9' }),
    web: chromium({
      baseUrl: 'http://localhost:3000',
      start: { command: 'npm run dev', ready: 'http://localhost:3000' },
    }),
  },
  defaultApp: 'web',
  secrets: { password: env('TEST_PASSWORD') },
  testIds,
  tags: ['smoke', 'slow'],
})

export default config

declare module '@rehearsal-labs/retest' {
  interface Register {
    config: typeof config
  }
}
