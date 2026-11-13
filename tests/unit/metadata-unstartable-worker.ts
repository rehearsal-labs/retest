import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mock } from 'node:test'

// The metadata worker on a host that has no room for another process: every spawn throws at once, with the system's
// code, as Node's spawn does when fork() fails with ENOMEM. Everything else is the real worker.
mock.method(childProcess, 'spawn', () => { throw Object.assign(new Error('spawn ENOMEM'), { errno: -12, code: 'ENOMEM', syscall: 'spawn' }) })
syncBuiltinESMExports()
await import('../../src/shared/metadata-process-worker.ts')
