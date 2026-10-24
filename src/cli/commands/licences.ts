import type { BuildPin, CacheFolders, LicenceFile } from '../../browser/builds.ts'
import type { Command } from '../command.ts'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { buildEngines, buildPlatform, describePin, findPin, inspectBuild, cacheFolders, pinnedBuilds, readBundledLicence, readInstalledRecord, treeFolder } from '../../browser/builds.ts'
import { readBuildRecord } from '../../native/executors.ts'
import { runCommand } from '../../native/processes.ts'
import { interruptedExitCode } from '../../runner/outcome.ts'
import { describeRefusal, openRegularFile } from '../../shared/regular-file.ts'
import { listWords } from '../../shared/list-words.ts'
import { parseArguments } from '../arguments.ts'
import { CliError, UsageError } from '../errors.ts'
import { licenceSummary } from '../install/report.ts'
import { readZipMember } from '../install/zip-member.ts'
import { suggest } from '../suggest.ts'

export const licencesCommand: Command = {
  name: 'licences',
  usage: '[engine]',
  summary: 'Read the licence notices kept with a build',
  description: [
    'With no engine, lists the pinned builds that carry licence notices.',
    'Name an engine to print its notice texts, followed by its source and any patches pointers.',
    'Reads the installed build, or the notices shipped with Retest when the build is not installed.',
    'Checks the notice bytes before printing them. Missing or changed files are named.',
    'If a notice ships only in the build, install that build to read it here. Nothing is downloaded.',
  ].join('\n'),
  options: {},
  notes: 'Exit codes: 0 all notice texts are available, 2 a notice cannot be read or the engine is unknown, 130 interrupted, 143 stopped by SIGTERM.',
  async run(args, dependencies) {
    if (dependencies.signal.aborted) return interruptedExitCode(dependencies.signal)
    const { positionals } = parseArguments({}, args)
    if (positionals.length > 1) throw new UsageError('licences takes one engine at most.')
    const [name] = positionals
    if (name === undefined) {
      dependencies.stdout.write(listLicencePins(pinnedBuilds))
      return 0
    }
    const engine = buildEngines.find(candidate => candidate === name)
    if (engine === undefined) {
      const guess = suggest(name, buildEngines)
      throw new UsageError(`Unknown engine ${name}.${guess === undefined ? ` The engines are ${listWords(buildEngines, 'and')}.` : ` Did you mean ${guess}?`}`)
    }
    const platform = buildPlatform()
    const pin = (platform === undefined ? undefined : findPin(engine, platform)) ?? pinnedBuilds.find(candidate => candidate.engine === engine)
    if (pin === undefined) throw new CliError(`Retest pins no ${engine} build.`)
    const result = await readLicenceNotices(pin, cacheFolders(dependencies.env), dependencies.signal)
    if (dependencies.signal.aborted) return interruptedExitCode(dependencies.signal)
    dependencies.stdout.write(result.text)
    return result.complete ? 0 : 2
  },
}

/** Lists notice-bearing pins on every pinned platform, so discovery needs neither a build nor a cache. */
export function listLicencePins(pins: readonly BuildPin[]): string {
  const lines = ['Licence notices are kept with these pinned builds:']
  for (const pin of pins) {
    const summary = licenceSummary(pin)
    if (summary !== undefined) lines.push(`  ${pin.engine} (${pin.platform})  ${describePin(pin)}: ${summary}`)
  }
  lines.push('Run `retest licences <engine>` to read them.')
  return `${lines.join('\n')}\n`
}

export type LicenceNotices = { readonly text: string; readonly complete: boolean }

/** Reads only local, checksum-checked bytes. An installed build's missing notice never falls back to a bundled copy. */
export async function readLicenceNotices(pin: BuildPin, folders: CacheFolders | undefined, signal: AbortSignal): Promise<LicenceNotices> {
  const lines = [`Licence notices for ${describePin(pin)} (${pin.platform})`, '']
  const problems: string[] = []
  const inspection = folders === undefined ? undefined : await inspectBuild(pin, folders)
  const installed = inspection?.state === 'installed'
  if (inspection !== undefined && inspection.state !== 'missing' && !installed) {
    return { complete: false, text: `${[...lines, ...inspection.problems, '', ...sourcePointers(pin)].join('\n')}\n` }
  }
  if (!pin.licences.inspected) return { complete: false, text: `${[...lines, pin.licences.reason, '', ...sourcePointers(pin)].join('\n')}\n` }
  const checksums = new Map<string, string>()
  if (installed) {
    if (pin.kind === 'archive') {
      const record = await readInstalledRecord(inspection.folder)
      if (record.kind !== 'found') throw new CliError('The build record changed while reading its licence notices.')
      for (const file of record.record.licences) checksums.set(file.path, file.sha256)
    } else {
      const record = await readBuildRecord(inspection.folder)
      if (record.kind !== 'found') throw new CliError('The executor record changed while reading its licence notices.')
      for (const file of [...record.build.licenses, ...record.build.notices]) checksums.set(`licenses/${basename(file.path)}`, file.sha256)
    }
  }
  for (const file of pin.licences.files) {
    if (signal.aborted) break
    let text: string | undefined
    if (installed) {
      const root = pin.kind === 'archive' ? join(inspection.folder, treeFolder) : inspection.folder
      const checksum = file.sha256 ?? checksums.get(file.path)
      const reading = await readNoticeFile(join(root, file.path), file, checksum, signal)
      if (reading.ok) text = reading.text
      else problems.push(reading.problem)
    } else if (file.bundled !== undefined) {
      const reading = readBundledLicence(file)
      if (reading.ok) text = reading.bytes.toString('utf8')
      else problems.push(`${file.path}: ${reading.problem}`)
    } else {
      problems.push(`${file.path}: notice text is available only with the installed build.`)
    }
    if (text !== undefined) lines.push(`--- ${file.path} (${file.licence}) ---`, text.replace(/\n?$/, '\n'))
  }
  if (problems.length > 0) lines.push('Notice texts unavailable:', ...problems, `Run \`retest install ${pin.engine}\` to install the pinned build.`, '')
  lines.push(...sourcePointers(pin))
  return { complete: problems.length === 0 && !signal.aborted, text: `${lines.join('\n')}\n` }
}

