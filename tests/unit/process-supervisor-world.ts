// The world process-supervisor-stand-in.ts answers from: the processes it shows and the jobs it holds, kept in a JSON
// file, so tests on every platform drive the supervisor client through the real metadata worker.
import type { SupervisorProgram } from '../../src/shared/process-supervisor.ts'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempFolder } from '../support/temp-folder.ts'
import { withWorld } from './process-supervisor-world-lock.ts'

export type StandInProcess = { pid: number; parentPid: number; startedAt: string; image: string | null; running: boolean; commandLine?: string | null }
export type StandInJob = { members: number[]; handle: number }
export type StandInWorld = {
  runner: number
  processes: StandInProcess[]
  jobs: Record<string, StandInJob>
  nextHandle: number
  calls: string[][]
  /** A refusal for a verb: its sentence, or the sentence and the Windows call behind it. */
  refuse?: Record<string, string | { problem: string; detail: string }>
  print?: Record<string, string>
  exit?: Record<string, number>
  /** Processes the runner's job holds whose parent had ended before their launch was held. */
  orphans?: number[]
  /** Processes an adoption finds already in a job of their own, held by their parent rather than put in the launch's. */
  byParent?: number[]
  /** The console a launch's processes are on: one of their own, Retest's own, or none. Their own by default. */
  console?: 'own' | 'shared' | 'none'
  /** Whether a launch's processes end when they are sent Ctrl+C. */
  stopsOnCtrlC?: boolean
  /** A job whose processes the stand-in will not list. */
  unlisted?: string
  /** A job whose next listing reaches the client `ms` after it was read. */
  slowMembers?: { job: string; ms: number }
}

/** A world file, the program that answers from it, and ways to read and change it between runs. */
export type StandInSupervisor = { program: SupervisorProgram; read: () => StandInWorld; change: (edit: (world: StandInWorld) => void) => void; abandoned: () => number }

const standIn = fileURLToPath(new URL('./process-supervisor-stand-in.ts', import.meta.url))

/** The start the stand-in gives a pid: whole ticks, with the pid's own digits so each one differs. */
export function standInStart(pid: number): string {
  return `1343700900000${pid}`
}

/** A running process of the stand-in's world; `commandLine` is what the supervisor reads it was started with. */
export function standInProcess(pid: number, parentPid: number, image: string | null = `C:\\Apps\\${pid}.exe`, commandLine: string | null = null): StandInProcess {
  return { pid, parentPid, startedAt: standInStart(pid), image, running: true, commandLine }
}

/** A stand-in supervisor whose runner is `runner`, a process of its own, unless `overrides` says otherwise. */
export function standInSupervisor(runner: number, overrides: Partial<StandInWorld> = {}): StandInSupervisor {
  const file = join(tempFolder('supervisor-world-'), 'world.json')
  writeFileSync(file, JSON.stringify({ runner, processes: [standInProcess(runner, 1)], jobs: {}, nextHandle: 100, calls: [], ...overrides }))
  const parsed = (): StandInWorld => JSON.parse(readFileSync(file, 'utf8'))
  return {
    program: { command: process.execPath, args: [standIn, file], environment: {} },
    read: () => withWorld(file, parsed),
    // How many questions a stand-in gave up on, waiting for the world past its client's deadline.
    abandoned: () => {
      try {
        return readFileSync(`${file}.abandoned`, 'utf8').split('\n').filter((line) => line !== '').length
      } catch {
        return 0
      }
    },
    change: (edit) => {
      withWorld(file, () => {
        const current = parsed()
        edit(current)
        writeFileSync(file, JSON.stringify(current))
      })
    },
  }
}
