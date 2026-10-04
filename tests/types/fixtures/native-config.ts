import { app, chromium, defineConfig } from '@rehearsal-labs/retest'

// Firefox, WebKit, iOS simulator and macOS targets type-check, as the loader accepts them; a run refuses each at
// setup until its driver exists. A native target takes the app's start command, never an address or browser settings.
export const accepted = defineConfig({
  apps: {
    firefox: { browser: 'firefox' },
    webkit: { browser: 'webkit', executablePath: '/opt/webkit/MiniBrowser', headless: true },
    iphone: { platform: 'ios-simulator', appPath: 'build/Tasks.app', device: 'iPhone 17', runtime: '26.0' },
    mac: { platform: 'macos', appPath: 'build/Tasks.app', start: { command: 'node service.ts', ready: 'http://127.0.0.1:4100/' } },
    browsers: app({ baseUrl: 'http://127.0.0.1:4173', targets: { chromium: chromium(), firefox: { browser: 'firefox' } } }),
  },
})

export const unknownPlatform = defineConfig({ apps: { phone: { platform: 'android', appPath: 'build/app.apk' } } }) // type-error TS2322 Type '"android"' is not assignable to type
export const withoutDevice = defineConfig({ apps: { phone: { platform: 'ios-simulator', appPath: 'build/Tasks.app', runtime: '26.0' } } }) // type-error TS2322 Property 'device' is missing
export const nativeAddress = defineConfig({ apps: { mac: { platform: 'macos', appPath: 'build/Tasks.app', baseUrl: 'http://127.0.0.1:4173' } } }) // type-error TS2353 Object literal may only specify known properties
export const unknownBrowser = defineConfig({ apps: { web: { browser: 'safari' } } }) // type-error TS2322 Type '"safari"' is not assignable to type

export const nativeLaunch = defineConfig({ apps: { desk: { platform: 'macos', appPath: 'build/TaskDesk.app', arguments: ['-reset'], environment: { FIXTURE_MODE: 'test' } } } })
export const badNativeArguments = defineConfig({ apps: { desk: { platform: 'macos', appPath: 'build/TaskDesk.app', arguments: [false] } } }) // type-error TS2322 Type 'boolean' is not assignable to type 'string'
export const badNativeEnvironment = defineConfig({ apps: { desk: { platform: 'macos', appPath: 'build/TaskDesk.app', environment: { FLAG: 1 } } } }) // type-error TS2322 Type 'number' is not assignable to type 'string'