function sourcePointers(pin: BuildPin): string[] {
  if (pin.kind === 'source') return [`Source ${pin.repository}/tree/${pin.commit}`]
  if (pin.sourceCode === undefined) return [`Source ${pin.archive.url}`]
  return [`Source ${pin.sourceCode.repository}/tree/${pin.sourceCode.revision}`, `Patches ${pin.sourceCode.patches}`]
}

type NoticeText = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly problem: string }

/** How much of a notice is read at a time while its checksum is checked, before any of it is kept. */
const checkChunkBytes = 1024 * 1024

/** A notice's bytes once both readings had its checksum, or why they are not kept, as a clause with no full stop. */
export type CheckedNotice = { readonly ok: true; readonly bytes: Buffer } | { readonly ok: false; readonly problem: string }

/** Reads `length` bytes of an opened file at `position` into `buffer` at `offset`, as a file handle does. */
export type PositionedRead = (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ readonly bytesRead: number }>

/**
 * The bytes of an opened notice of `size` bytes, kept only when they have `checksum`. The recorded checksum, not a
 * size, says what a notice must be, and notices differ widely in size: Chromium's licence page in Electron is 20 MB.
 * So the file is first read through a chunk at a time and kept only when it has that checksum, then read again into a
 * buffer of the size just read and checked once more: a file of other bytes is never held, whatever its size, and one
 * that changed between the readings is refused.
 *
 * @example await readCheckedNotice((buffer, offset, length, position) => handle.read(buffer, offset, length, position), size, checksum, signal)
 */
export async function readCheckedNotice(read: PositionedRead, size: number, checksum: string, signal: AbortSignal): Promise<CheckedNotice> {
  const stopped = { ok: false, problem: 'reading was stopped' } as const
  const changed = { ok: false, problem: 'notice changed size while read' } as const
  const chunk = Buffer.allocUnsafe(Math.min(checkChunkBytes, size + 1))
  const first = createHash('sha256')
  let through = 0
  for (;;) {
    if (signal.aborted) return stopped
    const { bytesRead } = await read(chunk, 0, chunk.length, through)
    if (bytesRead === 0) break
    first.update(chunk.subarray(0, bytesRead))
    through += bytesRead
    if (through > size) return changed
  }
  if (through !== size) return changed
  if (first.digest('hex') !== checksum) return { ok: false, problem: 'notice checksum does not match' }
  const buffer = Buffer.alloc(size + 1)
  let filled = 0
  while (filled < buffer.length) {
    if (signal.aborted) return stopped
    const { bytesRead } = await read(buffer, filled, buffer.length - filled, filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }
  const bytes = buffer.subarray(0, filled)
  if (filled !== size || createHash('sha256').update(bytes).digest('hex') !== checksum) return { ok: false, problem: 'notice changed while read' }
  return { ok: true, bytes }
}

/** The member of Firefox's omni.ja that is its about:license page. */
const firefoxLicencePage = 'chrome/toolkit/content/global/license.html'

// Firefox keeps its notice page in omni.ja. Read the archive from the checked descriptor before asking the host
// unzip to print that one member from a private copy, or on Windows, which has no unzip, reading the member from the
// checked bytes. No path from a build becomes a command or archive member name.
async function readNoticeFile(path: string, file: LicenceFile, checksum: string | undefined, signal: AbortSignal): Promise<NoticeText> {
  if (checksum === undefined) return { ok: false, problem: `${file.path}: no notice checksum is recorded.` }
  const opened = await openRegularFile(path)
  if (opened.kind === 'missing') return { ok: false, problem: `${file.path} is missing.` }
  if (opened.kind !== 'opened') return { ok: false, problem: `${describeRefusal(opened, file.path)}.` }
  let bytes: Buffer
  try {
    const { handle } = opened
    const checked = await readCheckedNotice((buffer, offset, length, position) => handle.read(buffer, offset, length, position), opened.size, checksum, signal)
    if (!checked.ok) return { ok: false, problem: `${file.path}: ${checked.problem}.` }
    bytes = checked.bytes
  } finally {
    await opened.handle.close()
  }
  if (!file.path.endsWith('/omni.ja')) return { ok: true, text: bytes.toString('utf8') }
  if (process.platform === 'win32') {
    const page = readZipMember(bytes, firefoxLicencePage, 16 * 1024 * 1024 - 1)
    return page.ok && page.bytes.length > 0 ? { ok: true, text: page.bytes.toString('utf8') } : { ok: false, problem: `${file.path}: its licence page could not be read completely.` }
  }
  const folder = await mkdtemp(join(tmpdir(), 'retest-licences-'))
  try {
    const archive = join(folder, 'omni.ja')
    await writeFile(archive, bytes, { mode: 0o600, flag: 'wx' })
    const result = await runCommand('/usr/bin/unzip', ['-p', archive, firefoxLicencePage], { timeoutMs: 10_000, signal })
    if (result.code !== 0 || result.cleanupProblems.length > 0 || result.stdout.length >= 16 * 1024 * 1024 || result.stdout === '') return { ok: false, problem: `${file.path}: its licence page could not be read completely.` }
    return { ok: true, text: result.stdout }
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}
