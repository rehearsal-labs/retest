import { app, chrome, chromium, defineConfig, env } from '@rehearsal-labs/retest'

// An app's own constant of test ids, as a project exports it.
const testIds = { saveTask: 'save-task', taskTitle: 'task-title', savedTask: 'saved-task' } as const

export const config = defineConfig({
  apps: {
    web: app({ baseUrl: 'http://127.0.0.1:4173', targets: { chromium: chromium(), beta: chrome({ channel: 'beta' }) } }),
    phone: chromium({ emulate: 'Pixel 9' }),
    tablet: chromium({ emulate: { viewport: { width: 800, height: 1280 }, deviceScaleFactor: 2, touch: true } }),
    kiosk: chromium({ emulate: { viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1, touch: false } }),
    mixed: app({ targets: { pixel: chromium({ emulate: 'Pixel 9' }), desktop: chromium() } }),
    phones: app({ targets: { pixel: chromium({ emulate: 'Pixel 9' }), iphone: chrome({ emulate: 'iPhone 17' }) } }),
  },
  defaultApp: 'web',
  secrets: { password: env('TEST_PASSWORD'), code: async () => '000000' },
  secretOrigins: { password: ['https://auth.example.test'] },
  testIds,
  tags: ['smoke', 'slow'],
  states: ['signed-in'],
})

export default config

declare module '@rehearsal-labs/retest' {
  interface Register {
    config: typeof config
  }
}
