import type { ParseResult, Schema } from '../../protocol/schema.ts'
import type { SupervisorProgram } from '../../shared/process-supervisor.ts'
import type { SupervisorTarget } from './supervisor-pins.ts'
import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { win32 } from 'node:path'
import { errorMessage } from '../../protocol/failures.ts'
import { parse, s } from '../../protocol/schema.ts'
import { isMissingFile } from '../../shared/error-code.ts'
import { maximumSupervisorBinaryBytes, maximumSupervisorSourceBytes, supervisorExecutable, supervisorSourceDigest, supervisorTarget, supervisorVersion } from './supervisor-pins.ts'

// Where the installed supervisor is, and how the runner finds it before its first launch on Windows. This module is
// imported by the process seam every launch goes through, so it imports nothing of the browser, media or native code,
// all of which launch processes themselves.

/** The environment the install and the runner read the cache folder from. */
export type SupervisorEnvironment = Readonly<Record<string, string | undefined>>

/** What `build.json` beside an installed supervisor says of it. */
export type SupervisorRecord = {
  schemaVersion: 1
  version: string
  sourceDigest: string
  target: SupervisorTarget
  rustcVersion: string
  binarySha256: string
  notices: { path: string; sha256: string }[]
  installedAt: string
  installedBy: string
}
const recordSchema: Schema<SupervisorRecord> = s.object({ schemaVersion: s.literal(1), version: s.string(), sourceDigest: s.string(), target: s.enum(['x86_64-pc-windows-msvc']), rustcVersion: s.string(), binarySha256: s.string(), notices: s.array(s.object({ path: s.string(), sha256: s.string() })), installedAt: s.string(), installedBy: s.string() })

/** The command a person runs to install the supervisor. */
export const supervisorInstallCommand: string = 'npx retest install supervisor'

/**
 * The cache folder one supervisor build is installed in: `%LOCALAPPDATA%\retest\supervisor\…`, beside the browsers in
 * the root `cacheFolders` gives on Windows, the one platform it is built for. LOCALAPPDATA is read in any case, as
 * Windows reads it.
 *
 * @example supervisorFolder(process.env, 'x86_64-pc-windows-msvc') // 'C:\\Users\\ada\\AppData\\Local\\retest\\supervisor\\supervisor-0.1.0-x86_64-pc-windows-msvc'
 */
export function supervisorFolder(env: SupervisorEnvironment, target: SupervisorTarget): string | undefined {
  const local = env['LOCALAPPDATA'] ?? Object.entries(env).find(([name]) => name.toUpperCase() === 'LOCALAPPDATA')?.[1]
  if (local === undefined || !win32.isAbsolute(local)) return undefined
  return win32.join(local, 'retest', 'supervisor', `supervisor-${supervisorVersion}-${target}`)
}

/** A `build.json` read as this version's record, or why it is not one; its notices and toolchain are the install's to check. */
export function readSupervisorRecord(path: string, text: string, target: SupervisorTarget): { readonly ok: true; readonly record: SupervisorRecord } | { readonly ok: false; readonly problem: string } {
  let parsed: ParseResult<SupervisorRecord>
  try { parsed = parse(recordSchema, JSON.parse(text)) } catch { return { ok: false, problem: `${path} is not JSON.` } }
  if (!parsed.ok) return { ok: false, problem: `${path} is not a valid supervisor build record.` }
  const record = parsed.value
  if (record.version !== supervisorVersion || record.target !== target || record.sourceDigest !== supervisorSourceDigest) return { ok: false, problem: `${path} names another supervisor version, source or target.` }
  if (!/^[a-f0-9]{64}$/.test(record.binarySha256) || !Number.isFinite(Date.parse(record.installedAt)) || record.installedBy === '') return { ok: false, problem: `${path} has an invalid checksum or installer identity.` }
  return { ok: true, record }
}

/**
 * The supervisor the runner runs, found as it starts its first process on Windows: the executable
 * RETEST_SUPERVISOR_BINARY names, as a developer build is given, or the installed one, read back against its record and
 * its checksum. It reads synchronously, since it runs once, right before a launch that cannot start without it. Throws a
 * sentence that says how to install it.
 *
 * @example const program = locateSupervisor(process.env) // { command: '…\\retest-supervisor.exe', args: [], environment: { SystemRoot: 'C:\\Windows' } }
 */
export function locateSupervisor(env: SupervisorEnvironment): SupervisorProgram {
  const environment = { SystemRoot: env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows' }
  const explicit = env['RETEST_SUPERVISOR_BINARY']
  if (explicit !== undefined && explicit !== '') {
    if (!win32.isAbsolute(explicit)) throw new Error(`RETEST_SUPERVISOR_BINARY is ${explicit}, which is not an absolute path.`)
    if (lstatSync(explicit, { throwIfNoEntry: false })?.isFile() !== true) throw new Error(`RETEST_SUPERVISOR_BINARY names ${explicit}, which is not a file.`)
    return { command: explicit, args: [], environment }
  }
  const target = supervisorTarget()
  if (target === undefined) throw new Error(`retest-supervisor is for Windows x64, and this machine is ${process.platform} ${process.arch}.`)
  const folder = supervisorFolder(env, target)
  if (folder === undefined) throw new Error(`LOCALAPPDATA names no folder, so Retest cannot find retest-supervisor. ${missingSentence}`)
  const executable = win32.join(folder, supervisorExecutable)
  const recordPath = win32.join(folder, 'build.json')
  const recordText = readBounded(recordPath, maximumSupervisorSourceBytes)
  if (recordText === undefined) throw new Error(missingSentence)
  const checked = readSupervisorRecord(recordPath, recordText.toString('utf8'), target)
  if (!checked.ok) throw new Error(`${checked.problem} Remove ${folder}, then run ${supervisorInstallCommand}.`)
  const binary = readBounded(executable, maximumSupervisorBinaryBytes)
  if (binary === undefined) throw new Error(`${executable} is missing. Remove ${folder}, then run ${supervisorInstallCommand}.`)
  if (createHash('sha256').update(binary).digest('hex') !== checked.record.binarySha256) throw new Error(`${executable} does not match its record. Remove ${folder}, then run ${supervisorInstallCommand}.`)
  return { command: executable, args: [], environment }
}

const missingSentence = `Retest needs retest-supervisor on Windows to end everything it starts. Run ${supervisorInstallCommand}.`

// A regular file's bytes, read through one descriptor, or undefined when nothing is there; a file past the bound, or one
// that is not a regular file, is refused by name.
function readBounded(path: string, maximumBytes: number): Buffer | undefined {
  let descriptor: number
  try {
    descriptor = openSync(path, 'r')
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw new Error(`${path} cannot be read: ${errorMessage(error)}`)
  }
  try {
    const stats = fstatSync(descriptor)
    if (!stats.isFile() || stats.size > maximumBytes) throw new Error(`${path} is not a regular file of at most ${maximumBytes} bytes.`)
    const bytes = Buffer.alloc(stats.size)
    let filled = 0
    while (filled < bytes.length) {
      const read = readSync(descriptor, bytes, filled, bytes.length - filled, filled)
      if (read === 0) break
      filled += read
    }
    if (filled !== stats.size) throw new Error(`${path} changed size while it was read.`)
    return bytes
  } finally {
    closeSync(descriptor)
  }
}
