import type { SupervisorInspection, SupervisorEnvironment, SupervisorRecord } from './supervisor-record.ts'
import type { SupervisorTarget } from './supervisor-pins.ts'
import type { SupervisorToolRunner } from './supervisor-tools.ts'
import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describeCommand } from '../../native/processes.ts'
import { errorMessage } from '../../protocol/failures.ts'
import { Deadline } from '../../protocol/deadline.ts'
import { openRegularFile, readFileSha256, readRecordText } from '../../shared/regular-file.ts'
import { takeInstallLock } from './lock.ts'
import { maximumSupervisorBinaryBytes, supervisorExecutable, supervisorSourceDigest, supervisorSourceFiles, supervisorTarget, supervisorVersion } from './supervisor-pins.ts'
import { checkSupervisorSource, inspectSupervisor, supervisorFolder, supervisorInstallCommand, supervisorLockPath, supervisorNoticePins, supervisorPackageRoot } from './supervisor-record.ts'
import { probeSupervisor, readSupervisorRust, runSupervisorTool } from './supervisor-tools.ts'

export type SupervisorInstallOptions = {
  readonly env: SupervisorEnvironment; readonly signal: AbortSignal; readonly version: string; readonly report: (line: string) => void
  readonly offline?: boolean; readonly packageRoot?: string; readonly target?: SupervisorTarget; readonly run?: SupervisorToolRunner
}
export type SupervisorInstallResult = { readonly ok: true; readonly action: 'installed' | 'already_installed'; readonly inspection: SupervisorInspection } | { readonly ok: false; readonly message: string; readonly stopped: boolean }

/** The sentence `retest install supervisor` gives where no supervisor is needed. */
export const supervisorNotNeeded: string = 'retest-supervisor is for Windows. On macOS and Linux Retest needs nothing installed to end what it starts.'

/**
 * Builds the shipped supervisor crate with `cargo build --release --locked` into the cache, under the install lock, and
 * records it. Nothing is downloaded but the pinned crates cargo fetches, and none with `offline`. A build already
 * recorded is left as it is; a damaged cache is refused, never repaired.
 *
 * @example await installSupervisor({ env: process.env, signal, version: '0.3.0', report: console.log })
 */
export async function installSupervisor(options: SupervisorInstallOptions): Promise<SupervisorInstallResult> {
  const refuse = (message: string): SupervisorInstallResult => ({ ok: false, message, stopped: options.signal.aborted })
  const target = options.target ?? supervisorTarget()
  if (target === undefined) return refuse(process.platform === 'win32' ? `Retest builds retest-supervisor for Windows x64 only, and this machine is Windows ${process.arch}.` : supervisorNotNeeded)
  const folder = supervisorFolder(options.env, target)
  if (folder === undefined) return refuse(`Retest has no cache folder here, so it cannot install retest-supervisor. Set the folder Retest caches into, then run ${supervisorInstallCommand}.`)
  const root = options.packageRoot ?? supervisorPackageRoot()
  const sourceProblem = await checkSupervisorSource(root, { signal: options.signal })
  if (sourceProblem !== undefined) return refuse(sourceProblem)
  const lock = await takeInstallLock(supervisorLockPath(folder), { signal: options.signal })
  if (!lock.ok) return { ok: false, message: lock.message, stopped: lock.stopped === true }
  let result: SupervisorInstallResult
  let cleanupProblem: string | undefined
  const staging = `${folder}.staging-${process.pid}-${randomUUID()}`
  try {
    result = await installLocked(options, target, folder, root, staging)
  } catch (error) { result = refuse(`The supervisor install failed: ${errorMessage(error)} Nothing was installed.`) }
  finally {
    try { await rm(staging, { recursive: true, force: true, maxRetries: 3 }) }
    catch (error) { cleanupProblem = `Supervisor staging cleanup failed at ${staging}: ${errorMessage(error)}.` }
    finally {
      const problem = await lock.release()
      if (problem !== undefined) options.report(problem)
    }
  }
  if (cleanupProblem !== undefined) return result.ok
    ? refuse(`retest-supervisor ${result.action === 'installed' ? 'was installed' : 'was already installed'}, but cleanup is not proven. ${cleanupProblem}`)
    : { ...result, message: `${result.message} ${cleanupProblem}` }
  return result
}

