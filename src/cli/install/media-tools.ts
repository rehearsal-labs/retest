import type { CommandResult } from '../../native/processes.ts'
import type { EncoderProbe, Hello } from '../../media/protocol.ts'
import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { MediaProcess, mediaArguments } from '../../media/client.ts'
import { mediaGreetingProblem } from '../../media/build-identity.ts'
import { describeCommand, runCommand } from '../../native/processes.ts'
import { errorMessage } from '../../protocol/failures.ts'
import { minimumRust } from './media-pins.ts'

export type MediaEnvironment = Readonly<Record<string, string | undefined>>
export type MediaToolOptions = { readonly env: MediaEnvironment; readonly signal?: AbortSignal | undefined; readonly cwd?: string; readonly timeoutMs?: number; readonly environment?: Readonly<Record<string, string>> }
export type MediaToolRunner = (command: string, args: readonly string[], options: MediaToolOptions) => Promise<CommandResult>

/** Tools inherit only the paths needed by the host toolchain, never test or evaluator credentials. */
export const runMediaTool: MediaToolRunner = (command, args, options) => {
  const environment: Record<string, string> = { LC_ALL: 'C' }
  for (const key of ['PATH', 'HOME', 'CARGO_HOME', 'RUSTUP_HOME', 'TMPDIR']) {
    const value = options.env[key]
    if (value !== undefined) environment[key] = value
  }
  return runCommand(command, args, { timeoutMs: options.timeoutMs ?? 10_000, signal: options.signal, ...(options.cwd === undefined ? {} : { cwd: options.cwd }), hiddenVariables: Object.keys(process.env), environment: { ...environment, ...options.environment } })
}

/** An explicit name wins even when it is unusable. PATH lookup never substitutes for it. */
export async function findMediaTool(name: string, env: MediaEnvironment): Promise<string | undefined> {
  const paths = name.includes('/') ? [resolve(name)] : (env['PATH'] ?? '').split(':').filter((part) => isAbsolute(part)).map((part) => join(part, name))
  for (const path of paths) {
    try {
      const found = await realpath(path)
      if (!(await stat(found)).isFile()) continue
      await access(found, constants.X_OK)
      return path
    } catch { continue }
  }
  return undefined
}

export type RustTools = { readonly ok: true; readonly cargo: string; readonly rustc: string; readonly rustcVersion: string; readonly target: string } | { readonly ok: false; readonly message: string }
export const rustFix: string = `Install Rust ${minimumRust} or later with cargo and rustc on PATH, then run npx retest install media. Edition 2024 needs Rust 1.85 or later; this pinned crate needs Rust 1.88 or later.`

export function rustAtLeast(version: string, minimum: string = minimumRust): boolean {
  const match = /^(?:rustc |cargo )?(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(version)
  const wanted = minimum.split('.').map(Number)
  if (match === null) return false
  for (let index = 0; index < 3; index++) {
    const got = Number(match[index + 1])
    const need = wanted[index] ?? 0
    if (got !== need) return got > need
  }
  return true
}

export async function readRustTools(env: MediaEnvironment, signal?: AbortSignal, run: MediaToolRunner = runMediaTool): Promise<RustTools> {
  const cargo = await findMediaTool('cargo', env)
  if (cargo === undefined) return { ok: false, message: `cargo is missing from PATH. ${rustFix}` }
  const rustc = await findMediaTool('rustc', env)
  if (rustc === undefined) return { ok: false, message: `rustc is missing from PATH. ${rustFix}` }
  const cargoVersion = await run(cargo, ['--version'], { env, signal })
  if (cargoVersion.stopped || cargoVersion.timedOut || cargoVersion.cleanupProblems.length > 0) return { ok: false, message: `${describeCommand('cargo --version', cargoVersion)}. ${rustFix}` }
  if (cargoVersion.code !== 0 || !rustAtLeast(cargoVersion.stdout)) return { ok: false, message: `cargo is missing, unreadable or older than Rust ${minimumRust}. ${rustFix}` }
  const rust = await run(rustc, ['-vV'], { env, signal })
  if (rust.code !== 0 || rust.stopped || rust.timedOut || rust.cleanupProblems.length > 0) return { ok: false, message: `${describeCommand('rustc -vV', rust)}. ${rustFix}` }
  const version = rust.stdout.split('\n')[0]?.trim() ?? ''
  const target = /^host: ([a-z0-9_-]+)$/m.exec(rust.stdout)?.[1]
  if (!rustAtLeast(version) || target === undefined) return { ok: false, message: `rustc is unreadable or older than Rust ${minimumRust}. ${rustFix}` }
  return { ok: true, cargo, rustc, rustcVersion: version, target }
}

export type MediaProbe = { readonly ok: true; readonly hello: Hello; readonly encoder?: EncoderProbe } | { readonly ok: false; readonly message: string }

/** Uses the process's own versioned greeting and, when asked, its encoder probe. Every successful start is closed. */
export async function probeMediaBinary(executable: string, ffmpeg: string, target: string, timeoutMs = 15_000, ready = false): Promise<MediaProbe> {
  let media: MediaProcess | undefined
  let answer: MediaProbe
  try {
    media = await MediaProcess.start({ executable, args: mediaArguments({ ffmpeg }), startTimeoutMs: timeoutMs, installHint: 'npx retest install media' })
    const problem = mediaGreetingProblem(executable, media.hello, target)
    answer = problem === undefined ? { ok: true, hello: media.hello, ...(ready ? { encoder: await media.ready(timeoutMs) } : {}) } : { ok: false, message: problem }
  } catch (error) {
    answer = { ok: false, message: `${errorMessage(error)} Run npx retest install media, or set RETEST_MEDIA_BINARY to a matching release binary.` }
  }
  if (media !== undefined) {
    try {
      const exit = await media.close(timeoutMs)
      if (exit.code !== 0 || exit.signal !== null || exit.forced || exit.bye === undefined) answer = { ok: false, message: `${executable} did not close cleanly after its probe. Media cleanup is not proven.` }
    } catch (error) { answer = { ok: false, message: `${executable} probe cleanup failed: ${errorMessage(error)}` } }
  }
  return answer
}
