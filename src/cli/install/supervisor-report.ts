import type { Marks } from '../../reporters/style.ts'
import type { SupervisorInspection } from './supervisor-record.ts'
import type { SupervisorInstallResult } from './supervisor-install.ts'
import { isArray, isPlainObject } from '../../protocol/schema.ts'
import { unicodeMarks } from '../../reporters/style.ts'
import { supervisorSourceDigest } from './supervisor-pins.ts'
import { supervisorInstallCommand } from './supervisor-locate.ts'

/**
 * Adds the supervisor to the install list, as text or as one more build in the JSON document. Where no supervisor is
 * needed there is nothing to add, and the list is left exactly as it was.
 */
export function renderSupervisorListing(listing: string, inspection: SupervisorInspection | undefined, json: boolean): string {
  if (inspection === undefined) return listing
  if (!json) {
    const problems = inspection.problems.map((problem) => `                   ${problem}\n`).join('')
    const last = inspection.record === undefined ? `Run ${supervisorInstallCommand}.` : `binary SHA-256 ${inspection.record.binarySha256}`
    return `${listing}\n  supervisor       retest-supervisor ${inspection.version}, ${inspection.target}\n                   ${inspection.state}\n                   ${inspection.executablePath}\n${problems}                   ${last}\n`
  }
  const document: unknown = JSON.parse(listing)
  if (!isPlainObject(document) || document['schemaVersion'] !== 1 || !isArray(document['builds'])) throw new Error('The install list did not match its versioned document.')
  const supervisor = {
    engine: 'supervisor', title: 'retest-supervisor', version: inspection.version, target: inspection.target, source: 'shipped crate source', pinnedSha256: null,
    sourceDigest: supervisorSourceDigest, state: inspection.state, folder: inspection.folder, executablePath: inspection.executablePath,
    binarySha256: inspection.record?.binarySha256, rustcVersion: inspection.record?.rustcVersion, installedAt: inspection.record?.installedAt,
    problems: inspection.problems, install: { command: supervisorInstallCommand },
  }
  return `${JSON.stringify({ ...document, builds: [...document['builds'], supervisor] }, null, 2)}\n`
}

/** The install's outcome, marked as the console can draw it: a plain Windows console has no check or cross glyph. */
export function renderSupervisorInstall(result: SupervisorInstallResult, marks: Marks = unicodeMarks): string {
  if (!result.ok) return `  ${marks.failed} supervisor       ${result.message}\n`
  return `  ${marks.passed} supervisor       retest-supervisor ${result.inspection.version} ${result.action === 'installed' ? 'installed' : 'was already installed'}\n                     ${result.inspection.executablePath}\n                     binary SHA-256 ${result.inspection.record?.binarySha256 ?? 'unavailable'}\n                     Runs find it in this checked cache.\n`
}
