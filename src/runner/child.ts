import { enableCompileCache } from 'node:module'

// The test file's process. Node compiles every module of an import graph before any of them runs, so the cache goes
// on here, in a file that imports nothing, and the program is loaded only after. The parent shares the cache: both
// use Node's default folder unless NODE_COMPILE_CACHE names one.
enableCompileCache()
await import('./child-program.ts')
