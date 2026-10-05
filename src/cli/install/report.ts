import type { BuildEngine, BuildInspection, BuildPin, BuildPlatform, BuildSourceCode, CacheFolders, PinnedLicences, PinRefusal } from '../../browser/builds.ts'
import type { Style } from '../../reporters/style.ts'
import type { InstallResult } from './install-archive.ts'
import { dirname, join } from 'node:path'
import { buildFolder, describePin, describePlatform, pinRefusal, treeFolder } from '../../browser/builds.ts'
import { retestCommand } from '../../reporters/commands.ts'
import { addressProblem } from './download.ts'

/** The variable that names a mirror to fetch pinned archives from instead of their publishers. */
export const mirrorVariable = 'RETEST_DOWNLOAD_MIRROR'

const engineColumn = 17

/** Detailed notice events retained for verification and machine reports. The CLI prints its own short wording. */
export function licenceLines(pin: BuildPin): string[] {
  if (!pin.licences.inspected) return []
  const lines = pin.licences.files.map((file) => `Licence ${file.path}, ${file.licence}${file.sha256 === undefined ? '' : `, SHA-256 ${file.sha256}`}${file.bundled === undefined ? '' : ', supplied by Retest and retained with the build'}`)
  if (pin.kind === 'archive' && pin.sourceCode !== undefined) {
    lines.push(`Source ${pin.sourceCode.repository}/tree/${pin.sourceCode.revision}`, `Patches ${pin.sourceCode.patches}`)
  }
  return lines
}

const licenceNames: Readonly<Record<BuildEngine, string>> = {
  chromium: 'BSD and Widevine',
  firefox: 'MPL 2.0',
  webkit: 'LGPL 2.1 and BSD',
  electron: 'MIT and BSD',
  webdriveragent: 'BSD and Apache 2.0',
  mac2: 'Apache 2.0 and BSD',
}

/** The project's licence names; component terms remain in the full notices and JSON pin. */
export function licenceSummary(pin: BuildPin): string | undefined {
  return pin.licences.inspected && pin.licences.files.length > 0 ? `${licenceNames[pin.engine]}, notices kept with the build` : undefined
}

/** The one notice message printed for each engine named in an install. */
export function installLicenceText(pin: BuildPin, folders: CacheFolders): string | undefined {
  if (licenceSummary(pin) === undefined) return undefined
  if (pin.engine === 'webkit') {
    const folder = join(buildFolder(folders, pin), treeFolder, 'licenses')
    return `WebKit is open source. Its licence notices are kept with the build in ${folder}; \`retest licences webkit\` prints them.`
  }
  const name = pin.engine === 'webdriveragent' ? 'WebDriverAgent' : pin.engine === 'mac2' ? 'The macOS executor' : pin.title
  return `${name} is open source; its licence notices are kept with the build, and \`retest licences ${pin.engine}\` prints them.`
}

/**
 * Why a mirror address cannot be used, or undefined when it can: the rules every download address follows, and no
 * query or fragment. Retest prints and records only an address's origin and path, and a pinned path is put after the
 * mirror's, so a query or fragment would both hide a token in what is not shown and swallow the path. The refusal
 * never repeats the address.
 *
 * @example mirrorProblem('ftp://mirror.example.com') // 'RETEST_DOWNLOAD_MIRROR: Retest downloads only over https, …'
 */
export function mirrorProblem(mirror: string): string | undefined {
  let url: URL
  try {
    url = new URL(mirror)
  } catch {
    return `${mirrorVariable} is not an address.`
  }
  const problem = addressProblem(url)
  if (problem !== undefined) return `${mirrorVariable}: ${problem}`
  if (url.search !== '' || mirror.includes('?')) return `${mirrorVariable} carries a query, which Retest neither sends to a mirror nor records. Give the mirror's address without it.`
  if (url.hash !== '' || mirror.includes('#')) return `${mirrorVariable} carries a fragment, which Retest neither sends to a mirror nor records. Give the mirror's address without it.`
  return undefined
}

/**
 * One engine's install as the terminal shows it: a mark, the engine, what happened, and for an installed build its
 * path and checksum, or the reason it is not installed.
 *
 * @example describeResult('electron', result, createStyle(false))
 */
