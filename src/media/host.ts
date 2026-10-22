import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'

// What finding and starting the media programs differs in on Windows, decided once: a program is a file named with
// `.exe`, variable names are one name whatever their case, so `Path` is `PATH`, and programs expect the system
// folder's variable and name their temporary folder TEMP and TMP.
const windows = process.platform === 'win32'

/**
 * The value of a variable as the host reads it. A plain record copied from a Windows environment can hold `Path`
 * where a caller asks for `PATH`.
 *
 * @example hostVariable({ Path: 'C:\\Windows' }, 'PATH') // 'C:\\Windows' on Windows, undefined elsewhere
 */
export function hostVariable(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  if (!windows || env[name] !== undefined) return env[name]
  const upper = name.toUpperCase()
  const found = Object.keys(env).find((key) => key.toUpperCase() === upper)
  return found === undefined ? undefined : env[found]
}

/**
 * The file a program name is found as on PATH: the name itself, or on Windows the name with `.exe` when it has no
 * extension of its own.
 *
 * @example programFileName('ffmpeg') // 'ffmpeg.exe' on Windows, 'ffmpeg' elsewhere
 */
export function programFileName(name: string): string {
  return windows && extname(name) === '' ? `${name}.exe` : name
}

/** The variables the media process and its encoder start with: where programs and temporary files are. */
export const encoderVariables: readonly string[] = windows ? ['PATH', 'SystemRoot', 'TEMP', 'TMP'] : ['PATH', 'TMPDIR']

/** The variables Rust's tools start with: where programs, the user's home, the toolchains and temporary files are. */
export const toolchainVariables: readonly string[] = windows
  ? ['PATH', 'HOME', 'USERPROFILE', 'CARGO_HOME', 'RUSTUP_HOME', 'TEMP', 'TMP']
  : ['PATH', 'HOME', 'CARGO_HOME', 'RUSTUP_HOME', 'TMPDIR']

/**
 * Where a source build of the media binary puts Cargo's output. The MSVC linker cannot write a path longer than 260
 * characters, and a build script's path beneath a cache's staging folder can be longer, so on Windows the build goes to
 * a short folder of its own in the system's temporary folder; elsewhere it stays in the staging folder it builds for.
 *
 * @example mediaBuildFolder('C:\\Users\\ada\\AppData\\Local\\retest\\media\\media-0.1.0.staging-1-x') // 'C:\\Users\\ada\\AppData\\Local\\Temp\\retest-media-1-9f2c41aa'
 */
export function mediaBuildFolder(staging: string): string {
  return windows ? join(tmpdir(), `retest-media-${process.pid}-${randomBytes(4).toString('hex')}`) : join(staging, 'target')
}

/**
 * A program that exists on every host and is not ffmpeg, for a media process started only to greet: its encoder probe
 * fails at once and nothing is encoded. Node itself stands in on Windows, which has no `/usr/bin/false`.
 */
export const notAnEncoder: string = windows ? process.execPath : '/usr/bin/false'
