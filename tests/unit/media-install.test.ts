import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { test } from 'node:test'
import { installMedia } from '../../src/cli/install/media-install.ts'
import { checkMediaSource, inspectMedia, mediaFolder, mediaNoticePins, mediaPackageRoot } from '../../src/cli/install/media-record.ts'
import { maximumMediaBinaryBytes, maximumMediaSourceBytes, mediaSourceDigest, mediaTarget, mediaVersion } from '../../src/cli/install/media-pins.ts'
import { rustAtLeast } from '../../src/cli/install/media-tools.ts'
import { sha256Hex } from '../../src/shared/sha256.ts'
import { readRecordText } from '../../src/shared/regular-file.ts'
import { locateMedia } from '../../src/media/locate.ts'
import { unpinnedMedia } from '../support/unpinned-host.ts'

async function recordText(path: string): Promise<string> {
  const read = await readRecordText(path)
  assert.ok(read.kind === 'text', `${path} must be a bounded regular record`)
  return read.text
}

async function fixture(): Promise<{ home: string; folder: string; env: { HOME: string; PATH: string } }> {
  const home = await mkdtemp(join(tmpdir(), 'retest-media-unit-'))
  const env = { HOME: home, PATH: '' }
  const target = mediaTarget() ?? 'aarch64-apple-darwin'
  const folder = mediaFolder(env, target) ?? assert.fail('a cache folder')
  await mkdir(folder, { recursive: true })
  const binary = '#!/bin/sh\nexit 0\n'
  await writeFile(join(folder, 'retest-media'), binary, { mode: 0o755 })
  const notices = mediaNoticePins()
  for (const notice of notices) await writeFile(join(folder, notice.path), await readFile(join(mediaPackageRoot(), notice.path === 'LICENSE' ? 'LICENSE' : 'src/cli/install/media-notices.txt')))
  await writeFile(join(folder, 'build.json'), JSON.stringify({ schemaVersion: 1, version: mediaVersion, protocol: 2, sourceDigest: mediaSourceDigest, target, method: 'source', rustcVersion: 'rustc 1.88.0 (abc 2025-06-26)', binarySha256: sha256Hex(Buffer.from(binary)), notices, installedAt: '2026-10-06T00:00:00Z', installedBy: '0.1.0' }))
  return { home, folder, env }
}

test('the pinned edition 2024 crate requires Rust 1.88; older, unreadable and prerelease toolchains are refused', () => {
  for (const version of ['rustc 1.81.0', 'rustc 1.85.0', 'rustc 1.87.9', 'rustc 1.88.0-nightly', 'not rustc']) assert.equal(rustAtLeast(version), false, version)
  assert.equal(rustAtLeast('rustc 1.88.0 (abc 2025-06-26)'), true)
  assert.equal(rustAtLeast('cargo 1.98.1 (abc 2026-09-30)'), true)
})

test('the packaged source allowlist includes a pinned lock and licence texts, and reads without Cargo', async () => {
  assert.equal(await checkMediaSource(mediaPackageRoot()), undefined)
})

