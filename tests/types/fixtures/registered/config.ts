import { app, chrome, chromium, defineConfig, edge, env } from '@rehearsal-labs/retest'

// What the type check catches while a config is written. None of these configs is registered.
export const channel = chrome({ channel: 'nightly' }) // type-error TS2322 Type '"nightly"' is not assignable to type
export const device = chromium({ emulate: 'Pixel 99' }) // type-error TS2820 Did you mean '"Pixel 9"'?
export const misspelt = edge({ chanel: 'beta' }) // type-error TS2561 Did you mean to write 'channel'?
export const misspeltBeside = edge({ headless: true, chanel: 'beta' }) // type-error TS2322 Type 'string' is not assignable to type 'never'
export const noTouch = chromium({ emulate: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 } }) // type-error TS2322 Property 'touch' is missing
export const envName = env(42) // type-error TS2345 Argument of type 'number' is not assignable to parameter of type 'string'

export const settingsInTarget = app({
  targets: { beta: chrome({ baseUrl: 'http://127.0.0.1:4173' }) }, // type-error TS2322 is not assignable to type 'undefined'
})

export const unknownKey = defineConfig({ apps: { web: chromium() }, retries: 2 }) // type-error TS2322 Type 'number' is not assignable to type 'never'
export const unknownAppKey = app({ targets: { chromium: chromium() }, baseURL: 'http://127.0.0.1:4173' }) // type-error TS2322 Type 'string' is not assignable to type 'never'
export const tagsAsText = defineConfig({ apps: { web: chromium() }, tags: 'smoke' }) // type-error TS2322 Type 'string' is not assignable to type
export const secretAsText = defineConfig({ apps: { web: chromium() }, secrets: { password: 'hunter2' } }) // type-error TS2322 Type 'string' is not assignable to type 'SecretSource'
export const secretAsNumber = defineConfig({ apps: { web: chromium() }, secrets: { code: () => 42 } }) // type-error TS2322 Type 'number' is not assignable to type
export const timeoutText = defineConfig({ apps: { web: chromium() }, timeouts: { action: '5s' } }) // type-error TS2322 Type 'string' is not assignable to type 'number'
export const unknownSecretOrigin = defineConfig({
  apps: { web: chromium() },
  secrets: { token: env('TOKEN') },
  secretOrigins: { tokn: ['https://auth.example.test'] }, // type-error TS2322 is not assignable to type 'never'
})
export const noSecrets = defineConfig({ apps: { web: chromium() }, secretOrigins: { token: [] } }) // type-error TS2322 is not assignable to type 'never'
export const knownReferences = defineConfig({
  apps: { web: chromium(), phone: chromium() },
  defaultApp: 'phone',
  secrets: { token: env('TOKEN') },
  secretOrigins: { token: ['https://auth.example.test'] },
})