export function describeResult(engine: BuildEngine, result: InstallResult, style: Style): string {
  const indent = ' '.repeat(4 + engineColumn)
  if (!result.ok && result.notices !== undefined) return [`  ${style.red('✗')} ${engine.padEnd(engineColumn)}${result.notices.lead}`, ...result.notices.files.map((file) => `${indent}${file.path}, ${file.title}`), ''].join('\n')
  if (!result.ok) return `  ${style.red('✗')} ${engine.padEnd(engineColumn)}${result.message}\n`
  const { inspection } = result
  const lines = [`  ${style.green('✓')} ${engine.padEnd(engineColumn)}${describePin(inspection.pin)} ${result.action === 'installed' ? 'installed' : 'was already installed'}`]
  if (inspection.executablePath !== undefined) lines.push(`${indent}${inspection.executablePath}`)
  else lines.push(`${indent}${inspection.folder}`)
  if (inspection.sha256 !== undefined) lines.push(`${indent}${style.dim(`${inspection.pin.kind === 'archive' ? 'archive' : 'products'} SHA-256 ${inspection.sha256}`)}`)
  const hint = usageHint(engine, inspection)
  if (hint !== undefined) lines.push(`${indent}${style.dim(hint)}`)
  return `${lines.join('\n')}\n`
}

/** What `renderInspections` prints. */
export type InspectionReport = {
  readonly platform: BuildPlatform
  readonly folders: CacheFolders
  readonly inspections: readonly BuildInspection[]
  readonly json: boolean
  readonly style: Style
}

/**
 * The pinned builds for this machine and how each stands in the cache, as lines or as one JSON document. A build not
 * installed shows the command that installs it, or why `retest install` refuses it.
 *
 * @example renderInspections({ platform: 'mac-arm64', folders, inspections, json: false, style })
 */
export function renderInspections(report: InspectionReport): string {
  if (report.json) return `${JSON.stringify(inspectionsDocument(report), null, 2)}\n`
  const { style } = report
  const titleWidth = Math.max(...report.inspections.map((inspection) => describePin(inspection.pin).length)) + 3
  const indent = ' '.repeat(4 + engineColumn + titleWidth)
  const lines = ['', `  Pinned builds for ${describePlatform(report.platform)}, in ${dirname(report.folders.browsers)}`, '']
  for (const inspection of report.inspections) {
    const { pin } = inspection
    const head = `  ${pin.engine.padEnd(engineColumn)}${describePin(pin).padEnd(titleWidth)}`
    const refusal = pinRefusal(pin)
    if (inspection.state === 'installed') {
      lines.push(`${head}${style.green('✓')} installed${inspection.sha256 === undefined ? '' : style.dim(` · ${pin.kind === 'archive' ? 'archive' : 'products'} SHA-256 ${inspection.sha256}`)}`)
      lines.push(`${indent}${inspection.executablePath ?? inspection.folder}`)
    } else if (inspection.state === 'damaged') {
      // Only a pin `retest install` installs is ever damaged, so running it again is a fix it accepts.
      lines.push(`${head}${style.red('✗')} not as recorded in ${inspection.folder}`)
      for (const problem of inspection.problems) lines.push(`${indent}${problem}`)
      lines.push(`${indent}Remove the folder and run ${retestCommand} install ${pin.engine} again.`)
    } else if (inspection.state === 'unverifiable') {
      // Nothing in such a folder was read, since no install of Retest's put it there to check against the pin.
      lines.push(`${head}${style.red('✗')} not installed by Retest, and nothing in ${inspection.folder} was checked`)
      lines.push(`${indent}Remove the folder.`)
      if (refusal !== undefined) lines.push(...refusalLines(pin.engine, refusal, indent, style))
    } else {
      lines.push(`${head}- not installed${refusal === undefined ? style.dim(` · ${retestCommand} install ${pin.engine}`) : ''}`)
      if (refusal !== undefined) lines.push(...refusalLines(pin.engine, refusal, indent, style))
    }
    const licences = licenceSummary(pin)
    if (licences !== undefined) lines.push(`${indent}${licences}`)
  }
  const damaged = report.inspections.filter((inspection) => inspection.state === 'damaged').length
  const unverifiable = report.inspections.filter((inspection) => inspection.state === 'unverifiable').length
  const closing = [
    ...(damaged === 0 ? [] : [style.red(`  ${damaged === 1 ? 'One build does' : `${damaged} builds do`} not match ${damaged === 1 ? 'its record' : 'their records'}.`)]),
    ...(unverifiable === 0 ? [] : [style.red(`  ${unverifiable === 1 ? 'One folder holds a build' : `${unverifiable} folders hold builds`} that Retest does not install and did not check.`)]),
  ]
  lines.push('', ...(closing.length === 0 ? ['  Nothing was downloaded.'] : closing), '')
  return lines.join('\n')
}

