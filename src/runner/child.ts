import { enableCompileCache } from 'node:module'

// The test file's process. Node compiles every module of an import graph before any of them runs, so the cache goes
// on here, in a file that imports nothing, and the program is loaded only after. The parent shares the cache: both
// use Node's default folder unless NODE_COMPILE_CACHE names one. On Windows it stays off: Node writes the cache as the
// process exits, and from an empty cache that write took longer there than the second the runner gives a process it
// asked to close, and moved earlier, longer than collection's budget.
if (process.platform !== 'win32') enableCompileCache()
await import('./child-program.ts')