test('full verification refuses a binary replaced between its descriptor hash and inspection', { skip: unpinnedMedia }, async t => {
  const f = await fixture(); t.after(() => rm(f.home, { recursive: true, force: true }))
  const path = join(f.folder, 'retest-media')
  const replacement = `${path}.replacement`
  await writeFile(replacement, '#!/bin/sh\nexit 99\n', { mode: 0o755 })
  const original = fsPromises.lstat
  let checks = 0
  t.mock.method(fsPromises, 'lstat', async (...args: Parameters<typeof original>) => {
    if (args[0] === path && ++checks === 2) await fsPromises.rename(replacement, path)
    return original(...args)
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const inspected = await inspectMedia(f.env, { verify: true })
  assert.equal(checks, 2, 'replacement happens after hashing, at the later inspection check')
  assert.equal(inspected?.state, 'damaged')
  assert.ok(inspected?.problems.some(problem => problem.includes(path) && /replaced|identity/.test(problem)))
})

test('discovery refuses a cached binary replaced after inspection and before its answer', { skip: unpinnedMedia }, async t => {
  const f = await fixture(); t.after(() => rm(f.home, { recursive: true, force: true }))
  const path = join(f.folder, 'retest-media')
  const replacement = `${path}.replacement`
  await writeFile(replacement, '#!/bin/sh\nexit 99\n', { mode: 0o755 })
  const ffmpeg = join(f.home, 'ffmpeg')
  await writeFile(ffmpeg, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const original = fsPromises.realpath
  t.mock.method(fsPromises, 'realpath', async (...args: Parameters<typeof original>) => {
    if (args[0] === ffmpeg) await fsPromises.rename(replacement, path)
    return original(...args)
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const found = await locateMedia({ env: f.env, ffmpeg, mode: 'discover' })
  assert.ok(!found.ok)
  assert.ok(found.message.includes(path))
  assert.match(found.message, /replaced|identity/)
})

test('inspection and source verification refuse sparse files past the limits in the media pin', { skip: unpinnedMedia }, async t => {
  const f = await fixture(); t.after(() => rm(f.home, { recursive: true, force: true }))
  const binary = await fsPromises.open(join(f.folder, 'retest-media'), 'w')
  try { await binary.truncate(maximumMediaBinaryBytes + 1) } finally { await binary.close() }
  const inspection = await inspectMedia(f.env)
  assert.equal(inspection?.state, 'damaged')
  assert.match(inspection?.problems.join(' ') ?? '', /retest-media.*more than the maximum/)
  const root = join(f.home, 'source')
  await mkdir(join(root, 'media'), { recursive: true })
  const source = await fsPromises.open(join(root, 'media/Cargo.toml'), 'w')
  try { await source.truncate(maximumMediaSourceBytes + 1) } finally { await source.close() }
  assert.match(await checkMediaSource(root) ?? '', /Cargo.toml.*more than the maximum/)
})

test('source verification and cache inspection honour an already aborted caller', { skip: unpinnedMedia }, async t => {
  const f = await fixture(); t.after(() => rm(f.home, { recursive: true, force: true }))
  const controller = new AbortController()
  controller.abort()
  assert.match(await checkMediaSource(mediaPackageRoot(), { signal: controller.signal }) ?? '', /Cargo.toml.*stopped/)
  const inspection = await inspectMedia(f.env, { signal: controller.signal })
  assert.equal(inspection?.state, 'damaged')
  assert.match(inspection?.problems.join(' ') ?? '', /stopped/)
})

test('records name the source, target, version, protocol, rustc, binary and licence hashes; a full verify finds extra entries', { skip: unpinnedMedia }, async (t) => {
  const f = await fixture(); t.after(() => rm(f.home, { recursive: true, force: true }))
  assert.equal((await inspectMedia(f.env, { verify: true }))?.state, 'installed')
  await writeFile(join(f.folder, 'unrecorded'), '')
  assert.equal((await inspectMedia(f.env))?.state, 'installed')
  assert.match((await inspectMedia(f.env, { verify: true }))?.problems.join(' ') ?? '', /unrecorded/)
})

test('damaged binaries, executable modes and licence files never read as installed', { skip: unpinnedMedia }, async (t) => {
  const f = await fixture(); t.after(() => rm(f.home, { recursive: true, force: true }))
  await chmod(join(f.folder, 'retest-media'), 0o644)
  assert.match((await inspectMedia(f.env))?.problems.join(' ') ?? '', /not executable/)
  await chmod(join(f.folder, 'retest-media'), 0o4755)
  assert.match((await inspectMedia(f.env))?.problems.join(' ') ?? '', /set-user-id/)
  await chmod(join(f.folder, 'retest-media'), 0o755)
  await writeFile(join(f.folder, 'THIRD-PARTY-NOTICES.txt'), 'changed')
  assert.match((await inspectMedia(f.env))?.problems.join(' ') ?? '', /not the recorded/)
})

test('a linked, oversized, invalid or FIFO record is refused by name without following or waiting', { skip: unpinnedMedia }, async (t) => {
  const f = await fixture(); t.after(() => rm(f.home, { recursive: true, force: true }))
  const record = join(f.folder, 'build.json')
  const kept = await recordText(record)
  await writeFile(join(f.home, 'kept.json'), kept)
  await rm(record); await symlink(join(f.home, 'kept.json'), record)
  assert.match((await inspectMedia(f.env))?.problems.join(' ') ?? '', /a link/)
  await rm(record); await writeFile(record, 'x'.repeat(1024 * 1024 + 1))
  assert.match((await inspectMedia(f.env))?.problems.join(' ') ?? '', /more than/)
  await writeFile(record, '{')
  assert.match((await inspectMedia(f.env))?.problems.join(' ') ?? '', /not JSON/)
  await rm(record); execFileSync('/usr/bin/mkfifo', [record])
  assert.match((await inspectMedia(f.env))?.problems.join(' ') ?? '', /a FIFO/)
})

test('changed identity or unknown record fields refuse; an unpinned prebuilt record is unverifiable', { skip: unpinnedMedia }, async (t) => {
  const f = await fixture(); t.after(() => rm(f.home, { recursive: true, force: true }))
  const path = join(f.folder, 'build.json')
  const text = await recordText(path)
  await writeFile(path, text.replace('"protocol":2', '"protocol":1'))
  assert.match((await inspectMedia(f.env))?.problems.join(' ') ?? '', /another media/)
  await writeFile(path, text.replace('"method":"source"', '"method":"prebuilt"'))
  assert.equal((await inspectMedia(f.env))?.state, 'unverifiable')
  await writeFile(path, text.replace('"schemaVersion":1', '"schemaVersion":1,"trustMe":true'))
  assert.match((await inspectMedia(f.env))?.problems.join(' ') ?? '', /not a valid/)
})

test('an intact installation of an earlier source digest is damaged and cannot be reused or discovered', { skip: unpinnedMedia }, async (t) => {
  const f = await fixture(); t.after(() => rm(f.home, { recursive: true, force: true }))
  const path = join(f.folder, 'build.json')
  const current = await recordText(path)
  assert.equal((await inspectMedia(f.env, { verify: true }))?.state, 'installed')
  const earlierDigest = 'd019a1d4b336806c2a0609333339bcd5b993d0a3ef71fe0ca41902c875fff171'
  assert.notEqual(earlierDigest, mediaSourceDigest)
  const earlier = current.replace(mediaSourceDigest, earlierDigest)
  await writeFile(path, earlier)
  const binary = await readFile(join(f.folder, 'retest-media'))
  const inspected = await inspectMedia(f.env, { verify: true })
  assert.equal(inspected?.state, 'damaged')
  assert.ok(inspected?.problems.some((problem) => problem.includes(path) && problem.includes('source')))
  const installed = await installMedia({ env: f.env, signal: new AbortController().signal, version: '0.1.0', report: () => {}, run: () => assert.fail('no build tool runs for a damaged source identity') })
  assert.ok(!installed.ok)
  assert.ok(installed.message.includes(path))
  assert.match(installed.message, /Remove .*install media/)
  const found = await locateMedia({ env: f.env, mode: 'discover' })
  assert.ok(!found.ok)
  assert.ok(found.message.includes(path))
  assert.match(found.message, /source/)
  assert.equal(await recordText(path), earlier)
  assert.deepEqual(await readFile(join(f.folder, 'retest-media')), binary)
  assert.deepEqual((await fsPromises.readdir(f.folder)).sort(), ['LICENSE', 'THIRD-PARTY-NOTICES.txt', 'build.json', 'retest-media'].sort())
})

test('prebuilt path and mirror without an exact checksum refuse before reading, requesting or creating a cache', { skip: unpinnedMedia }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'retest-media-refusal-')); t.after(() => rm(home, { recursive: true, force: true }))
  for (const source of [{ binary: '/unread/media' }, { mirror: 'http://127.0.0.1:1' }]) {
    const result = await installMedia({ env: { HOME: home }, signal: new AbortController().signal, version: '0.1.0', report: () => assert.fail('no step before refusal'), ...source })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.message, /No checksum is pinned/)
  }
  assert.deepEqual(await import('node:fs/promises').then((fs) => fs.readdir(home)), [])
})

test('a damaged media cache is named and left untouched by a source install', { skip: unpinnedMedia }, async (t) => {
  const f = await fixture(); t.after(() => rm(f.home, { recursive: true, force: true }))
  await writeFile(join(f.folder, 'retest-media'), 'damaged')
  const result = await installMedia({ env: f.env, signal: new AbortController().signal, version: '0.1.0', report: () => {}, run: () => assert.fail('no build of damaged cache') })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.message, /Remove .*install media/)
  assert.equal(await readFile(join(f.folder, 'retest-media'), 'utf8'), 'damaged')
  const alias = join(f.home, 'explicit-alias')
  await symlink(join(f.folder, 'retest-media'), alias)
  const located = await locateMedia({ executable: alias, ffmpeg: '/usr/bin/false', env: f.env })
  assert.equal(located.ok, false)
  if (!located.ok) assert.match(located.message, /not the recorded.*Remove .*install media/)
})

