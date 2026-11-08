import { defineConfig } from '@rehearsal-labs/retest'

// Phones driven through agent-device: an iOS simulator target that opts in, and Android targets, which run through
// agent-device alone. The types offer each app what its targets can do.
const config = defineConfig({
  apps: {
    iphone: { platform: 'ios-simulator', driver: 'agent-device', appPath: 'build/Tasks.app', device: 'iPhone 17', runtime: '26.5', arguments: ['-reset'] },
    pixel: { platform: 'android', appPath: 'build/app-debug.apk', package: 'com.example.tasks', serial: 'emulator-5554' },
    tablet: { platform: 'android', driver: 'agent-device', appPath: 'build/app-debug.apk', package: 'com.example.tasks', device: 'Pixel_Tablet' },
  },
  testIds: ['task-title', 'save-task', 'task-status'],
})

export default config

declare module '@rehearsal-labs/retest' {
  interface Register {
    config: typeof config
  }
}
