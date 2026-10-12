import type { ArchiveEngine, ArchivePin } from '../../src/browser/builds.ts'
import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { findPin, pinRefusal, readFileSha256 } from '../../src/browser/builds.ts'
import { minimumRust } from '../../src/cli/install/media-pins.ts'

// The pinned builds a macOS integration shard prepares, read from the product's own pins: the browser archives and the
// key of the cache that keeps them, and the Rust version setup installs. The key names exactly what the cache holds,
// so a changed pin starts a new cache and never restores an old archive; no version is written a second time in the
// workflow.

/** The archive builds each macOS integration shard downloads and installs. */
export const macosArchiveEngines: readonly ArchiveEngine[] = ['chromium', 'firefox', 'webkit', 'electron']

/**
 * The macOS arm64 archive pin of `engine`, refused when it is missing or its notices are incomplete.
 *
 * @example macosArchivePin('electron').version // '44.5.1'
 */
export function macosArchivePin(engine: ArchiveEngine): ArchivePin {
  const pin = findPin(engine, 'mac-arm64')
  if (pin?.kind !== 'archive') throw new Error(`No macOS arm64 archive pin for ${engine}.`)
  const refusal = pinRefusal(pin)
  if (refusal !== undefined) throw new Error(refusal.message)
  return pin
}

/**
 * The key of the cache of `pins`' archives: each build's version, then a digest of every address, size and SHA-256.
 *
 * @example archivesCacheKey(macosArchiveEngines.map(macosArchivePin)) // 'retest-browser-archives-mac-arm64-chromium-153.0.8010.12-…-599418cca41a6b82'
 */
export function archivesCacheKey(pins: readonly ArchivePin[]): string {
  const names = pins.map((pin) => `${pin.engine}-${pin.version}${pin.build === undefined ? '' : `-${pin.build}`}`).join('-')
  const facts = pins.map((pin) => `${pin.engine} ${pin.archive.url} ${pin.archive.size ?? ''} ${pin.archive.sha256 ?? ''}`).join('\n')
  return `retest-browser-archives-mac-arm64-${names}-${createHash('sha256').update(facts).digest('hex').slice(0, 16)}`
}

/** The Rust version macOS setup installs, and the key of the browser archive cache. */
export type MacosSetupPins = { readonly rust: string; readonly archivesKey: string }

/**
 * Rust is the oldest version the media crate supports, as CI checks the oldest Node.js `package.json` allows.
 *
 * @example macosSetupPins().rust // '1.88.0'
 */
export function macosSetupPins(): MacosSetupPins {
  return { rust: minimumRust, archivesKey: archivesCacheKey(macosArchiveEngines.map(macosArchivePin)) }
}

/**
 * Whether a cached archive is exactly the pinned one: a regular file, never a link, of the pinned size and SHA-256.
 * Anything else is downloaded again, so a damaged or foreign cache can cost time but never change what is installed.
 *
 * @example await archiveMatchesPin('/…/electron-mac-arm64-electron-v44.5.1-darwin-arm64.zip', { size: 130259261, sha256: '1d75…' }) // true
 */
export async function archiveMatchesPin(path: string, pinned: { readonly size: number; readonly sha256: string }): Promise<boolean> {
  const found = await lstat(path).catch(() => undefined)
  if (found === undefined || !found.isFile() || found.size !== pinned.size) return false
  const reading = await readFileSha256(path)
  return reading.kind === 'file' && reading.sha256 === pinned.sha256
}
