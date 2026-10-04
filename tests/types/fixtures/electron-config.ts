import { app, defineConfig, electron } from '@rehearsal-labs/retest'

// An Electron app type-checks with its binary, its app, its arguments, a data folder and the app's start command.
export const accepted = defineConfig({
  apps: {
    desktop: electron({ executablePath: 'electron/dist/Electron.app/Contents/MacOS/Electron', appPath: 'desktop', args: ['--tasks=3'], userDataDir: '.data' }),
    served: electron({ executablePath: '/opt/Electron', appPath: 'desktop', start: { command: 'node service.ts', ready: 'http://127.0.0.1:4100/' } }),
    builds: app({ targets: { stable: electron({ executablePath: '/opt/stable/Electron', appPath: 'desktop' }), next: { browser: 'electron', executablePath: '/opt/next/Electron', appPath: 'desktop' } } }),
  },
})

// It has no address, takes no browser setting, needs its app, and a key it does not know is a mistake.
export const typo = electron({ executablePath: '/opt/Electron', appPath: 'desktop', appPth: 'desktop' }) // type-error TS2322 Type 'string' is not assignable to type 'never'
export const address = electron({ executablePath: '/opt/Electron', appPath: 'desktop', baseUrl: 'http://127.0.0.1:4173' }) // type-error TS2322 Type 'string' is not assignable to type 'never'
export const addressOnItsOwn = defineConfig({ apps: { desktop: { browser: 'electron', executablePath: '/opt/Electron', appPath: 'desktop', baseUrl: 'http://127.0.0.1:4173' } } }) // type-error TS2322 baseUrl: string; }' is not assignable to type
export const browserSetting = electron({ executablePath: '/opt/Electron', appPath: 'desktop', headless: false }) // type-error TS2322 Type 'false' is not assignable to type 'never'
export const withoutApp = electron({ executablePath: '/opt/Electron' }) // type-error TS2345 Argument of type '{ executablePath: string; }' is not assignable to parameter of type 'ElectronOptions
export const notArguments = electron({ executablePath: '/opt/Electron', appPath: 'desktop', args: '--tasks=3' }) // type-error TS2322 Type 'string' is not assignable to type 'readonly string[]'
