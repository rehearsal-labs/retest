import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { signalGroup } from '../src/browser/chromium-process.ts'

export type ProgramRun = {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  /** Wall-clock milliseconds, from the spawn call to the process closing. */
  readonly startedAt: number
  readonly endedAt: number
  /** The harness ended the program's whole process group when `timeoutMs` ran out. */
  readonly timedOut: boolean
}

export type ProgramOptions = {
  readonly cwd: string
  readonly env?: NodeJS.ProcessEnv
  /** Ends the program, and every process it started, after this long. */
  readonly timeoutMs?: number
}

// Every process group and service still running. The harness ends them all when it exits for any reason, so no
// benchmark child, browser or fixture server outlives it.
const groups = new Set<number>()
const services = new Set<ChildProcess>()
let hooked = false

function endEverything(): void {
  for (const pgid of groups) signalGroup(pgid, 'SIGKILL')
  for (const service of services) service.kill('SIGKILL')
}

function hookExit(): void {
  if (hooked) return
  hooked = true
  process.once('exit', endEverything)
  process.once('SIGINT', () => {
    endEverything()
    process.exit(130)
  })
  process.once('SIGTERM', () => {
    endEverything()
    process.exit(143)
  })
}

/**
 * Runs a program to its end, in a process group of its own, and records when it started and ended. On timeout the
 * whole group is ended, so a hung run leaves no browser or worker behind.
 *
 * @example const run = await runProgram('npm', ['pack'], { cwd: '/work' })
 */
export function runProgram(file: string, args: readonly string[], options: ProgramOptions): Promise<ProgramRun> {
  return new Promise((resolve, reject) => {
    hookExit()
    const startedAt = Date.now()
    const child = spawn(file, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    const pgid = child.pid
    if (pgid !== undefined) groups.add(pgid)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    const timer =
      options.timeoutMs === undefined || pgid === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            signalGroup(pgid, 'SIGKILL')
          }, options.timeoutMs)
    const done = (): void => {
      clearTimeout(timer)
      if (pgid !== undefined) groups.delete(pgid)
    }
    child.once('error', (error) => {
      done()
      reject(error)
    })
    child.once('close', (code, signal) => {
      done()
      resolve({ code, signal, stdout, stderr, startedAt, endedAt: Date.now(), timedOut })
    })
  })
}

/** Throws with the program's output when it did not exit 0. */
export function assertSucceeded(run: ProgramRun, what: string): void {
  if (run.code === 0) return
  const how = run.timedOut ? 'the harness timeout' : run.signal === null ? `exit code ${run.code ?? 'unknown'}` : `signal ${run.signal}`
  throw new Error(`${what} failed with ${how}:\n${run.stdout}\n${run.stderr}`)
}

export type Service = {
  /** The first line the program printed: its address. */
  readonly url: string
  stop(): Promise<void>
}

/**
 * Starts a server program and waits for the address it prints on its first line. The server is ended when the
 * harness exits, however it exits.
 *
 * @example const app = await startService(process.execPath, ['fixtures/task-app/cli.ts'], '/work')
 */
export function startService(file: string, args: readonly string[], cwd: string): Promise<Service> {
  return new Promise((resolve, reject) => {
    hookExit()
    const child = spawn(file, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    services.add(child)
    let buffered = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    const onData = (chunk: string): void => {
      buffered += chunk
      const end = buffered.indexOf('\n')
      if (end === -1) return
      child.stdout.off('data', onData)
      resolve({ url: buffered.slice(0, end).trim(), stop })
    }
    child.stdout.on('data', onData)
    child.once('error', reject)
    child.once('close', (code, signal) => {
      services.delete(child)
      reject(new Error(`${args.join(' ')} ended with ${signal ?? `exit code ${code ?? 'unknown'}`} before it printed its address:\n${stderr}`))
    })

    function stop(): Promise<void> {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
      return new Promise((done) => {
        const force = setTimeout(() => child.kill('SIGKILL'), 2000)
        child.once('close', () => {
          clearTimeout(force)
          done()
        })
        child.kill('SIGTERM')
      })
    }
  })
}
