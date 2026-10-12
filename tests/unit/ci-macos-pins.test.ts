import type { ArchivePin } from '../../src/browser/builds.ts'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { archiveMatchesPin, archivesCacheKey, macosArchiveEngines, macosArchivePin, macosSetupPins } from '../../scripts/ci/macos-pins.ts'
import { findPin } from '../../src/browser/builds.ts'
import { minimumRust } from '../../src/cli/install/media-pins.ts'

test('setup installs the pinned Rust, and the archive key names every pinned archive build', () => {
  const pins = macosSetupPins()
  assert.equal(pins.rust, minimumRust)
  for (const engine of macosArchiveEngines) {
    const pin = findPin(engine, 'mac-arm64')
    assert.ok(pin?.kind === 'archive')
    assert.ok(pins.archivesKey.includes(`${engine}-${pin.version}`), `${engine} ${pin.version} in ${pins.archivesKey}`)
    assert.equal(macosArchivePin(engine), pin)
  }
  assert.match(pins.archivesKey, /^retest-browser-archives-mac-arm64-.*-[0-9a-f]{16}$/)
  // A cache key may not hold a comma, and GitHub refuses one longer than 512 characters.
  assert.ok(!pins.archivesKey.includes(',') && pins.archivesKey.length <= 512, pins.archivesKey)
  assert.deepEqual(macosSetupPins(), pins)
})

test('the archive key changes when any pinned archive changes its size, SHA-256 or address, even at the same version', () => {
  const pins = macosArchiveEngines.map(macosArchivePin)
  const key = archivesCacheKey(pins)
  assert.equal(archivesCacheKey(pins.map((pin) => ({ ...pin, archive: { ...pin.archive } }))), key)
  const changed = (index: number, change: (archive: ArchivePin['archive']) => ArchivePin['archive']): string =>
    archivesCacheKey(pins.map((pin, position) => (position === index ? { ...pin, archive: change(pin.archive) } : pin)))
  for (const index of pins.keys()) {
    const sizes = changed(index, (archive) => ({ ...archive, size: (archive.size ?? 0) + 1 }))
    const checksums = changed(index, (archive) => ({ ...archive, sha256: '0'.repeat(64) }))
    const addresses = changed(index, (archive) => ({ ...archive, url: `${archive.url}?mirror` }))
    for (const other of [sizes, checksums, addresses]) assert.notEqual(other, key, `${pins[index]?.engine}: ${other}`)
    assert.equal(new Set([key, sizes, checksums, addresses]).size, 4)
  }
})

test('a cached archive is used only when it is a regular file of the pinned size and SHA-256', async (context) => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-ci-archives-'))
  context.after(() => rm(folder, { recursive: true, force: true }))
  const bytes = Buffer.from('a pinned archive')
  const pinned = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  const archive = join(folder, 'electron.zip')
  await writeFile(archive, bytes)
  assert.equal(await archiveMatchesPin(archive, pinned), true)
  await writeFile(join(folder, 'changed.zip'), Buffer.from('a pinned archivE'))
  assert.equal(await archiveMatchesPin(join(folder, 'changed.zip'), pinned), false)
  await writeFile(join(folder, 'short.zip'), bytes.subarray(1))
  assert.equal(await archiveMatchesPin(join(folder, 'short.zip'), pinned), false)
  await symlink(archive, join(folder, 'link.zip'))
  assert.equal(await archiveMatchesPin(join(folder, 'link.zip'), pinned), false)
  await mkdir(join(folder, 'folder.zip'))
  assert.equal(await archiveMatchesPin(join(folder, 'folder.zip'), pinned), false)
  assert.equal(await archiveMatchesPin(join(folder, 'missing.zip'), pinned), false)
})
