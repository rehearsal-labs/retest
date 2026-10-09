import { buildPlatform } from '../../src/browser/builds.ts'
import { mediaTarget } from '../../src/cli/install/media-pins.ts'

// Retest pins its browser builds and its media binary for macOS arm64 and Linux x64 only. On any other machine, such
// as the Linux arm64 one CI also runs, the product refuses both by name before it reads a cache or starts anything, so
// a case that needs a pin is skipped by name there: its behaviour does not exist on that machine.

/**
 * The skip for a case that reads this machine's browser pins, or false where Retest pins builds.
 *
 * @example test('lists the pins', { skip: unpinnedBuilds }, () => {})
 */
export const unpinnedBuilds: string | false = buildPlatform() === undefined ? `unverified: Retest pins builds for macOS arm64 and Linux x64, and this machine is ${process.platform} ${process.arch}` : false

/**
 * The skip for a case that discovers, installs or records with the media binary, or false where it has a pinned target.
 *
 * @example test('records a video', { skip: unpinnedMedia }, () => {})
 */
export const unpinnedMedia: string | false = mediaTarget() === undefined ? `unverified: retest-media has a pinned target for macOS arm64 and Linux x64 only, and this machine is ${process.platform} ${process.arch}` : false
