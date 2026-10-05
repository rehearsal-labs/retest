import type { Server } from 'node:http'
import type { ArchiveFormat, ArchivePin, CacheFolders, InstalledBuildRecord } from '../../src/browser/builds.ts'
import type { InstallLock } from '../../src/cli/install/lock.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { buildFolder, cacheFolders, fileSha256, recordFile, treeFolder } from '../../src/browser/builds.ts'
import { takeInstallLock } from '../../src/cli/install/lock.ts'
import { folderChecksum } from '../../src/native/executors.ts'
import { sha256Hex } from '../../src/shared/sha256.ts'
import { tempFolder } from '../support/temp-folder.ts'

// A small stand-in build the pin tests install, inspect and break: an executable script, a licence and a pinned file.

export const standInExecutable = '#!/bin/sh\necho stand-in\n'
export const standInLicence = 'Stand-in licence: anyone may use this.\n'
export const standInProtocol = '{"domains":[]}\n'

/** A file of a stand-in build: text, text with a mode, or a link. */
export type StandInEntry = string | { readonly text: string; readonly mode: number } | { readonly link: string }

/** The files of the stand-in build, by path inside the build. */
export const standInFiles: Readonly<Record<string, StandInEntry>> = {
  'Stand-in.app/Contents/MacOS/stand-in': { text: standInExecutable, mode: 0o755 },
  'LICENSE': standInLicence,
  'protocol.json': standInProtocol,
  'Stand-in.app/Contents/Resources/readme.txt': 'not pinned, read only by a full check\n',
}

/** What a stand-in pin says of its archive. The checksum and size are the caller's, since only it has the archive. */
export type StandInArchive = { readonly url?: string; readonly sha256?: string; readonly size?: number; readonly format?: ArchiveFormat }

/** A pin of the stand-in build. */
export function standInPin(archive: StandInArchive = {}, overrides: Partial<ArchivePin> = {}): ArchivePin {
  return {
    kind: 'archive',
    engine: 'electron',
    title: 'Stand-in',
    version: '1.0.0',
    platform: 'mac-arm64',
    archive: {
      ...(archive.format ?? { format: 'zip' }),
      url: archive.url ?? 'https://example.invalid/releases/stand-in-1.0.0.zip',
      ...(archive.sha256 === undefined ? {} : { sha256: archive.sha256 }),
      ...(archive.size === undefined ? {} : { size: archive.size }),
    },
    executable: { path: 'Stand-in.app/Contents/MacOS/stand-in', sha256: sha256Hex(standInExecutable) },
    files: [{ path: 'protocol.json', sha256: sha256Hex(standInProtocol), why: 'the protocol the client speaks' }],
    licences: { inspected: true, files: [{ path: 'LICENSE', title: 'the licence of the stand-in', licence: 'MIT', sha256: sha256Hex(standInLicence), published: true }] },
    provenance: 'made by the test',
    ...overrides,
  }
}

/** A cache under a new home folder of its own. */
export function temporaryCache(): { readonly home: string; readonly folders: CacheFolders } {
  const home = tempFolder('retest-builds-home-')
  const folders = cacheFolders({ HOME: home })
  if (folders === undefined) throw new Error(`No cache folders for the home folder ${home}.`)
  return { home, folders }
}

/** Writes files under `root`, making their folders, with their modes and links. */
export async function writeEntries(root: string, entries: Readonly<Record<string, StandInEntry>>): Promise<void> {
  for (const [path, entry] of Object.entries(entries)) {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    if (typeof entry === 'string') await writeFile(target, entry)
    else if ('link' in entry) await symlink(entry.link, target)
    else {
      await writeFile(target, entry.text)
      await chmod(target, entry.mode)
    }
  }
}

/**
 * Puts the stand-in build into the cache as `retest install` leaves one, with a record read from the files written,
 * and returns its folder and record.
 */
