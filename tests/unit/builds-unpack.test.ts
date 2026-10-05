import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { systemUnpackTools, unpackArchive } from '../../src/cli/install/unpack.ts'
import { tempFolder } from '../support/temp-folder.ts'

// A disk image's attach is done by a system helper that outlives hdiutil, so an attach that fails, is stopped or runs
// out of time can still leave an image attached. A stand-in hdiutil plays the helper here: its `info` lists what the
// real one listed on this Mac, with the image of the failed attach mounted on that attach's mount point, beside an
// image of the system's and one of the same archive mounted somewhere else, neither of which is the install's.

// The stand-in hdiutil. `attach` remembers its mount point and image, then fails, or with `stall` waits to be ended;
// `info` lists the images from the call named by `from` on; `detach` notes what it was asked to detach.
async function standInHdiutil(options: { readonly attach: 'fail' | 'stall'; readonly from: number }): Promise<{ readonly tool: string; readonly calls: () => string[]; readonly mountPoint: () => string }> {
  const folder = tempFolder('retest-hdiutil-')
  const tool = join(folder, 'hdiutil')
  // One process that never starts another, so ending it for a stop ends all of it.
  const script = `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs')
const state = ${JSON.stringify(folder)}
const args = process.argv.slice(2)
appendFileSync(state + '/calls', args.join(' ') + '\\n')
const read = (name, fallback) => { try { return readFileSync(state + '/' + name, 'utf8') } catch { return fallback } }
if (args[0] === 'attach') {
  writeFileSync(state + '/mount', args[args.indexOf('-mountpoint') + 1])
  writeFileSync(state + '/image', args[args.length - 1])
  if (${JSON.stringify(options.attach)} === 'stall') setTimeout(() => {}, 30000)
  else { process.stderr.write('hdiutil: attach failed - no mountable file systems\\n'); process.exitCode = 1 }
} else if (args[0] === 'info') {
  const count = Number(read('count', '0')) + 1
  writeFileSync(state + '/count', String(count))
  const lines = ['framework       : 704', 'driver          : 704']
  if (count >= ${options.from}) {
    const rule = '================================================'
    lines.push(rule, 'image-path      : /System/Library/AssetsV2/runtime/094-56039-099.dmg', 'image-type      : read-only disk image', '/dev/disk4\\tGUID_partition_scheme\\t', '/dev/disk4s1\\t7C3457EF-0000-11AA-AA11-00306543ECAC\\t', '/dev/disk5\\tEF57347C-0000-11AA-AA11-00306543ECAC\\t', '/dev/disk5s1\\t41504653-0000-11AA-AA11-00306543ECAC\\t/Library/Developer/CoreSimulator/Volumes/iOS_23F77')
    lines.push(rule, 'image-path      : ' + read('image', ''), 'image-type      : UDIF read-only compressed (zlib)', '/dev/disk8\\tGUID_partition_scheme\\t', '/dev/disk8s1\\t48465300-0000-11AA-AA11-00306543ECAC\\t/Volumes/Somebody else')
    lines.push(rule, 'image-path      : ' + read('image', ''), 'image-type      : UDIF read-only compressed (zlib)', '/dev/disk97\\tGUID_partition_scheme\\t', '/dev/disk97s1\\t48465300-0000-11AA-AA11-00306543ECAC\\t' + read('mount', ''))
  }
  process.stdout.write(lines.join('\\n') + '\\n')
}
`
  await writeFile(tool, script)
  await chmod(tool, 0o755)
  return { tool, calls: () => readFileSync(join(folder, 'calls'), 'utf8').trim().split('\n'), mountPoint: () => readFileSync(join(folder, 'mount'), 'utf8') }
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

  test('watches a stopped attach for the helper finishing it, and detaches what it attached', { timeout: 20_000 }, async () => {
    const hdiutil = await standInHdiutil({ attach: 'stall', from: 3 })
    const archive = await imageArchive()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    const problem = await unpackArchive({ archive, format: { format: 'dmg', app: 'Stand-in.app' }, into: tempFolder('retest-into-'), platform: 'darwin', tools: { ...systemUnpackTools, hdiutil: hdiutil.tool }, signal: controller.signal, timeoutMs: 10_000 })
    assert.match(problem ?? '', /^The disk image could not be attached: hdiutil attach was stopped/)
    const calls = hdiutil.calls()
    assert.deepEqual(calls.slice(1), ['info', 'info', 'info', 'detach /dev/disk97'], 'the attach the helper finished later is detached')
  })
})
