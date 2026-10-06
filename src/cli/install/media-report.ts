import type { MediaInspection } from './media-record.ts'
import type { MediaInstallResult } from './media-install.ts'
import { mediaSourceDigest } from './media-pins.ts'
import { parse, s } from '../../protocol/schema.ts'

const licenceFile = s.object({ path: s.string(), title: s.string(), licence: s.string(), sha256: s.optional(s.string()), published: s.boolean(), bundled: s.optional(s.string()) })
const licences = s.union([s.object({ inspected: s.literal(true), files: s.array(licenceFile) }), s.object({ inspected: s.literal(false), reason: s.string() })])
const sourceCode = s.object({ repository: s.string(), revision: s.string(), patches: s.string() })
const listedBuild = s.object({ engine: s.string(), title: s.string(), version: s.string(), build: s.optional(s.string()), platform: s.enum(['mac-arm64', 'linux-x64']), source: s.string(), pinnedSha256: s.union([s.string(), s.literal(null)]), state: s.enum(['missing', 'installed', 'damaged', 'unverifiable']), folder: s.string(), executablePath: s.optional(s.string()), sha256: s.optional(s.string()), installedAt: s.optional(s.string()), problems: s.array(s.string()), licences, sourceCode: s.optional(sourceCode), install: s.union([s.object({ command: s.string() }), s.object({ refused: s.string(), missingNotices: s.optional(s.array(s.string())) })]) })
const browserDocument = s.object({ schemaVersion: s.literal(1), platform: s.enum(['mac-arm64', 'linux-x64']), cache: s.object({ browsers: s.string(), executors: s.string() }), builds: s.array(listedBuild) })

/** Adds media to the existing list document without changing browser pin or record rules. */
export function renderMediaListing(browserText: string, inspection: MediaInspection | undefined, json: boolean): string {
  if (inspection === undefined) return browserText
  if (!json) return `${browserText}\n  media            retest-media ${inspection.version}, protocol ${inspection.protocol}, ${inspection.target}\n                   ${inspection.state}\n                   ${inspection.executablePath}\n${inspection.problems.map((problem) => `                   ${problem}\n`).join('')}                   ${inspection.record === undefined ? 'Run npx retest install media.' : `binary SHA-256 ${inspection.record.binarySha256}`}\n`
  const document = parse(browserDocument, JSON.parse(browserText))
  if (!document.ok) throw new Error('The browser install list did not match its versioned document.')
  const media = { engine: 'media', title: 'retest-media', version: inspection.version, protocol: inspection.protocol, target: inspection.target, platform: document.value.platform, source: 'shipped crate source', pinnedSha256: null, sourceDigest: mediaSourceDigest, state: inspection.state, folder: inspection.folder, executablePath: inspection.executablePath, binarySha256: inspection.record?.binarySha256, rustcVersion: inspection.record?.rustcVersion, installedAt: inspection.record?.installedAt, problems: inspection.problems, install: { command: 'npx retest install media', prebuiltRefused: 'No published prebuilt checksum is pinned.' } }
  return `${JSON.stringify({ ...document.value, builds: [...document.value.builds, media] }, null, 2)}\n`
}

export function renderMediaInstall(result: MediaInstallResult): string {
  if (!result.ok) return `  ✗ media            ${result.message}\n`
  return `  ✓ media            retest-media ${result.inspection.version} ${result.action === 'installed' ? 'installed' : 'was already installed'}\n                     ${result.inspection.executablePath}\n                     binary SHA-256 ${result.inspection.record?.binarySha256 ?? 'unavailable'}\n                     Recording finds it from this checked cache. ffmpeg is a separate host prerequisite.\n`
}
