import { app, chromium, defineConfig } from '@rehearsal-labs/retest'

// Browsers beside native apps. The loader accepts every target here, and a run refuses all but Chromium's at setup;
// the types offer each app only what its targets can do.
const iphone = { platform: 'ios-simulator', appPath: 'build/Tasks.app', device: 'iPhone 17', runtime: '26.0' } as const

const config = defineConfig({
  apps: {
    web: chromium({ baseUrl: 'http://127.0.0.1:4173' }),
    firefox: { browser: 'firefox', baseUrl: 'http://127.0.0.1:4173' },
    iphone,
    mac: { platform: 'macos', appPath: 'build/Tasks.app' },
    phones: app({ targets: { small: iphone, large: { ...iphone, device: 'iPhone 17 Pro Max' } } }),
    mixed: app({ targets: { browser: chromium(), phone: iphone } }),
  },
  defaultApp: 'iphone',
  testIds: ['task-title', 'save-task', 'task-status'],
})

export default config

declare module '@rehearsal-labs/retest' {
  interface Register {
    config: typeof config
  }
}
