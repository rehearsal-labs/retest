import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { loadavg } from 'node:os'
import { describeMachine } from './machine.ts'

export async function recordingPreflight(output: string): Promise<void> {
  const table = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,%cpu=,rss=,comm='], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  const commandTable = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const selected: { pid: number; command: string }[] = []
  const problems: string[] = []
  for (const line of commandTable.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (match?.[1] === undefined || match[2] === undefined) continue
    const pid = Number(match[1]), command = match[2]
    // Read args in memory to identify actual programs. Never persist unrelated args or credentials.
    const node = /^(?:\S*\/)?node\s/.test(command)
    const test = node && /(?:^|\s)--test(?:\s|=|-)/.test(command)
    const benchmark = node && /(?:^|\s)(?:\S*\/)?benchmarks\/(?:run|recording)\.ts(?:\s|$)/.test(command)
    const browser = command.startsWith('/Applications/Google Chrome') || /^\S*(?:\/firefox|\/MiniBrowser|\/WebKit[^/ ]*)(?:\s|$)/.test(command)
    const ownedBrowser = browser && /--remote-debugging-pipe|--inspector-pipe|retest-(?:chromium|firefox|webkit)-|retest-browser-/.test(command)
    const media = /^(?:\S*\/)?(?:retest-media|ffmpeg)(?:\s|$)/.test(command)
    const simulator = /^\S*\/Simulator\.app\//.test(command)
    if (pid === process.pid) continue
    if (test || benchmark || ownedBrowser || media || simulator) {
      if (pid === 36744 && test) {
        const row = table.split('\n').find(value => new RegExp(`^\\s*${pid}\\s`).test(value))
        if (row?.trim().split(/\s+/)[2] !== '0.0') problems.push('Allowed idle child 36744 is using CPU.')
        selected.push({ pid, command: 'idle node --test child, tests/unit/diagnostics-engines.test.ts; left untouched' })
      } else problems.push(`Active competing process ${pid}, ${test ? 'test' : benchmark ? 'benchmark' : media ? 'media' : simulator ? 'simulator' : 'automation browser'}`)
    }
  }
  await writeFile(output, `${JSON.stringify({ schemaVersion: 1, at: new Date().toISOString(), machine: describeMachine(), load: loadavg(), selected, problems, processSummary: table }, null, 2)}\n`, { flag: 'wx' })
  if (problems.length > 0) throw new Error(problems.join('\n'))
}

if (process.argv[1]?.endsWith('/recording-preflight.ts') === true) {
  const output = process.argv[2]
  if (output === undefined) throw new Error('Pass a new output path.')
  await recordingPreflight(output)
}