test('third-party notices name every registry crate and package checksum from the shipped Cargo.lock', async () => {
  const root = mediaPackageRoot()
  const lock = await recordText(join(root, 'media/Cargo.lock'))
  const notices = await readFile(join(root, 'src/cli/install/media-notices.txt'), 'utf8')
  assert.match(notices, /Lock SHA-256: ded3cee3c32d990f089b0e4fba70222b200d386482869dff46d9987854451ed5/)
  let registryCrates = 0
  for (const entry of lock.split('[[package]]')) {
    if (!entry.includes('source = "registry+')) continue
    const name = /^name = "([^"]+)"/m.exec(entry)?.[1] ?? assert.fail('crate name')
    const version = /^version = "([^"]+)"/m.exec(entry)?.[1] ?? assert.fail('crate version')
    const checksum = /^checksum = "([^"]+)"/m.exec(entry)?.[1] ?? assert.fail('crate checksum')
    assert.ok(notices.includes(`${name} ${version}\n`), name)
    assert.ok(notices.includes(`Package checksum: ${checksum}\n`), name)
    registryCrates++
  }
  assert.ok(registryCrates > 0)
})

test('the source installer refuses missing cargo, an old rustc and a lock rewritten by a build, preserving no installed binary', { skip: unpinnedMedia }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'retest-media-toolchain-')); t.after(() => rm(home, { recursive: true, force: true }))
  const toolFolder = join(home, 'tools'); await mkdir(toolFolder)
  const missing = await installMedia({ env: { HOME: join(home, 'missing'), PATH: toolFolder }, signal: new AbortController().signal, version: '0.1.0', report: () => {} })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.match(missing.message, /cargo is missing.*1.88.*Edition 2024.*1.85/)
  for (const name of ['cargo', 'rustc']) await writeFile(join(toolFolder, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const succeeded = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, stopped: false, started: true, cleanupProblems: [] } as const
  const target = mediaTarget() ?? 'aarch64-apple-darwin'
  const cleanup = await installMedia({ env: { HOME: join(home, 'cleanup'), PATH: toolFolder }, signal: new AbortController().signal, version: '0.1.0', report: () => {}, run: async (_command, args) => {
    assert.equal(args[0], '--version', 'no build or further tool runs after uncertain cleanup')
    return { ...succeeded, stdout: 'cargo 1.88.0 (abc)', cleanupProblems: ['a tool process could not be confirmed gone'] }
  } })
  assert.equal(cleanup.ok, false)
  if (!cleanup.ok) assert.match(cleanup.message, /cleanup_failed.*not be confirmed gone/)
  assert.equal((await inspectMedia({ HOME: join(home, 'cleanup') }))?.state, 'missing')
  const old = await installMedia({ env: { HOME: join(home, 'old'), PATH: toolFolder }, signal: new AbortController().signal, version: '0.1.0', report: () => {}, run: async (_command, args) => ({ ...succeeded, stdout: args[0] === '--version' ? 'cargo 1.88.0 (abc)' : `rustc 1.85.0 (abc)\nhost: ${target}\n` }) })
  assert.equal(old.ok, false)
  if (!old.ok) assert.match(old.message, /rustc.*older than Rust 1.88/)
  let built = false
  const changed = await installMedia({ env: { HOME: join(home, 'changed'), PATH: toolFolder }, signal: new AbortController().signal, version: '0.1.0', report: () => {}, run: async (_command, args) => {
    if (args[0] === '--version') return { ...succeeded, stdout: 'cargo 1.88.0 (abc)' }
    if (args[0] === '-vV') return { ...succeeded, stdout: `rustc 1.88.0 (abc)\nhost: ${target}\n` }
    assert.ok(args.includes('--locked'))
    const manifest = args[args.indexOf('--manifest-path') + 1] ?? assert.fail('manifest')
    await writeFile(join(manifest.slice(0, -'Cargo.toml'.length), 'Cargo.lock'), 'rewritten')
    built = true
    return succeeded
  } })
  assert.equal(built, true)
  assert.equal(changed.ok, false)
  if (!changed.ok) assert.match(changed.message, /build changed the pinned source or Cargo.lock/)
  assert.equal((await inspectMedia({ HOME: join(home, 'changed') }))?.state, 'missing')
})

test('the current generation lock refuses another installer of media by name', { skip: unpinnedMedia }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'retest-media-lock-')); t.after(() => rm(home, { recursive: true, force: true }))
  const env = { HOME: home, PATH: '' }
  const folder = mediaFolder(env, mediaTarget() ?? 'aarch64-apple-darwin') ?? assert.fail('cache')
  const { mediaLockPath } = await import('../../src/cli/install/media-record.ts')
  const { takeInstallLock } = await import('../../src/cli/install/lock.ts')
  const lock = await takeInstallLock(mediaLockPath(folder))
  assert.equal(lock.ok, true)
  if (!lock.ok) return
  try {
    const result = await installMedia({ env, signal: new AbortController().signal, version: '0.1.0', report: () => {}, run: () => assert.fail('no tool while lock held') })
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(result.message.includes(mediaLockPath(folder)))
  } finally { assert.equal(await lock.release(), undefined) }
})
