import type { CommandResult } from '../../native/processes.ts'
import type { SupervisorEnvironment } from './supervisor-locate.ts'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { describeCommand } from '../../native/processes.ts'
import { errorCode } from '../../shared/error-code.ts'
import { rustAtLeast } from './media-tools.ts'
import { minimumSupervisorRust, supervisorVersion } from './supervisor-pins.ts'
import { supervisorInstallCommand } from './supervisor-locate.ts'

export type SupervisorToolOptions = { readonly env: SupervisorEnvironment; readonly signal?: AbortSignal | undefined; readonly cwd?: string; readonly timeoutMs?: number; readonly environment?: Readonly<Record<string, string>> }
export type SupervisorToolRunner = (command: string, args: readonly string[], options: SupervisorToolOptions) => Promise<CommandResult>

// What cargo and the MSVC linker need to find themselves and their caches on Windows, and nothing that carries a
// credential: no test or evaluator variable reaches the build.
const toolVariables = ['PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'TEMP', 'TMP', 'CARGO_HOME', 'CARGO_NET_OFFLINE', 'RUSTUP_HOME', 'RUSTUP_TOOLCHAIN', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'HOME', 'TMPDIR']

// How much a build tool may print before it is stopped; a release build of the crate prints a few kilobytes.
const toolOutputLimit = 16 * 1024 * 1024

/**
 * Runs a build tool with only the variables `toolVariables` names, whatever case the environment spells them in. This
 * is the one start on Windows no job holds, since the job's supervisor is what it builds: the tool is held by Node's own
 * handle on it, which ends it at the deadline or the stop and lets no other process stand behind its pid, and the
 * compilers it starts finish their own work. Nothing a test starts runs this way.
 */
export const runSupervisorTool: SupervisorToolRunner = (command, args, options) => {
  const environment: Record<string, string> = {}
  for (const name of toolVariables) {
    const value = valueOf(options.env, name)
    if (value !== undefined) environment[name] = value
  }
  const { promise, resolve: settle } = Promise.withResolvers<CommandResult>()
  const ended = { code: null, signal: null, stdout: '', stderr: '', timedOut: false, stopped: false, started: true, cleanupProblems: [] }
  if (options.signal?.aborted === true) return Promise.resolve({ ...ended, stopped: true, started: false })
  execFile(command, [...args], { env: { ...environment, ...options.environment }, ...(options.cwd === undefined ? {} : { cwd: options.cwd }), timeout: options.timeoutMs ?? 10_000, maxBuffer: toolOutputLimit, windowsHide: true, encoding: 'utf8', ...(options.signal === undefined ? {} : { signal: options.signal }) }, (error, stdout, stderr) => {
    if (error === null) return settle({ ...ended, code: 0, stdout, stderr })
    if (errorCode(error) === 'ENOENT') return settle({ ...ended, code: 127, stderr: error.message, started: false })
    const stopped = options.signal?.aborted === true
    const exitCode = 'code' in error && typeof error.code === 'number' ? error.code : null
    const signal = 'signal' in error && typeof error.signal === 'string' ? error.signal : null
    settle({ ...ended, code: exitCode, signal: isSignal(signal) ? signal : null, stdout, stderr, stopped, timedOut: !stopped && 'killed' in error && error.killed === true })
  })
  return promise
}

function isSignal(name: string | null): name is NodeJS.Signals {
  return name !== null && /^SIG[A-Z0-9]+$/.test(name)
}

// Windows treats variable names without regard to case; a copied environment does not.
function valueOf(env: SupervisorEnvironment, name: string): string | undefined {
  const exact = env[name]
  if (exact !== undefined) return exact
  const wanted = name.toLowerCase()
  return Object.entries(env).find(([key]) => key.toLowerCase() === wanted)?.[1]
}

/**
 * A tool on PATH, by its own name, or by that name and `.exe` on Windows. A name with a folder in it is taken as given.
 *
 * @example await findSupervisorTool('cargo', process.env) // 'C:\\Users\\ada\\.cargo\\bin\\cargo.exe'
 */
export async function findSupervisorTool(name: string, env: SupervisorEnvironment, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  const names = platform === 'win32' && !name.toLowerCase().endsWith('.exe') ? [`${name}.exe`, name] : [name]
  const paths = isAbsolute(name) || name.includes('/') || name.includes('\\')
    ? [resolve(name)]
    : (valueOf(env, 'PATH') ?? '').split(delimiter).filter((part) => isAbsolute(part)).flatMap((part) => names.map((each) => join(part, each)))
  for (const path of paths) {
    try {
      if (!(await stat(path)).isFile()) continue
      await access(path, constants.X_OK)
      return path
    } catch { continue }
  }
  return undefined
}

export type SupervisorRust = { readonly ok: true; readonly cargo: string; readonly rustc: string; readonly rustcVersion: string; readonly target: string } | { readonly ok: false; readonly message: string }
export const supervisorRustFix: string = `Install Rust ${minimumSupervisorRust} or later with the MSVC toolchain, with cargo and rustc on PATH, then run ${supervisorInstallCommand}.`

/** cargo and rustc on PATH, new enough, and the target rustc builds for by default. */
export async function readSupervisorRust(env: SupervisorEnvironment, signal: AbortSignal | undefined, run: SupervisorToolRunner = runSupervisorTool): Promise<SupervisorRust> {
  const cargo = await findSupervisorTool('cargo', env)
  if (cargo === undefined) return { ok: false, message: `cargo is missing from PATH. ${supervisorRustFix}` }
  const rustc = await findSupervisorTool('rustc', env)
  if (rustc === undefined) return { ok: false, message: `rustc is missing from PATH. ${supervisorRustFix}` }
  const cargoVersion = await run(cargo, ['--version'], { env, signal })
  if (cargoVersion.stopped || cargoVersion.timedOut || cargoVersion.cleanupProblems.length > 0) return { ok: false, message: `${describeCommand('cargo --version', cargoVersion)}. ${supervisorRustFix}` }
  if (cargoVersion.code !== 0 || !rustAtLeast(cargoVersion.stdout, minimumSupervisorRust)) return { ok: false, message: `cargo is unreadable or older than Rust ${minimumSupervisorRust}. ${supervisorRustFix}` }
  const rust = await run(rustc, ['-vV'], { env, signal })
  if (rust.code !== 0 || rust.stopped || rust.timedOut || rust.cleanupProblems.length > 0) return { ok: false, message: `${describeCommand('rustc -vV', rust)}. ${supervisorRustFix}` }
  const version = rust.stdout.split(/\r?\n/)[0]?.trim() ?? ''
  const target = /^host: ([a-z0-9_-]+)\r?$/m.exec(rust.stdout)?.[1]
  if (!rustAtLeast(version, minimumSupervisorRust) || target === undefined) return { ok: false, message: `rustc is unreadable or older than Rust ${minimumSupervisorRust}. ${supervisorRustFix}` }
  return { ok: true, cargo, rustc, rustcVersion: version, target }
}

/**
 * Asks a built supervisor for its version line, which must name this version and the target it was built for.
 *
 * @example await probeSupervisor(executable, 'x86_64-pc-windows-msvc', { env: process.env }) // undefined
 */
export async function probeSupervisor(executable: string, target: string, options: SupervisorToolOptions, run: SupervisorToolRunner = runSupervisorTool): Promise<string | undefined> {
  const result = await run(executable, ['--version'], options)
  if (result.code !== 0 || result.stopped || result.timedOut || result.cleanupProblems.length > 0) return `${describeCommand('retest-supervisor --version', result)}. Nothing was installed.`
  const line = result.stdout.trim()
  if (!line.startsWith(`retest-supervisor ${supervisorVersion} (${target},`)) return `The built supervisor names itself ${JSON.stringify(line.slice(0, 200))}, not retest-supervisor ${supervisorVersion} for ${target}. Nothing was installed.`
  return undefined
}
