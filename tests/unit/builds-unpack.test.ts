import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import fsPromises, { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { crc32 } from 'node:zlib'
import { sevenZipStart, systemUnpackTools, unpackArchive } from '../../src/cli/install/unpack.ts'
import { unixOnly } from '../support/platform-skip.ts'
import { windowsStandIn } from '../support/stand-in-program.ts'
import { tempFolder } from '../support/temp-folder.ts'

// No unpack here leaves anything behind for it to report.
function noReport(line: string): void {
  assert.fail(`The unpack reported: ${line}`)
}

// A disk image's attach is done by a system helper that outlives hdiutil, so an attach that fails, is stopped or runs
// out of time can still leave an image attached. A stand-in hdiutil plays the helper here: its `info` lists what the
// real one listed on this Mac, with the image of the failed attach mounted on that attach's mount point, beside an
// image of the system's and one of the same archive mounted somewhere else, neither of which is the install's.

// The stand-in hdiutil. `attach` remembers its mount point and image, then fails, or with `stall` waits to be ended, or
// with `mount` puts the app on the mount point and succeeds; `info` lists the images from the call named by `from` on;
// `detach` notes what it was asked to detach, and takes the app off the mount point when that is what it was given.
async function standInHdiutil(options: { readonly attach: 'fail' | 'stall' | 'mount'; readonly from?: number }): Promise<{ readonly tool: string; readonly calls: () => string[]; readonly mountPoint: () => string; readonly attachReady: () => boolean; readonly infoCount: () => number }> {
  const folder = tempFolder('retest-hdiutil-')
  const tool = join(folder, 'hdiutil')
  // One process that never starts another, so ending it for a stop ends all of it.
  const script = `#!${process.execPath}
const { appendFileSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const state = ${JSON.stringify(folder)}
const args = process.argv.slice(2)
appendFileSync(state + '/calls', args.join(' ') + '\\n')
const read = (name, fallback) => { try { return readFileSync(state + '/' + name, 'utf8') } catch { return fallback } }
if (args[0] === 'attach') {
  writeFileSync(state + '/mount', args[args.indexOf('-mountpoint') + 1])
  writeFileSync(state + '/image', args[args.length - 1])
  if (${JSON.stringify(options.attach)} === 'stall') setTimeout(() => {}, 30000)
  else if (${JSON.stringify(options.attach)} === 'mount') writeFileSync(read('mount', '') + '/Stand-in.app', 'the app')
  else { process.stderr.write('hdiutil: attach failed - no mountable file systems\\n'); process.exitCode = 1 }
} else if (args[0] === 'info') {
  const count = Number(read('count', '0')) + 1
  writeFileSync(state + '/count', String(count))
  const lines = ['framework       : 704', 'driver          : 704']
  if (count >= ${options.from ?? 1}) {
    const rule = '================================================'
    lines.push(rule, 'image-path      : /System/Library/AssetsV2/runtime/094-56039-099.dmg', 'image-type      : read-only disk image', '/dev/disk4\\tGUID_partition_scheme\\t', '/dev/disk4s1\\t7C3457EF-0000-11AA-AA11-00306543ECAC\\t', '/dev/disk5\\tEF57347C-0000-11AA-AA11-00306543ECAC\\t', '/dev/disk5s1\\t41504653-0000-11AA-AA11-00306543ECAC\\t/Library/Developer/CoreSimulator/Volumes/iOS_23F77')
    lines.push(rule, 'image-path      : ' + read('image', ''), 'image-type      : UDIF read-only compressed (zlib)', '/dev/disk8\\tGUID_partition_scheme\\t', '/dev/disk8s1\\t48465300-0000-11AA-AA11-00306543ECAC\\t/Volumes/Somebody else')
    lines.push(rule, 'image-path      : ' + read('image', ''), 'image-type      : UDIF read-only compressed (zlib)', '/dev/disk97\\tGUID_partition_scheme\\t', '/dev/disk97s1\\t48465300-0000-11AA-AA11-00306543ECAC\\t' + read('mount', ''))
  }
  process.stdout.write(lines.join('\\n') + '\\n')
} else if (args[0] === 'detach' && args[args.length - 1] === read('mount', '')) {
  rmSync(read('mount', '') + '/Stand-in.app', { force: true })
}
`
  await writeFile(tool, script)
  await chmod(tool, 0o755)
  return {
    tool,
    calls: () => readFileSync(join(folder, 'calls'), 'utf8').trim().split('\n'),
    mountPoint: () => readFileSync(join(folder, 'mount'), 'utf8'),
    attachReady: () => existsSync(join(folder, 'image')),
    infoCount: () => existsSync(join(folder, 'count')) ? Number(readFileSync(join(folder, 'count'), 'utf8')) : 0,
  }
}

async function imageArchive(): Promise<string> {
  const archive = join(tempFolder('retest-image-'), 'Stand-in 1.0.0.dmg')
  await writeFile(archive, 'a verified disk image')
  return archive
}

// The stand-in hdiutil is a script, which Windows cannot run, and a disk image is unpacked only on macOS.
const noDiskImages = unixOnly('a disk image is unpacked only on macOS, and Windows cannot run the stand-in hdiutil script')

describe('unpacking a disk image whose attach did not finish', { skip: noDiskImages }, () => {
  test('detaches the image the helper mounted on its mount point after hdiutil attach failed, and nothing else', async () => {
    const hdiutil = await standInHdiutil({ attach: 'fail', from: 1 })
    const archive = await imageArchive()
    const problem = await unpackArchive({ archive, format: { format: 'dmg', app: 'Stand-in.app' }, into: tempFolder('retest-into-'), platform: 'darwin', tools: { ...systemUnpackTools, hdiutil: hdiutil.tool }, signal: new AbortController().signal, timeoutMs: 10_000, report: noReport })
    assert.match(problem ?? '', /^The disk image could not be attached: hdiutil attach ended with exit code 1/)
    const calls = hdiutil.calls()
    assert.deepEqual(calls.slice(1), ['info', 'detach /dev/disk97'], 'only the image on its own mount point is detached')
    assert.equal(existsSync(hdiutil.mountPoint()), false, 'the mount point is removed')
  })

  test('watches a stopped attach for the helper finishing it, and detaches what it attached', { timeout: 20_000 }, async (t) => {
    const hdiutil = await standInHdiutil({ attach: 'stall', from: 3 })
    const archive = await imageArchive()
    const controller = new AbortController()
    let unpacking: Promise<string | undefined> | undefined
    t.after(async () => { controller.abort(); await unpacking })
    // The helper's progress is measured in info answers; starting a Node stand-in can itself use the real watch window.
    t.mock.method(Date, 'now', () => hdiutil.infoCount() * 250)
    t.after(() => t.mock.restoreAll())
    unpacking = unpackArchive({ archive, format: { format: 'dmg', app: 'Stand-in.app' }, into: tempFolder('retest-into-'), platform: 'darwin', tools: { ...systemUnpackTools, hdiutil: hdiutil.tool }, signal: controller.signal, timeoutMs: 10_000, report: noReport })
    const startedBy = performance.now() + 10_000
    while (!hdiutil.attachReady()) {
      assert.ok(performance.now() < startedBy, 'the stand-in attach did not start within 10 seconds')
      await delay(10)
    }
    controller.abort()
    const problem = await unpacking
    assert.match(problem ?? '', /^The disk image could not be attached: hdiutil attach was stopped/)
    const calls = hdiutil.calls()
    assert.deepEqual(calls.slice(1), ['info', 'info', 'info', 'detach /dev/disk97'], 'the attach the helper finished later is detached')
  })
})

// rmdir refuses the install's mount point as busy for its first `refusals` tries, as macOS can for a moment after
// hdiutil detach returns; every other folder is removed as usual.
function refuseMountPointRemoval(t: TestContext, refusals: number): { readonly attempts: () => number[] } {
  const original = fsPromises.rmdir
  const attempts: number[] = []
  t.mock.method(fsPromises, 'rmdir', async (...args: Parameters<typeof original>) => {
    if (String(args[0]).includes('retest-install-image-')) {
      attempts.push(Date.now())
      if (attempts.length <= refusals) throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${String(args[0])}'`), { code: 'EBUSY' })
    }
    return original(...args)
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  return { attempts: () => [...attempts] }
}

function leftMountPoint(mountPoint: string): string {
  return `Retest could not remove the empty mount folder ${mountPoint} after the disk image was detached; remove it by hand.`
}

// cp stands in for ditto, which Linux lacks; the stand-in's app is a single file.
const copyTools = { ...systemUnpackTools, ditto: '/bin/cp' }

describe('removing the mount point once the disk image is detached', { skip: noDiskImages }, () => {
  test('removes a mount point the system still held for a moment after the detach, and reports nothing', async (t) => {
    const removal = refuseMountPointRemoval(t, 1)
    const hdiutil = await standInHdiutil({ attach: 'mount' })
    const into = tempFolder('retest-into-')
    const problem = await unpackArchive({ archive: await imageArchive(), format: { format: 'dmg', app: 'Stand-in.app' }, into, platform: 'darwin', tools: { ...copyTools, hdiutil: hdiutil.tool }, signal: new AbortController().signal, timeoutMs: 10_000, report: noReport })
    assert.equal(problem, undefined)
    assert.equal(readFileSync(join(into, 'Stand-in.app'), 'utf8'), 'the app', 'the app is copied out')
    assert.equal(removal.attempts().length, 2, 'the busy mount point is tried once more')
    assert.equal(existsSync(hdiutil.mountPoint()), false, 'the mount point is removed')
  })

  test('names a mount point that stays busy after the detach, once about two seconds have passed', async (t) => {
    const removal = refuseMountPointRemoval(t, Number.POSITIVE_INFINITY)
    const hdiutil = await standInHdiutil({ attach: 'mount' })
    const into = tempFolder('retest-into-')
    const problem = await unpackArchive({ archive: await imageArchive(), format: { format: 'dmg', app: 'Stand-in.app' }, into, platform: 'darwin', tools: { ...copyTools, hdiutil: hdiutil.tool }, signal: new AbortController().signal, timeoutMs: 10_000, report: noReport })
    const mountPoint = hdiutil.mountPoint()
    t.after(() => rmSync(mountPoint, { recursive: true, force: true }))
    assert.equal(problem, leftMountPoint(mountPoint))
    const attempts = removal.attempts()
    const spentMs = (attempts.at(-1) ?? 0) - (attempts[0] ?? 0)
    assert.ok(attempts.length > 2, `the mount point was tried ${attempts.length} times`)
    assert.ok(spentMs >= 1900 && spentMs <= 3000, `the tries spanned ${spentMs} ms`)
    assert.equal(existsSync(mountPoint), true, 'the folder named is the one still there')
  })

  test('names a mount point that stays busy after the image of a failed attach was detached', async (t) => {
    refuseMountPointRemoval(t, Number.POSITIVE_INFINITY)
    const hdiutil = await standInHdiutil({ attach: 'fail', from: 1 })
    const problem = await unpackArchive({ archive: await imageArchive(), format: { format: 'dmg', app: 'Stand-in.app' }, into: tempFolder('retest-into-'), platform: 'darwin', tools: { ...copyTools, hdiutil: hdiutil.tool }, signal: new AbortController().signal, timeoutMs: 10_000, report: noReport })
    const mountPoint = hdiutil.mountPoint()
    t.after(() => rmSync(mountPoint, { recursive: true, force: true }))
    assert.match(problem ?? '', /^The disk image could not be attached: hdiutil attach ended with exit code 1/)
    assert.ok((problem ?? '').endsWith(` ${leftMountPoint(mountPoint)}`), problem)
    assert.deepEqual(hdiutil.calls().slice(1), ['info', 'detach /dev/disk97'], 'the image on its mount point is detached first')
  })
})

// A 7-Zip start header: the signature, the version, the CRC-32 of the next 20 bytes, then where the index starts after
// the header, its size and its CRC-32. `index` is any bytes; only their checksum is read.
function startHeader(gap: number, index: Buffer, options: { readonly wrongIndexCrc?: boolean } = {}): Buffer {
  const tail = Buffer.alloc(20)
  tail.writeBigUInt64LE(BigInt(gap), 0)
  tail.writeBigUInt64LE(BigInt(index.length), 8)
  tail.writeUInt32LE((crc32(index) + (options.wrongIndexCrc === true ? 1 : 0)) >>> 0, 16)
  const head = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4, 0, 0, 0, 0])
  head.writeUInt32LE(crc32(tail), 8)
  return Buffer.concat([head, tail, Buffer.alloc(gap, 7), index])
}

async function written(bytes: Buffer): Promise<string> {
  const path = join(tempFolder('retest-installer-'), 'Stand-in Setup 1.0.0.exe')
  await writeFile(path, bytes)
  return path
}

describe('finding the 7-Zip archive inside a Windows installer', () => {
  // A stub that is a program, holding the signature once as its own bytes, as a self-extractor's code can.
  const stub = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(300, 1), Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]), Buffer.alloc(500, 2)])

  test('passes over a signature that is only bytes of the stub, and finds the archive whose headers hold', async () => {
    const archive = startHeader(64, Buffer.from('the index of the archive'))
    assert.deepEqual(await sevenZipStart(await written(Buffer.concat([stub, archive, Buffer.alloc(100, 9)]))), { ok: true, offset: stub.length }, 'a signature that trails the archive is never read')
  })

  test('passes over a header whose index lies past the end or has another checksum, and says when nothing is left', async () => {
    const index = Buffer.from('the index of the archive')
    const cut = startHeader(64, index).subarray(0, 32 + 64 + 4)
    const wrong = startHeader(64, index, { wrongIndexCrc: true })
    for (const bytes of [Buffer.concat([stub, cut]), Buffer.concat([stub, wrong]), Buffer.from('MZ no archive at all')]) {
      assert.deepEqual(await sevenZipStart(await written(bytes)), { ok: false, problem: 'The installer holds no 7-Zip archive in its first 4 MiB, so Retest cannot unpack it without running it.' })
    }
  })
})

