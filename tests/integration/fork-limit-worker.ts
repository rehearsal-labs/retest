import type { MetadataProcessRequest } from '../../src/shared/metadata-process.ts'
import childProcess from 'node:child_process'
import { readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mock } from 'node:test'
import { parentPort } from 'node:worker_threads'

// The RAM and swap of the Linux host this worker stands in for: far less than any real host has, so that the few buffers
// a test leaves mapped reach it as a long run's spent buffers reach a real host's.
const forkLimitBytes = 192 * 1024 * 1024

// The metadata worker on a Linux host with the default heuristic overcommit, whose RAM and swap are `forkLimitBytes`.
// There fork() fails with ENOMEM while any one accountable mapping of the forking process is larger than RAM and swap,
// and Node's spawn then throws at once. The worker keeps every query it is handed, as a worker isolate that has not
// yet collected them does, so each query's output buffer stays mapped after its reading ends. Everything else is the
// real worker.
const kept: MetadataProcessRequest[] = []
parentPort?.on('message', (request: MetadataProcessRequest) => { kept.push(request) })
const { spawn } = childProcess
mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => {
  if (largestAccountableMapping() > forkLimitBytes) throw Object.assign(new Error('spawn ENOMEM'), { errno: -12, code: 'ENOMEM', syscall: 'spawn' })
  return spawn(...args)
})
syncBuiltinESMExports()
await import('../../src/shared/metadata-process-worker.ts')

// The largest mapping of this process that the kernel charges against RAM and swap: one its VmFlags mark `ac`.
function largestAccountableMapping(): number {
  let largest = 0
  let size = 0
  for (const line of readFileSync('/proc/self/smaps', 'utf8').split('\n')) {
    const range = /^([0-9a-f]+)-([0-9a-f]+) /.exec(line)
    if (range !== null) {
      size = Number.parseInt(range[2] ?? '0', 16) - Number.parseInt(range[1] ?? '0', 16)
      continue
    }
    if (line.startsWith('VmFlags:') && line.split(' ').includes('ac')) largest = Math.max(largest, size)
  }
  return largest
}
