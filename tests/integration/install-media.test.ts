import type { MediaPrebuiltPin } from '../../src/cli/install/media-pins.ts'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { before, after, test } from 'node:test'
import { installMedia } from '../../src/cli/install/media-install.ts'
import { mediaDoctorRows } from '../../src/cli/install/media-doctor.ts'
import { inspectMedia, mediaFolder, mediaLockPath, mediaPackageRoot } from '../../src/cli/install/media-record.ts'
import { mediaSourceDigest, mediaTarget, mediaVersion } from '../../src/cli/install/media-pins.ts'
import { probeMediaBinary, runMediaTool } from '../../src/cli/install/media-tools.ts'
import { locateMedia } from '../../src/media/locate.ts'
import { sha256Hex } from '../../src/shared/sha256.ts'
import { readRecordText } from '../../src/shared/regular-file.ts'

// The outer test command must hold the heavy gate. It uses cached crates offline, never a publisher.
const root = mediaPackageRoot()
const target = mediaTarget()
const unverified = target === undefined ? `unverified host ${process.platform} ${process.arch}` : false
let folder = ''
let packed = ''
let binary = ''
let env: Record<string, string | undefined> = {}
const signal = new AbortController().signal

before(async () => {
  if (unverified !== false) return
  folder = await mkdtemp(join(tmpdir(), 'retest-media-package-'))
  const stage = join(folder, 'stage')
  await mkdir(stage)
  for (const path of ['package.json', 'LICENSE', 'media/Cargo.toml', 'media/Cargo.lock', 'media/build.rs', 'media/src', 'src/cli/install/media-notices.txt']) {
    await mkdir(dirname(join(stage, path)), { recursive: true })
    await cp(join(root, path), join(stage, path), { recursive: true })
  }
  const compiled = await runMediaTool(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.build.json'), '--outDir', join(stage, 'dist')], { env: process.env, signal, timeoutMs: 120_000 })
  assert.equal(compiled.code, 0, compiled.stdout + compiled.stderr)
  const pack = await runMediaTool('npm', ['--cache', join(folder, 'npm-cache'), 'pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', folder], { env: process.env, signal, cwd: stage, timeoutMs: 60_000 })
  assert.equal(pack.code, 0, pack.stdout + pack.stderr)
  const archive = (await readdir(folder)).find((name) => name.endsWith('.tgz')) ?? assert.fail('the packed archive')
  const unpack = await runMediaTool('/usr/bin/tar', ['-xzf', join(folder, archive), '-C', folder], { env: process.env, signal })
  assert.equal(unpack.code, 0, unpack.stderr)
  packed = join(folder, 'package')
  await rm(stage, { recursive: true })
  const home = join(folder, 'host-home')
  await mkdir(home)
  env = { ...process.env, HOME: home, CARGO_HOME: process.env['CARGO_HOME'] ?? join(process.env['HOME'] ?? assert.fail('HOME'), '.cargo'), RUSTUP_HOME: process.env['RUSTUP_HOME'] ?? join(process.env['HOME'] ?? assert.fail('HOME'), '.rustup'), CARGO_TARGET_DIR: join(folder, 'fresh-target'), RETEST_MEDIA_BINARY: undefined, RETEST_FFMPEG: undefined, RETEST_DOWNLOAD_MIRROR: undefined }
})
after(async () => { if (folder !== '') await rm(folder, { recursive: true, force: true }) })

test('the npm packed copy alone builds offline into a fresh target and cache, runs protocol 2, and leaves a released generation lock', { skip: unverified, timeout: 180_000 }, async (t) => {
  assert.ok(target !== undefined)
  const args = [join(packed, 'dist/cli/main.js'), 'install', 'media', '--offline']
  const installed = await runMediaTool(process.execPath, args, { env, signal, cwd: folder, timeoutMs: 180_000 })
  assert.equal(installed.code, 0, installed.stdout + installed.stderr)
  const inspected = await inspectMedia(env, { verify: true })
  assert.equal(inspected?.state, 'installed')
  assert.ok(inspected?.record !== undefined)
  assert.equal(inspected.record.method, 'source')
  assert.equal(inspected.record.sourceDigest, mediaSourceDigest)
  assert.equal(inspected.record.target, target)
  t.diagnostic(`Packed source record: ${JSON.stringify(inspected.record)}`)
  assert.match(inspected.record.rustcVersion ?? '', /^rustc /)
  binary = inspected.executablePath
  const found = await locateMedia({ env })
  assert.equal(found.ok, true, found.ok ? '' : found.message)
  if (found.ok) { assert.equal(found.source, 'cache'); assert.equal(found.hello.protocol, 2); assert.equal(found.hello.version, mediaVersion) }
  const names = await readdir(mediaLockPath(inspected.folder))
  const generation = names.filter((name) => /^\d+\.json$/.test(name)).sort((a, b) => Number.parseInt(a) - Number.parseInt(b)).at(-1) ?? assert.fail('a generation')
  const lockText = await readRecordText(join(mediaLockPath(inspected.folder), generation))
  assert.equal(lockText.kind, 'text')
  assert.ok(lockText.kind === 'text')
  const lock = JSON.parse(lockText.text) as { token: string }
  assert.ok(names.includes(`${generation.slice(0, -5)}.${lock.token}.released`), 'the newest generation is released under its token')
  const list = await runMediaTool(process.execPath, [join(packed, 'dist/cli/main.js'), 'install', '--list', '--verify', '--json'], { env, signal, cwd: folder })
  assert.equal(list.code, 0, list.stdout + list.stderr)
  const listed = JSON.parse(list.stdout) as { builds: { engine: string; state: string; binarySha256?: string }[] }
  assert.equal(listed.builds.find((build) => build.engine === 'media')?.binarySha256, inspected.record.binarySha256)
  const again = await runMediaTool(process.execPath, args, { env: { ...env, PATH: '/usr/bin:/bin' }, signal, cwd: folder })
  assert.equal(again.code, 0, again.stdout + again.stderr)
  assert.match(again.stdout, /was already installed/)
  assert.equal((await readdir(dirname(inspected.folder))).some((name) => name.includes('.staging-')), false)
  const rows = await mediaDoctorRows(env, signal)
  t.diagnostic(`Packed media doctor: ${JSON.stringify(rows)}`)
  assert.ok(rows.every((row) => row.ok), JSON.stringify(rows))
  assert.match(rows.find((row) => row.subject === 'ffmpeg')?.text ?? '', /Licence: .+rawvideo demuxer present.*libx264.*libvpx.*declared prerequisite/)
})

test('an exact pinned stand-in prebuilt is served only on 127.0.0.1, verified before execution and discovered from its record', { skip: unverified }, async (t) => {
  assert.ok(target !== undefined && binary !== '')
  const bytes = await readFile(binary)
  let requests = 0
  const server = createServer((_request, response) => { requests++; response.setHeader('content-length', String(bytes.length)); response.end(bytes) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) })
  const address = server.address(); assert.ok(address !== null && typeof address !== 'string')
  const mirror = `http://127.0.0.1:${address.port}`
  const pin: MediaPrebuiltPin = { target, version: mediaVersion, protocol: 2, sourceDigest: mediaSourceDigest, sha256: sha256Hex(bytes), size: bytes.length, url: 'https://media.invalid/retest-media' }
  const prebuiltEnv = { ...env, HOME: join(folder, 'prebuilt-home') }
  const installed = await installMedia({ env: prebuiltEnv, signal, version: '0.1.0', report: () => {}, mirror, pins: [pin] })
  assert.equal(installed.ok, true, installed.ok ? '' : installed.message)
  assert.equal(requests, 1)
  const inspected = await inspectMedia(prebuiltEnv, { pins: [pin], verify: true })
  assert.equal(inspected?.state, 'installed')
  assert.equal(inspected?.record?.method, 'prebuilt')
  // The production table has no pin for this unpublished artifact, so production discovery refuses its folder.
  assert.equal((await inspectMedia(prebuiltEnv))?.state, 'unverifiable')
  const again = await installMedia({ env: prebuiltEnv, signal, version: '0.1.0', report: () => {}, mirror, pins: [pin] })
  assert.equal(again.ok, true); assert.equal(requests, 1)
  const wrongEnv = { ...env, HOME: join(folder, 'wrong-prebuilt-home') }
  const bad = await installMedia({ env: wrongEnv, signal, version: '0.1.0', report: () => {}, mirror, pins: [{ ...pin, sha256: '0'.repeat(64) }] })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.match(bad.message, /pinned SHA-256/)
  assert.equal((await inspectMedia(wrongEnv))?.state, 'missing')
  assert.equal(requests, 2)
  const localEnv = { ...env, HOME: join(folder, 'path-prebuilt-home') }
  const local = await installMedia({ env: localEnv, signal, version: '0.1.0', report: () => {}, binary, pins: [pin] })
  assert.equal(local.ok, true, local.ok ? '' : local.message)
  assert.equal(requests, 2)
})