// libarchive's bsdtar unpacks zip and 7-Zip archives: Windows' own tar.exe is one, and so is macOS's tar, which stands
// in for it here. Linux has one only where libarchive's tools are installed.
const bsdtar = process.platform === 'win32' ? systemUnpackTools.tar : process.platform === 'darwin' ? '/usr/bin/tar' : '/usr/bin/bsdtar'
const noBsdtar = existsSync(bsdtar) ? false : `unverified: these cases unpack with libarchive's bsdtar, as Windows does with its own tar.exe, and this machine has none at ${bsdtar}`
const windowsTools = { ...systemUnpackTools, tar: bsdtar }

// A stand-in of Mozilla's installer: a stub holding a stray signature, then a 7-Zip archive of setup.exe and the core
// folder, made by bsdtar.
async function standInInstaller(): Promise<string> {
  const source = tempFolder('retest-installer-source-')
  await mkdir(join(source, 'core', 'browser'), { recursive: true })
  await writeFile(join(source, 'core', 'firefox.exe'), 'the stand-in browser')
  await writeFile(join(source, 'core', 'browser', 'omni.ja'), 'the stand-in notices')
  await writeFile(join(source, 'setup.exe'), 'the installer, which is never unpacked')
  const archive = join(tempFolder('retest-installer-archive-'), 'core.7z')
  execFileSync(bsdtar, ['--format', '7zip', '-c', '-f', archive, '-C', source, 'core', 'setup.exe'])
  const stub = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 1), Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), Buffer.alloc(200, 2)])
  return written(Buffer.concat([stub, await readFile(archive)]))
}

