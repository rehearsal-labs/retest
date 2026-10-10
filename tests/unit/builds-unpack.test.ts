import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import fsPromises, { chmod, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { systemUnpackTools, unpackArchive } from '../../src/cli/install/unpack.ts'
import { tempFolder } from '../support/temp-folder.ts'

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

describe('unpacking a disk image whose attach did not finish', () => {
  test('detaches the image the helper mounted on its mount point after hdiutil attach failed, and nothing else', async () => {
    const hdiutil = await standInHdiutil({ attach: 'fail', from: 1 })
    const archive = await imageArchive()
    const problem = await unpackArchive({ archive, format: { format: 'dmg', app: 'Stand-in.app' }, into: tempFolder('retest-into-'), platform: 'darwin', tools: { ...systemUnpackTools, hdiutil: hdiutil.tool }, signal: new AbortController().signal, timeoutMs: 10_000 })
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
    unpacking = unpackArchive({ archive, format: { format: 'dmg', app: 'Stand-in.app' }, into: tempFolder('retest-into-'), platform: 'darwin', tools: { ...systemUnpackTools, hdiutil: hdiutil.tool }, signal: controller.signal, timeoutMs: 10_000 })
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

describe('removing the mount point once the disk image is detached', () => {
  test('removes a mount point the system still held for a moment after the detach, and reports nothing', async (t) => {
    const removal = refuseMountPointRemoval(t, 1)
    const hdiutil = await standInHdiutil({ attach: 'mount' })
    const into = tempFolder('retest-into-')
    const problem = await unpackArchive({ archive: await imageArchive(), format: { format: 'dmg', app: 'Stand-in.app' }, into, platform: 'darwin', tools: { ...copyTools, hdiutil: hdiutil.tool }, signal: new AbortController().signal, timeoutMs: 10_000 })
    assert.equal(problem, undefined)
    assert.equal(readFileSync(join(into, 'Stand-in.app'), 'utf8'), 'the app', 'the app is copied out')
    assert.equal(removal.attempts().length, 2, 'the busy mount point is tried once more')
    assert.equal(existsSync(hdiutil.mountPoint()), false, 'the mount point is removed')
  })

  test('names a mount point that stays busy after the detach, once about two seconds have passed', async (t) => {
    const removal = refuseMountPointRemoval(t, Number.POSITIVE_INFINITY)
    const hdiutil = await standInHdiutil({ attach: 'mount' })
    const into = tempFolder('retest-into-')
    const problem = await unpackArchive({ archive: await imageArchive(), format: { format: 'dmg', app: 'Stand-in.app' }, into, platform: 'darwin', tools: { ...copyTools, hdiutil: hdiutil.tool }, signal: new AbortController().signal, timeoutMs: 10_000 })
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
    const problem = await unpackArchive({ archive: await imageArchive(), format: { format: 'dmg', app: 'Stand-in.app' }, into: tempFolder('retest-into-'), platform: 'darwin', tools: { ...copyTools, hdiutil: hdiutil.tool }, signal: new AbortController().signal, timeoutMs: 10_000 })
    const mountPoint = hdiutil.mountPoint()
    t.after(() => rmSync(mountPoint, { recursive: true, force: true }))
    assert.match(problem ?? '', /^The disk image could not be attached: hdiutil attach ended with exit code 1/)
    assert.ok((problem ?? '').endsWith(` ${leftMountPoint(mountPoint)}`), problem)
    assert.deepEqual(hdiutil.calls().slice(1), ['info', 'detach /dev/disk97'], 'the image on its mount point is detached first')
  })
})