test('a changed shipped lock, a missing cargo and an unusable encoder are named without installing a binary', { skip: unverified }, async () => {
  const changed = join(folder, 'changed-package')
  await cp(packed, changed, { recursive: true })
  await writeFile(join(changed, 'media/Cargo.lock'), 'changed lock')
  const install = await runMediaTool(process.execPath, [join(changed, 'dist/cli/main.js'), 'install', 'media', '--offline'], { env: { ...env, HOME: join(folder, 'changed-home') }, signal, cwd: folder })
  assert.equal(install.code, 2)
  assert.match(install.stdout, /Cargo.lock has SHA-256.*not the pinned/)
  const missingEnv = { HOME: join(folder, 'no-cargo-home'), PATH: '/usr/bin:/bin' }
  const missing = await installMedia({ env: missingEnv, signal, version: '0.1.0', report: () => {}, packageRoot: packed, offline: true })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.match(missing.message, /cargo is missing.*Rust 1.88.*Edition 2024.*1.85/)
  assert.equal((await inspectMedia(missingEnv))?.state, 'missing')
  assert.ok(target !== undefined)
  const probe = await probeMediaBinary(binary, '/usr/bin/false', target, 15_000, true)
  assert.equal(probe.ok, true)
  if (probe.ok) assert.equal(probe.encoder?.state, 'failed')
  const cache = mediaFolder(env, target) ?? assert.fail('cache')
  await writeFile(join(cache, 'retest-media'), 'damaged')
  const bad = await locateMedia({ env })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.match(bad.message, /not the recorded.*Remove .*install media/)
})