// A tar that writes down each time it is started and with what, then runs the real bsdtar with the same arguments.
async function loggingTar(): Promise<{ readonly tool: string; readonly runs: () => string[][] }> {
  const folder = tempFolder('retest-logging-tar-')
  const log = join(folder, 'runs.jsonl')
  const runs = (): string[][] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]) : [])
  if (process.platform === 'win32') {
    const tool = join(folder, 'tar.exe')
    windowsStandIn(tool, [
      "const { appendFileSync } = require('node:fs')",
      "const { spawnSync } = require('node:child_process')",
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')`,
      `process.exitCode = spawnSync(${JSON.stringify(bsdtar)}, process.argv.slice(2), { stdio: 'inherit' }).status ?? 1`,
      '',
    ].join('\n'))
    return { tool, runs }
  }
  const tool = join(folder, 'tar')
  await writeFile(tool, `#!${process.execPath}\nconst { appendFileSync } = require('node:fs')\nappendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')\nprocess.exitCode = require('node:child_process').spawnSync(${JSON.stringify(bsdtar)}, process.argv.slice(2), { stdio: 'inherit' }).status ?? 1\n`)
  await chmod(tool, 0o755)
  return { tool, runs }
}

// A tar that answers --version with `version`, as the tar.exe of an older Windows does, and unpacks nothing.
async function tarAnswering(version: string): Promise<string> {
  const folder = tempFolder('retest-old-tar-')
  const script = `process.stdout.write(process.argv[2] === '--version' ? ${JSON.stringify(`${version}\n`)} : '')\nprocess.exitCode = process.argv[2] === '--version' ? 0 : 1\n`
  if (process.platform === 'win32') {
    const tool = join(folder, 'tar.exe')
    windowsStandIn(tool, script)
    return tool
  }
  const tool = join(folder, 'tar')
  await writeFile(tool, `#!${process.execPath}\n${script}`)
  await chmod(tool, 0o755)
  return tool
}

