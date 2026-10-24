// One reader or writer of a stand-in world file at a time, across processes: a run end, an end's terminations and a
// test's own changes can each start the stand-in at once, and two of them reading and writing the file together lose a
// change or read half a file.
import { mkdirSync, rmdirSync } from 'node:fs'

const pause = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
const waitLimitMs = 20_000
// The lock is taken, or, on Windows, was just given back and is still being removed, which refuses it a moment longer.
const busy = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY'])

/** Runs `work` while this process alone holds the world file `file`, and gives it back however `work` ends. */
export function withWorld<T>(file: string, work: () => T): T {
  const lock = `${file}.lock`
  retried(() => mkdirSync(lock))
  try {
    return work()
  } finally {
    retried(() => rmdirSync(lock))
  }
}

function retried(step: () => void): void {
  const end = Date.now() + waitLimitMs
  for (;;) {
    try {
      step()
      return
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && typeof error.code === 'string' && busy.has(error.code)) || Date.now() > end) throw error
      Atomics.wait(pause, 0, 0, 2)
    }
  }
}