// Why `retest install` refuses a pin, under the line that names the pin: the reason, or each notice it lacks.
function refusalLines(engine: string, refusal: PinRefusal, indent: string, style: Style): string[] {
  if (refusal.missing.length === 0) return [`${indent}${style.dim(`${retestCommand} install ${engine} refuses it: ${refusal.message}`)}`]
  return [
    `${indent}${style.dim(`${retestCommand} install ${engine} refuses it: it is published without these licence notices, and Retest installs it only once they ship with it:`)}`,
    ...refusal.missing.map((file) => `${indent}  ${style.dim(`${file.path}, ${file.title}`)}`),
  ]
}

/** One pin in the JSON document `retest install --list --json` prints. */
export type ListedBuild = {
  readonly engine: string
  readonly title: string
  readonly version: string
  readonly build?: string
  readonly platform: BuildPlatform
  readonly source: string
  readonly pinnedSha256: string | null
  readonly state: BuildInspection['state']
  readonly folder: string
  readonly executablePath?: string
  readonly sha256?: string
  readonly installedAt?: string
  readonly problems: readonly string[]
  readonly licences: PinnedLicences
  readonly sourceCode?: BuildSourceCode
  readonly install: { readonly command: string } | { readonly refused: string; readonly missingNotices?: readonly string[] }
}

function inspectionsDocument(report: InspectionReport): { readonly schemaVersion: 1; readonly platform: BuildPlatform; readonly cache: CacheFolders; readonly builds: readonly ListedBuild[] } {
  return {
    schemaVersion: 1,
    platform: report.platform,
    cache: report.folders,
    builds: report.inspections.map((inspection): ListedBuild => {
      const { pin } = inspection
      const refusal = pinRefusal(pin)
      return {
        engine: pin.engine,
        title: pin.title,
        version: pin.version,
        ...(pin.kind === 'archive' && pin.build !== undefined ? { build: pin.build } : {}),
        platform: pin.platform,
        source: pin.kind === 'archive' ? pin.archive.url : `${pin.repository}@${pin.commit}`,
        pinnedSha256: pin.kind === 'archive' ? (pin.archive.sha256 ?? null) : null,
        state: inspection.state,
        folder: inspection.folder,
        ...(inspection.executablePath === undefined ? {} : { executablePath: inspection.executablePath }),
        ...(inspection.sha256 === undefined ? {} : { sha256: inspection.sha256 }),
        ...(inspection.installedAt === undefined ? {} : { installedAt: inspection.installedAt }),
        problems: inspection.problems,
        licences: pin.licences,
        ...(pin.kind === 'archive' && pin.sourceCode !== undefined ? { sourceCode: pin.sourceCode } : {}),
        install: refusal === undefined ? { command: `${retestCommand} install ${pin.engine}` } : { refused: [refusal.message, ...(pin.licences.inspected && pin.licences.files.some(file => file.bundled !== undefined) ? licenceLines(pin) : [])].join('\n'), ...(refusal.missing.length === 0 ? {} : { missingNotices: refusal.missing.map((file) => file.path) }) },
      }
    }),
  }
}

// How a target comes to run what was installed, as each engine's driver looks for a binary: a Firefox target with no
// path runs the installed pinned build (src/browser/firefox/executable.ts), the others run it once a path names it.
function usageHint(engine: BuildEngine, inspection: BuildInspection): string | undefined {
  if (inspection.executablePath === undefined) return undefined
  if (engine === 'chromium') return `A chromium() target runs it once its executablePath, or RETEST_CHROMIUM, names this path.`
  if (engine === 'electron') return `An electron() target runs it once its executablePath names this path.`
  if (engine === 'webkit') return `A WebKit target runs it once its executablePath, or RETEST_WEBKIT_BUILD, names this path.`
  if (engine === 'firefox') return `A Firefox target that names no executablePath runs it.`
  return undefined
}
