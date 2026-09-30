import { app, chrome, chromium, defineConfig, env } from '@rehearsal-labs/retest'

// Every app opens the task app from fixtures/task-app. Start it with `node fixtures/task-app/cli.ts` and put
// the address it prints in TASK_APP_URL.
const baseUrl = process.env['TASK_APP_URL'] ?? 'http://127.0.0.1:4173'

const config = defineConfig({
  apps: {
    // Two people on the same site: each role gets a browser context, and so a session, of its own.
    web: chrome({ baseUrl }),
    admin: chrome({ baseUrl }),
    // A test that uses this app runs twice: in Google Chrome, and in the Chromium that RETEST_CHROMIUM points to.
    desktop: app({ baseUrl, targets: { chrome: chrome(), chromium: chromium() } }),
    // Emulated phones in desktop Chrome: their screen, touch and user agent, not the real devices.
    phone: app({ baseUrl, targets: { pixel: chrome({ emulate: 'Pixel 9' }), iphone: chrome({ emulate: 'iPhone 17' }) } }),
  },
  defaultApp: 'web',
  // A test that uses both desktop and phone runs once per entry, not once per combination.
  runs: [
    { desktop: 'chrome', phone: 'pixel' },
    { desktop: 'chromium', phone: 'iphone' },
  ],
  secrets: { password: env('TASK_APP_PASSWORD') },
  tags: ['smoke', 'roles', 'browsers', 'phone'],
  states: ['signed-in'],
  timeouts: { action: 5000, assertion: 5000, test: 30_000 },
})

export default config

// Lets every test file see the app names, secrets, tags and states above.
declare module '@rehearsal-labs/retest' {
  interface Register {
    config: typeof config
  }
}
