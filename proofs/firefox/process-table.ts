import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/** One process as `ps` lists it. */
export type ProcessLine = { pid: number; group: number; command: string }

/**
 * Every process on the machine as `ps` lists it: id, process group and whole command line.
 *
 * @example (await processTable()).filter((line) => line.group === firefox.pid)
 */
export async function processTable(): Promise<ProcessLine[]> {
  const { stdout } = await promisify(execFile)('/bin/ps', ['-axww', '-o', 'pid=,pgid=,command='])
  return stdout.split('\n').flatMap((line) => {
    const [, pid, group, command] = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line) ?? []
    if (pid === undefined || group === undefined || command === undefined) return []
    return [{ pid: Number(pid), group: Number(group), command }]
  })
}