test('explicit binaries with a wrong version, protocol or target fail setup by name and their probes close', { skip: unverified }, async () => {
  assert.ok(target !== undefined)
  const badFolder = join(folder, 'wrong-greetings'); await mkdir(badFolder)
  for (const [name, protocol, version, buildTarget] of [['version', 2, '9.0.0', target], ['protocol', 1, mediaVersion, target], ['target', 2, mediaVersion, 'wrong-host']] as const) {
    const path = join(badFolder, `${name}.mjs`)
    const hello = { type: 'hello', protocol, version, build: { target: buildTarget, profile: 'release' }, ffmpeg: '/usr/bin/false', encoder: { state: 'probing' } }
    const body = `#!/usr/bin/env node\nfunction frame(value) { const header = Buffer.from(JSON.stringify(value)); const prefix = Buffer.alloc(8); prefix.writeUInt32BE(header.length, 0); return Buffer.concat([prefix, header]); }\nprocess.stdout.write(frame(${JSON.stringify(hello)}));\nprocess.stdin.once('data', () => process.stdout.write(frame({type:'bye',stopped:0}), () => process.exit(0)));\nprocess.stdin.resume();\n`
    await writeFile(path, body, { mode: 0o755 })
    const result = await locateMedia({ executable: path, ffmpeg: '/usr/bin/false', env: { ...env, HOME: join(folder, 'explicit-home') } })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.message, name === 'version' ? /expected 0.1.0/ : name === 'protocol' ? /protocol 1.*protocol 2|protocol 1.*speaks 2/ : /expected .* in release/)
  }
})
