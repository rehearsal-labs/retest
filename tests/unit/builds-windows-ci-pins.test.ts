import type { ArchivePin } from '../../src/browser/builds.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { windowsArchiveEngines, windowsArchivePin, windowsArchivesKey, windowsSetupPins } from '../../scripts/ci/windows-pins.ts'
import { findPin } from '../../src/browser/builds.ts'

// The pins a Windows integration shard prepares, and the key of the cache that keeps their archives.

test('a Windows shard prepares Chromium, Firefox and Electron, and the archive key names every pinned archive build', () => {
  assert.deepEqual(windowsArchiveEngines, ['chromium', 'firefox', 'electron'])
  const { archivesKey } = windowsSetupPins()
  for (const engine of windowsArchiveEngines) {
    const pin = findPin(engine, 'win-x64')
    assert.ok(pin?.kind === 'archive')
    assert.equal(windowsArchivePin(engine), pin)
    assert.ok(archivesKey.includes(`${engine}-${pin.version}`), `${engine} ${pin.version} in ${archivesKey}`)
  }
  assert.match(archivesKey, /^retest-browser-archives-win-x64-.*-[0-9a-f]{16}$/)
  // A cache key may not hold a comma, and GitHub refuses one longer than 512 characters.
  assert.ok(!archivesKey.includes(',') && archivesKey.length <= 512, archivesKey)
  assert.throws(() => windowsArchivePin('webkit'), /No Windows x64 archive pin for webkit\./)
})

test('the Windows archive key changes when any pinned archive changes its size, SHA-256 or address, and is not the macOS key', () => {
  const pins = windowsArchiveEngines.map(windowsArchivePin)
  const key = windowsArchivesKey(pins)
  const changed = (index: number, change: (archive: ArchivePin['archive']) => ArchivePin['archive']): string =>
    windowsArchivesKey(pins.map((pin, position) => (position === index ? { ...pin, archive: change(pin.archive) } : pin)))
  for (const index of pins.keys()) {
    const sizes = changed(index, (archive) => ({ ...archive, size: (archive.size ?? 0) + 1 }))
    const checksums = changed(index, (archive) => ({ ...archive, sha256: '0'.repeat(64) }))
    const addresses = changed(index, (archive) => ({ ...archive, url: `${archive.url}?mirror` }))
    assert.equal(new Set([key, sizes, checksums, addresses]).size, 4, `${pins[index]?.engine}`)
  }
  assert.ok(!key.includes('mac-arm64'))
})
