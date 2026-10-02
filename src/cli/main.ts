#!/usr/bin/env node
import { enableCompileCache } from 'node:module'

// Node compiles every module of an import graph before any of them runs, so the cache goes on here, in a file
// that imports nothing, and the program is loaded only after. NODE_DISABLE_COMPILE_CACHE=1 turns it off.
enableCompileCache()
await import('./program.ts')