function installerWorkspaces(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('retest-install-installer-'))
}

describe('unpacking a zip and a Windows installer with tar, as Windows does', { skip: noBsdtar }, () => {
  test('unpacks only the folder the pin names, from a copy of the archive inside the installer, and starts only tar, never the installer', async () => {
    const before = new Set(installerWorkspaces())
    const into = tempFolder('retest-into-')
    const installer = await standInInstaller()
    const tar = await loggingTar()
    const problem = await unpackArchive({ archive: installer, format: { format: 'exe', folder: 'core' }, into, platform: 'win32', tools: { ...windowsTools, tar: tar.tool }, signal: new AbortController().signal, timeoutMs: 60_000, report: noReport })
    assert.equal(problem, undefined)
    const runs = tar.runs()
    assert.deepEqual(runs.map((args) => args[0]), ['--version', '-x'], 'tar is asked what it reads, then unpacks, and nothing else is started')
    const [, , copy = ''] = runs[1] ?? []
    assert.deepEqual(runs[1], ['-x', '-f', copy, '-C', into, 'core'])
    assert.ok(copy !== installer && copy.endsWith('installer.7z'), `tar reads a copy of the archive, never the installer itself: ${copy}`)
    assert.deepEqual(readdirSync(into), ['core'], 'setup.exe stays in the installer')
    assert.equal(readFileSync(join(into, 'core', 'firefox.exe'), 'utf8'), 'the stand-in browser')
    assert.equal(readFileSync(join(into, 'core', 'browser', 'omni.ja'), 'utf8'), 'the stand-in notices')
    assert.deepEqual(installerWorkspaces().filter((name) => !before.has(name)), [], 'the copy of the archive is removed')
  })

  test('says so when the installer holds no such folder, and when it holds no archive at all', async () => {
    const options = { platform: 'win32', tools: windowsTools, signal: new AbortController().signal, timeoutMs: 60_000, report: noReport } as const
    const elsewhere = await unpackArchive({ ...options, archive: await standInInstaller(), format: { format: 'exe', folder: 'browser' }, into: tempFolder('retest-into-') })
    assert.match(elsewhere ?? '', /^Unpacking the archive failed: tar ended with exit code 1/)
    const none = await unpackArchive({ ...options, archive: await written(Buffer.from('MZ and no archive')), format: { format: 'exe', folder: 'core' }, into: tempFolder('retest-into-') })
    assert.equal(none, 'The installer holds no 7-Zip archive in its first 4 MiB, so Retest cannot unpack it without running it.')
  })

  test('unpacks a zip whole with tar', async () => {
    const source = tempFolder('retest-zip-source-')
    await mkdir(join(source, 'chrome-win64', 'locales'), { recursive: true })
    await writeFile(join(source, 'chrome-win64', 'chrome.exe'), 'the stand-in browser')
    await writeFile(join(source, 'chrome-win64', 'locales', 'en-US.pak'), 'words')
    const archive = join(tempFolder('retest-zip-'), 'chrome-win64.zip')
    execFileSync(bsdtar, ['--format', 'zip', '-c', '-f', archive, '-C', source, 'chrome-win64'])
    const into = tempFolder('retest-into-')
    assert.equal(await unpackArchive({ archive, format: { format: 'zip' }, into, platform: 'win32', tools: windowsTools, signal: new AbortController().signal, timeoutMs: 60_000, report: noReport }), undefined)
    assert.equal(readFileSync(join(into, 'chrome-win64', 'locales', 'en-US.pak'), 'utf8'), 'words')
  })
})

