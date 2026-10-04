import { app, chromium, defineConfig, electron } from '@rehearsal-labs/retest'

// An Electron app beside a web app, and an app that mixes the two, which the loader refuses. An Electron app's windows
// are web pages with no address, so its handle is a web page with no goto and no touch screen.
const config = defineConfig({
  apps: {
    desktop: electron({ executablePath: '/opt/Electron.app/Contents/MacOS/Electron', appPath: 'desktop' }),
    web: chromium({ baseUrl: 'http://127.0.0.1:4173' }),
    both: app({ targets: { desktop: electron({ executablePath: '/opt/Electron.app/Contents/MacOS/Electron', appPath: 'desktop' }), browser: chromium() } }),
  },
  defaultApp: 'desktop',
  testIds: ['task-title', 'add-task', 'task-name', 'task-total'],
})

export default config

declare module '@rehearsal-labs/retest' {
  interface Register {
    config: typeof config
  }
}