export async function installStandIn(folders: CacheFolders, pin: ArchivePin, archive: { readonly size: number; readonly sha256: string } = { size: 1234, sha256: sha256Hex('archive') }): Promise<{ readonly folder: string; readonly record: InstalledBuildRecord }> {
  const folder = buildFolder(folders, pin)
  const root = join(folder, treeFolder)
  await writeEntries(root, standInFiles)
  const licences = pin.licences.inspected ? pin.licences.files : []
  const record: InstalledBuildRecord = {
    schemaVersion: 1,
    engine: pin.engine,
    version: pin.version,
    platform: pin.platform,
    source: pin.archive.url,
    fetchedFrom: pin.archive.url,
    archive,
    executable: { path: pin.executable.path, sha256: await fileSha256(join(root, pin.executable.path)) },
    files: pin.files.map((file) => ({ path: file.path, sha256: file.sha256 })),
    licences: await Promise.all(licences.map(async (file) => ({ path: file.path, licence: file.licence, sha256: await fileSha256(join(root, file.path)) }))),
    tree: { sha256: await folderChecksum(root) },
    installedAt: '2026-10-05T00:00:00.000Z',
    installedBy: '0.0.0',
  }
  await writeFile(join(folder, recordFile), `${JSON.stringify(record, null, 2)}\n`)
  return { folder, record }
}

/** An install lock held by a process the test started, until `release` lets it go or `kill` ends the process. */
export type ChildLockHolder = { readonly pid: number; release(): Promise<void>; kill(): Promise<void> }

/** The installer stand-in the lock tests run in processes of their own. */
export const lockHolderScript: string = fileURLToPath(new URL('./builds-lock-holder.ts', import.meta.url))

/** Starts a process that takes the install lock at `path`, with `env` added to its environment, and resolves once it holds it. */
export async function holdLockInChild(path: string, env: Readonly<Record<string, string>> = {}): Promise<ChildLockHolder> {
  const child = spawn(process.execPath, ['--conditions=retest-source', lockHolderScript, 'hold', path], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...env } })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  const first = await new Promise<string>((resolve) => {
    let text = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      text += chunk
      if (text.includes('\n')) resolve(text.slice(0, text.indexOf('\n')))
    })
    child.once('exit', () => resolve(text))
  })
  if (first !== 'held' || child.pid === undefined) {
    child.kill('SIGKILL')
    await exited
    throw new Error(`The lock holder did not take ${path}: ${first}`)
  }
  const pid = child.pid
  return {
    pid,
    release: async () => {
      child.stdin.end()
      await exited
    },
    kill: async () => {
      child.kill('SIGKILL')
      await exited
    },
  }
}

/** Takes the install lock at `path` once it is free, for up to five seconds: a holder that exits is passed over once `ps` shows it gone. */
export async function takeWhenFree(path: string): Promise<Extract<InstallLock, { ok: true }>> {
  const deadline = Date.now() + 5000
  for (;;) {
    const lock = await takeInstallLock(path)
    if (lock.ok) return lock
    if (Date.now() > deadline) assert.fail(`The install lock ${path} was still held after five seconds: ${lock.message}`)
    await sleep(50)
  }
}

/**
 * The newest generation of the install lock at `path`, and whether its holder let go of it: whether the released mark
 * named after that generation's own token is beside it.
 */
export function lockState(path: string): { readonly generation: number; readonly released: boolean } {
  const names = existsSync(path) ? readdirSync(path) : []
  const generation = Math.max(0, ...names.map((name) => Number(/^(\d+)\.json$/.exec(name)?.[1] ?? 0)))
  if (generation === 0) return { generation, released: false }
  const value: unknown = JSON.parse(readFileSync(join(path, `${generation}.json`), 'utf8'))
  const token = typeof value === 'object' && value !== null && 'token' in value && typeof value.token === 'string' ? value.token : ''
  return { generation, released: names.includes(`${generation}.${token}.released`) }
}

/** The port a server the test started listens on. */
export function listeningPort(server: Server): number {
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object', 'the server listens on a port')
  return address.port
}