describe('what Windows unpacking refuses', () => {
  test('a tar.exe built without LZMA, named before it unpacks anything, with what to do', async () => {
    const tar = await tarAnswering('bsdtar 3.5.2 - libarchive 3.5.2 zlib/1.2.5.f-ipp')
    const installer = startHeader(64, Buffer.from('the index of the archive'))
    const problem = await unpackArchive({ archive: await written(Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100, 1), installer])), format: { format: 'exe', folder: 'core' }, into: tempFolder('retest-into-'), platform: 'win32', tools: { ...systemUnpackTools, tar }, signal: new AbortController().signal, timeoutMs: 60_000, report: noReport })
    assert.equal(problem, `${tar} (bsdtar 3.5.2 - libarchive 3.5.2 zlib/1.2.5.f-ipp) cannot unpack this installer, since it was built without LZMA. Update Windows, or give the target an executablePath.`)
  })

  test('a Windows installer anywhere but Windows, and a Windows unpack without tar.exe', async () => {
    const options = { archive: await written(Buffer.from('MZ')), into: tempFolder('retest-into-'), signal: new AbortController().signal, timeoutMs: 10_000, report: noReport } as const
    assert.equal(await unpackArchive({ ...options, format: { format: 'exe', folder: 'core' }, platform: 'darwin', tools: systemUnpackTools }), 'A Windows installer is unpacked only on Windows.')
    const missing = join(tempFolder('retest-no-tar-'), 'tar.exe')
    assert.equal(await unpackArchive({ ...options, format: { format: 'zip' }, platform: 'win32', tools: { ...systemUnpackTools, tar: missing } }), `Unpacking on Windows needs its own tar.exe at ${missing}, which Windows includes from Windows 10 version 1803.`)
  })

  test("names Windows' own tar.exe, never the tar a Git shell puts first on PATH", () => {
    assert.match(systemUnpackTools.tar, /^[A-Za-z]:\\(?:[^\\]+\\)*System32\\tar\.exe$/i)
  })
})
