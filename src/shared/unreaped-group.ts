import { readdirSync, readFileSync } from 'node:fs'

/** The state letter and process group of one process, as `/proc/<pid>/stat` gives them on Linux. */
export type ProcessStat = { state: string; group: number }

/**
 * Reads the state and process group from a `/proc/<pid>/stat` line. The command name sits in parentheses and
 * may hold spaces and parentheses itself, so the fields are counted from its last closing parenthesis.
 *
 * @example readProcessStat('42 (chrome) Z 1 40 40 0 -1') // { state: 'Z', group: 40 }
 */
export function readProcessStat(line: string): ProcessStat | undefined {
  const end = line.lastIndexOf(')')
  if (end === -1) return undefined
  const [state, , group] = line.slice(end + 2).split(' ')
  const groupId = Number(group)
  if (state === undefined || state === '' || !Number.isSafeInteger(groupId)) return undefined
  return { state, group: groupId }
}

/**
 * Whether a process group still has members and every one of them has exited, waiting only for the process that
 * adopted it to reap it. Signals reach such a group, yet nothing in it runs. False where there is no `/proc`.
 *
 * @example onlyUnreaped(4242, procStats) // true when every process of group 4242 is a zombie
 */
export function onlyUnreaped(groupId: number, stats: () => readonly string[]): boolean {
  const members = stats()
    .map(readProcessStat)
    .filter((stat) => stat?.group === groupId)
  return members.length > 0 && members.every((stat) => stat?.state === 'Z')
}

/** Every process's `/proc/<pid>/stat` line on Linux, and none elsewhere. A process that ends while being read is skipped. */
export function procStats(): string[] {
  if (process.platform !== 'linux') return []
  const lines: string[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      lines.push(readFileSync(`/proc/${name}/stat`, 'utf8'))
    } catch {
      // It ended between listing /proc and reading it, which leaves nothing to count.
    }
  }
  return lines
}