async function installLocked(options: SupervisorInstallOptions, target: SupervisorTarget, folder: string, root: string, staging: string): Promise<SupervisorInstallResult> {
  const refuse = (message: string): SupervisorInstallResult => ({ ok: false, message, stopped: options.signal.aborted })
  const before = await inspectSupervisor(options.env, { target, verify: true, signal: options.signal })
  if (before?.state === 'installed') return { ok: true, action: 'already_installed', inspection: before }
  if (before !== undefined && before.state !== 'missing') return refuse(`${before.problems.join(' ')} Remove ${folder} and run ${supervisorInstallCommand} again.`)
  if (options.signal.aborted) return refuse('The supervisor install was stopped before it built anything.')
  const run = options.run ?? runSupervisorTool
  const tools = await readSupervisorRust(options.env, options.signal, run)
  if (!tools.ok) return refuse(tools.message)
  if (tools.target !== target) return refuse(`rustc builds for ${tools.target}, and this machine needs ${target}. Select the matching Rust host toolchain, then run ${supervisorInstallCommand}.`)
  await mkdir(staging, { recursive: true })
  const source = join(staging, 'source')
  for (const file of supervisorSourceFiles) {
    const from = join(root, ...file.path.split('/'))
    const to = join(source, ...file.path.split('/'))
    const reading = await readRecordText(from)
    if (reading.kind !== 'text') return refuse(`${from} cannot be copied: ${reading.kind === 'missing' ? 'missing' : reading.problem}.`)
    await mkdir(dirname(to), { recursive: true })
    await writeFile(to, reading.text, { flag: 'wx' })
  }
  const copiedProblem = await checkSupervisorSource(source, { signal: options.signal })
  if (copiedProblem !== undefined) return refuse(copiedProblem)
  const targetDir = join(staging, 'target')
  const args = ['build', '--release', '--locked', ...(options.offline === true ? ['--offline'] : []), '--manifest-path', join(source, 'supervisor', 'Cargo.toml'), '--target', target, '--target-dir', targetDir]
  options.report(`Building retest-supervisor ${supervisorVersion} with ${tools.rustcVersion}; Cargo.lock is pinned.`)
  const built = await run(tools.cargo, args, { env: options.env, signal: options.signal, cwd: source, timeoutMs: 30 * 60_000, environment: { RUSTC: tools.rustc, CARGO_TARGET_DIR: targetDir } })
  const afterProblem = await checkSupervisorSource(source, { signal: options.signal })
  if (afterProblem !== undefined) return refuse(`The build changed the pinned source or Cargo.lock. ${afterProblem}`)
  if (built.code !== 0 || built.stopped || built.timedOut || built.cleanupProblems.length > 0) return refuse(`${describeCommand('cargo build --release --locked', built)}. Nothing was installed.`)
  const executable = join(staging, supervisorExecutable)
  const placed = await copyBinary(join(targetDir, target, 'release', supervisorExecutable), executable)
  if (placed !== undefined) return refuse(placed)
  await rm(source, { recursive: true, maxRetries: 3 })
  await rm(targetDir, { recursive: true, maxRetries: 3 })
  if (options.signal.aborted) return refuse('The supervisor install was stopped after its build. Nothing was installed.')
  const probe = await probeSupervisor(executable, target, { env: options.env, signal: options.signal }, run)
  if (probe !== undefined) return refuse(probe)
  const hash = await readFileSha256(executable, { maximumBytes: maximumSupervisorBinaryBytes, deadline: new Deadline(15_000, { signal: options.signal }) })
  if (hash.kind === 'other') return refuse(hash.problem)
  if (hash.kind !== 'file') return refuse('The built supervisor cannot be checked as a regular file.')
  for (const file of supervisorSourceFiles.filter((file) => file.path === 'LICENSE' || file.path === 'supervisor/NOTICES')) {
    const read = await readRecordText(join(root, ...file.path.split('/')))
    if (read.kind !== 'text') return refuse(`The pinned licence ${file.path} cannot be read.`)
    await writeFile(join(staging, file.path === 'LICENSE' ? 'LICENSE' : 'THIRD-PARTY-NOTICES.txt'), read.text, { flag: 'wx' })
  }
  const sourceProblem = await checkSupervisorSource(root, { signal: options.signal })
  if (sourceProblem !== undefined) return refuse(sourceProblem)
  const record: SupervisorRecord = { schemaVersion: 1, version: supervisorVersion, sourceDigest: supervisorSourceDigest, target, rustcVersion: tools.rustcVersion, binarySha256: hash.sha256, notices: supervisorNoticePins(), installedAt: new Date().toISOString(), installedBy: options.version }
  await writeFile(join(staging, 'build.json'), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
  await mkdir(dirname(folder), { recursive: true })
  await rename(staging, folder)
  const after = await inspectSupervisor(options.env, { target, verify: true, signal: options.signal })
  return after?.state === 'installed' ? { ok: true, action: 'installed', inspection: after } : refuse(`The supervisor folder did not read as installed: ${after?.problems.join(' ') ?? 'no cache'}.`)
}

// The built binary, copied from the one descriptor it was checked through, within the binary bound.
async function copyBinary(from: string, to: string): Promise<string | undefined> {
  const opened = await openRegularFile(from)
  if (opened.kind !== 'opened') return `${from} is not a readable regular supervisor binary: ${opened.kind}.`
  try {
    if (opened.size > maximumSupervisorBinaryBytes) return `${from} is larger than ${maximumSupervisorBinaryBytes} bytes.`
    const bytes = Buffer.alloc(opened.size + 1)
    let filled = 0
    while (filled < bytes.length) {
      const read = await opened.handle.read(bytes, filled, bytes.length - filled, null)
      if (read.bytesRead === 0) break
      filled += read.bytesRead
    }
    if (filled !== opened.size) return `${from} changed size while it was copied.`
    await writeFile(to, bytes.subarray(0, filled), { flag: 'wx', mode: 0o755 })
    return undefined
  } finally { await opened.handle.close() }
}
