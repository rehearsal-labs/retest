import type { DiagnosticsConfig } from '@rehearsal-labs/retest/runner'
import { chrome, defineConfig } from '@rehearsal-labs/retest'

// A config's diagnostics block, and the same block a program passes as RunOptions.diagnostics.
export const accepted = defineConfig({
  apps: { web: chrome({ baseUrl: 'http://127.0.0.1:4173' }) },
  diagnostics: { strict: { runtimeErrors: true, httpErrors: true, allow: ['/favicon.ico'] }, requireComplete: true, limits: { requests: 500, textLength: undefined } },
})

export const fromHost: DiagnosticsConfig = { capture: false }

export const wordForFlag = defineConfig({ apps: { web: chrome() }, diagnostics: { strict: { runtimeErrors: 'yes' } } }) // type-error TS2322 Type 'string' is not assignable to type 'boolean | undefined'
export const unknownLimit = defineConfig({ apps: { web: chrome() }, diagnostics: { limits: { bodies: 5 } } }) // type-error TS2353 Object literal may only specify known properties
export const patternToAllow = defineConfig({ apps: { web: chrome() }, diagnostics: { strict: { consoleErrors: true, allow: [/favicon/] } } }) // type-error TS2322 Type 'RegExp' is not assignable to type 'string'
