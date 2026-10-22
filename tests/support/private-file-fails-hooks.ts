import { registerHooks } from 'node:module'

// Loaded with --import: every import of src/shared/private-file.ts gets the failing stand-in beside this file.
const standIn = new URL('./private-file-fails.ts', import.meta.url).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/shared/private-file.ts')) return { url: standIn, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
