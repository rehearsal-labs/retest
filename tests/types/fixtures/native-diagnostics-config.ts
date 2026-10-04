import { app, chromium, defineConfig } from '@rehearsal-labs/retest'

// A native target says where its diagnostics come from: its standard output, the default, or none, and a network file
// with the client name its records give the app. The declaration has the shape the network source reads, and a browser
// takes none. A key the declaration does not have is refused by the loader, not by these types.
export const declared = defineConfig({
  apps: {
    phone: { platform: 'ios-simulator', appPath: 'build/TaskPhone.app', device: 'iPhone 17', runtime: '26.5', diagnostics: { network: { path: 'service/network.jsonl', client: 'ios' } } },
    desk: { platform: 'macos', appPath: 'build/TaskDesk.app', diagnostics: { logs: 'stdout', network: { path: 'service/network.jsonl', client: 'macos' } } },
    quiet: { platform: 'macos', appPath: 'build/TaskDesk.app', diagnostics: { logs: 'none' } },
    tablets: app({ targets: { air: { platform: 'ios-simulator', appPath: 'build/TaskPhone.app', device: 'iPad Air 11-inch (M3)', runtime: '26.5', diagnostics: { logs: 'stdout' } } } }),
  },
})

export const otherLogs = defineConfig({ apps: { desk: { platform: 'macos', appPath: 'build/TaskDesk.app', diagnostics: { logs: 'stderr' } } } }) // type-error TS2322 Type '"stderr"' is not assignable to type
export const otherClient = defineConfig({ apps: { phone: { platform: 'ios-simulator', appPath: 'build/TaskPhone.app', device: 'iPhone 17', runtime: '26.5', diagnostics: { network: { path: 'network.jsonl', client: 'web' } } } } }) // type-error TS2322 Type '"web"' is not assignable to type
export const withoutPath = defineConfig({ apps: { desk: { platform: 'macos', appPath: 'build/TaskDesk.app', diagnostics: { network: { client: 'macos' } } } } }) // type-error TS2322 Property 'path' is missing in type '{ client: "macos"; }'
export const onBrowser = defineConfig({ apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173', diagnostics: { logs: 'stdout' } }) } }) // type-error TS2322 Type '{ logs: string; }' is not assignable to type 'never'
