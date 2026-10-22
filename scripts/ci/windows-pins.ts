import type { ArchiveEngine, ArchivePin } from '../../src/browser/builds.ts'
import { createHash } from 'node:crypto'
import { findPin, pinRefusal } from '../../src/browser/builds.ts'

// The pinned builds a Windows integration shard prepares, read from the product's own pins: the browser archives and
// the key of the cache that keeps them. The key names exactly what the cache holds, so a changed pin starts a new
// cache and never restores an old archive; no version is written a second time in the workflow. Whether a cached
// archive may be used is the macOS rule, `archiveMatchesPin` in macos-pins.ts.

/** An engine Windows has an archive build of. */
export type WindowsArchiveEngine = Extract<ArchiveEngine, 'chromium' | 'firefox' | 'electron'>

/** The archive builds each Windows integration shard downloads and installs. WebKit does not run on Windows. */
export const windowsArchiveEngines: readonly WindowsArchiveEngine[] = ['chromium', 'firefox', 'electron']

/**
 * The Windows x64 archive pin of `engine`, refused when it is missing or its notices are incomplete.
 *
 * @example windowsArchivePin('firefox').archive.format // 'exe'
 */
export function windowsArchivePin(engine: ArchiveEngine): ArchivePin {
  const pin = findPin(engine, 'win-x64')
  if (pin?.kind !== 'archive') throw new Error(`No Windows x64 archive pin for ${engine}.`)
  const refusal = pinRefusal(pin)
  if (refusal !== undefined) throw new Error(refusal.message)
  return pin
}

/**
 * The key of the cache of `pins`' Windows archives: each build's version, then a digest of every address, size and
 * SHA-256.
 *
 * @example windowsArchivesKey(windowsArchiveEngines.map(windowsArchivePin)) // 'retest-browser-archives-win-x64-chromium-153.0.8010.12-…-1a2b3c4d5e6f7a8b'
 */
export function windowsArchivesKey(pins: readonly ArchivePin[]): string {
  const names = pins.map((pin) => `${pin.engine}-${pin.version}${pin.build === undefined ? '' : `-${pin.build}`}`).join('-')
  const facts = pins.map((pin) => `${pin.engine} ${pin.archive.url} ${pin.archive.size ?? ''} ${pin.archive.sha256 ?? ''}`).join('\n')
  return `retest-browser-archives-win-x64-${names}-${createHash('sha256').update(facts).digest('hex').slice(0, 16)}`
}

/**
 * The key of the Windows browser archive cache, from the pins.
 *
 * @example windowsSetupPins().archivesKey // 'retest-browser-archives-win-x64-…'
 */
export function windowsSetupPins(): { readonly archivesKey: string } {
  return { archivesKey: windowsArchivesKey(windowsArchiveEngines.map(windowsArchivePin)) }
}
