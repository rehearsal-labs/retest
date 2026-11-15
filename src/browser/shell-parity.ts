import type { BrowserVersion } from './browser.ts'
import type { CdpConnection } from './cdp/connection.ts'
import type { CdpSession } from './cdp/session.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { Emulation } from '../protocol/emulation.ts'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { s } from '../protocol/schema.ts'
import { request, sendOptions } from './cdp-results.ts'
import { recordedScreen } from './default-window.ts'

// Chrome's headless shell is Chromium's web engine without the browser Chrome for Testing wraps around it, so some of
// what a page reads comes from that browser and is missing or different in the shell. What follows is what Retest gives
// the shell so a page reads what it reads in Chrome for Testing of the same release, each piece measured against it on
// Linux x64 and macOS arm64 (Chrome for Testing 153.0.8010.12, 15 November 2026). What cannot be given is listed in
// docs/guide.md.

/** The product Chrome's headless shell names itself in `Browser.getVersion`. Chrome for Testing names itself `Chrome`. */
export const shellProduct = 'HeadlessChrome'

/** Chrome's own default font families, which Chrome reads from its settings and the shell does not have. */
export type FontFamilies = {
  readonly fontFamilies: Readonly<Record<string, string>>
  readonly forScripts?: readonly { readonly script: string; readonly fontFamilies: Readonly<Record<string, string>> }[]
}

/** What a client hint says of the browser, as `Emulation.setUserAgentOverride` takes it. */
export type UserAgentMetadata = {
  readonly brands: readonly { readonly brand: string; readonly version: string }[]
  readonly fullVersionList: readonly { readonly brand: string; readonly version: string }[]
  readonly platform: string
  readonly platformVersion: string
  readonly architecture: string
  readonly model: string
  readonly mobile: boolean
  readonly bitness: string
  readonly wow64: boolean
  readonly formFactors: readonly string[]
}

/**
 * What a page of the shell is given: the languages, and where Retest knows them, Chrome's user agent and client hints;
 * Chrome's default fonts; and the permissions Chrome grants without asking. The window a page with no viewport reads is
 * given to both programs, in src/browser/default-window.ts.
 */
export type ShellParity = {
  readonly userAgent: { readonly userAgent: string; readonly acceptLanguage: string; readonly userAgentMetadata?: UserAgentMetadata }
  readonly fonts: FontFamilies
  readonly permissions: readonly string[]
}

/** The machine the shell runs on, as Chrome reads it for a page. */
export type ShellHost = {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly env: Readonly<Record<string, string | undefined>>
  /** The macOS version as the system names it, such as `27.2`, where it could be read. */
  readonly macosVersion?: string | undefined
  /** On Windows, the version Chrome gives as the platform's, such as `19.0.0`, where it could be read. */
  readonly windowsVersion?: string | undefined
}

const empty = s.object({})

// Chrome's defaults from its locale_settings_linux, _mac and _win resources and its per-script font settings, as
// Playwright 1.65.1 sends them to every Chromium page (playwright-core, platformToFontFamilies, Apache-2.0), except the
// fixed family on macOS: Chrome for Testing 153 resolves monospace to Menlo there, where that table names Courier. Held
// against Chrome for Testing 153, the shell with these tables drew a page of text and form controls pixel for pixel as it
// did on Linux and Windows, and on macOS differed in 215 of 312,228 pixels, at form controls; without them the generic
// families were other fonts on Linux and macOS. The per-script tables were not checked.
const chromeFonts: Readonly<Record<'linux' | 'darwin' | 'win32', FontFamilies>> = {
  linux: { fontFamilies: { standard: 'Times New Roman', fixed: 'Monospace', serif: 'Times New Roman', sansSerif: 'Arial', cursive: 'Comic Sans MS', fantasy: 'Impact' } },
  darwin: {
    fontFamilies: { standard: 'Times', fixed: 'Menlo', serif: 'Times', sansSerif: 'Helvetica', cursive: 'Apple Chancery', fantasy: 'Papyrus' },
    forScripts: [
      { script: 'jpan', fontFamilies: { standard: 'Hiragino Kaku Gothic ProN', fixed: 'Osaka-Mono', serif: 'Hiragino Mincho ProN', sansSerif: 'Hiragino Kaku Gothic ProN' } },
      { script: 'hang', fontFamilies: { standard: 'Apple SD Gothic Neo', serif: 'AppleMyungjo', sansSerif: 'Apple SD Gothic Neo' } },
      { script: 'hans', fontFamilies: { standard: ',PingFang SC,STHeiti', serif: 'Songti SC', sansSerif: ',PingFang SC,STHeiti', cursive: 'Kaiti SC' } },
      { script: 'hant', fontFamilies: { standard: ',PingFang TC,Heiti TC', serif: 'Songti TC', sansSerif: ',PingFang TC,Heiti TC', cursive: 'Kaiti TC' } },
    ],
  },
  win32: {
    fontFamilies: { standard: 'Times New Roman', fixed: 'Consolas', serif: 'Times New Roman', sansSerif: 'Arial', cursive: 'Comic Sans MS', fantasy: 'Impact' },
    forScripts: [
      { script: 'cyrl', fontFamilies: { standard: 'Times New Roman', fixed: 'Courier New', serif: 'Times New Roman', sansSerif: 'Arial' } },
      { script: 'arab', fontFamilies: { fixed: 'Courier New', sansSerif: 'Segoe UI' } },
      { script: 'grek', fontFamilies: { standard: 'Times New Roman', fixed: 'Courier New', serif: 'Times New Roman', sansSerif: 'Arial' } },
      { script: 'jpan', fontFamilies: { standard: ',Meiryo,Yu Gothic', fixed: 'MS Gothic', serif: ',Yu Mincho,MS PMincho', sansSerif: ',Meiryo,Yu Gothic' } },
      { script: 'hang', fontFamilies: { standard: 'Malgun Gothic', fixed: 'Gulimche', serif: 'Batang', sansSerif: 'Malgun Gothic', cursive: 'Gungsuh' } },
      { script: 'hans', fontFamilies: { standard: 'Microsoft YaHei', fixed: 'NSimsun', serif: 'Simsun', sansSerif: 'Microsoft YaHei', cursive: 'KaiTi' } },
      { script: 'hant', fontFamilies: { standard: 'Microsoft JhengHei', fixed: 'MingLiU', serif: 'PMingLiU', sansSerif: 'Microsoft JhengHei', cursive: 'DFKai-SB' } },
    ],
  },
}

// The permissions Chrome for Testing reads as granted on a page no one has granted anything, which the shell reads as
// `prompt`. `storage-access` is left out: Chrome's grant holds for a top-level page only, and one for every origin would
// reach frames of other sites too.
const grantedByChrome: readonly string[] = ['clipboard-write', 'background-sync', 'screen-wake-lock']

/**
 * The machine this process runs on, with the macOS version read from the system's own record of it, as Chrome reads
 * its own; Node gives only the kernel's.
 */
export function thisHost(): ShellHost {
  return { platform: process.platform, arch: process.arch, env: process.env, macosVersion: process.platform === 'darwin' ? readMacosVersion() : undefined }
}

// Reading the Windows version starts a program, so it is read once for the process; the version is the machine's.
let windowsVersionReading: Promise<string | undefined> | undefined

/**
 * The machine as Chrome's headless shell is given it: `thisHost()`, and on Windows the version Chrome gives as the
 * platform's, read from the registry as Chrome reads it. A launch reads it while the shell starts.
 */
export async function shellHost(): Promise<ShellHost> {
  const host = thisHost()
  if (host.platform !== 'win32') return host
  windowsVersionReading ??= readWindowsVersion()
  return { ...host, windowsVersion: await windowsVersionReading }
}

/**
 * What a page of this browser is given to read as Chrome for Testing does, or undefined for any browser but the
 * headless shell.
 *
 * @example shellParity({ product: 'HeadlessChrome', version: '153.0.8010.12', userAgent }, { platform: 'linux', arch: 'x64', env: process.env })?.userAgent.acceptLanguage // 'en-US,en'
 */
export function shellParity(version: BrowserVersion, given?: ShellHost): ShellParity | undefined {
  if (version.product !== shellProduct) return undefined
  const host = given ?? thisHost()
  const acceptLanguage = chromeLanguages(host.platform, host.env)
  const major = version.version.split('.')[0] ?? ''
  const shellAgent = `${shellProduct}/${version.version}`
  // Chrome gives its major version and zeros in its user agent, where the shell gives the whole version.
  const reduced = /^\d+$/.test(major) && version.userAgent.includes(shellAgent) ? version.userAgent.replace(shellAgent, `${shellProduct}/${major}.0.0.0`) : undefined
  // Chrome's client hints name Chromium and a grease brand, where the shell's add a HeadlessChrome brand. The other
  // hints are the operating system's: on Linux Chrome gives no platform version, on macOS the system's version, and on
  // Windows the version of the system's API contract; where Retest could not read it, the shell keeps its own.
  const system = clientHintsSystem(host)
  const metadata = reduced === undefined || system === undefined ? undefined : chromeMetadata(Number(major), version.version, system)
  const userAgent = metadata === undefined ? { userAgent: '', acceptLanguage } : { userAgent: reduced ?? '', acceptLanguage, userAgentMetadata: metadata }
  const fonts = host.platform === 'darwin' || host.platform === 'win32' ? chromeFonts[host.platform] : chromeFonts.linux
  return { userAgent, fonts, permissions: grantedByChrome }
}

/**
 * The switches the shell starts with to act as Chrome does: a process for each site, as Chrome's site isolation gives
 * a frame of another site; Chrome's languages for requests a page's own override does not reach, as a worker's; and
 * the window and screen Retest 0.4.2's Chrome for Testing had, where they were read. The shell otherwise makes its
 * screen the size of its window.
 *
 * @example shellSwitches('linux', { LANG: 'C.UTF-8' }) // ['--site-per-process', '--accept-lang=en-US,en', '--window-size=780,580', '--screen-info={0,0 800x600}']
 */
export function shellSwitches(platform: NodeJS.Platform = process.platform, env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const recorded = recordedScreen(platform)
  const window = recorded === undefined ? [] : [`--window-size=${recorded.window.width},${recorded.window.height}`, `--screen-info={0,0 ${recorded.screen.width}x${recorded.screen.height}}`]
  return ['--site-per-process', `--accept-lang=${chromeLanguages(platform, env)}`, ...window]
}

/**
 * The commands that give one page of the shell what Chrome would: the languages and user agent, and the fonts. They go
 * out with the page's other set-up, after its emulation: a device's own user agent stands, as on Chrome, with Chrome's
 * languages beside it.
 */
export function parityRequests(session: CdpSession, parity: ShellParity, emulation: Emulation | undefined, deadline: Deadline): Promise<unknown>[] {
  const sent = sendOptions(deadline)
  const agent = emulation?.userAgent === undefined ? parity.userAgent : { userAgent: emulation.userAgent, acceptLanguage: parity.userAgent.acceptLanguage }
  return [
    request(session, 'Emulation.setUserAgentOverride', agent, empty, sent),
    request(session, 'Page.setFontFamilies', parity.fonts, empty, sent),
  ]
}

/** Grants a new browser context of the shell the permissions Chrome grants without asking, for every origin. */
export function grantChromeDefaults(connection: CdpConnection, browserContextId: string, parity: ShellParity, deadline: Deadline): Promise<unknown>[] {
  return parity.permissions.map((name) => request(connection, 'Browser.setPermission', { permission: { name }, setting: 'granted', browserContextId }, empty, sendOptions(deadline)))
}

/**
 * The languages Chrome sends, from the locale it starts in: on Linux the first of LANGUAGE, LC_ALL, LC_MESSAGES and LANG
 * that is set, as Chrome reads them, and the C locale as American English; elsewhere the locale Node reads, which can
 * differ from the one Chrome takes from the system's own settings. Chrome lists the locale, then its language, then
 * American English after any other language. Checked against Chrome for Testing for en_US and fr_FR on Linux.
 *
 * @example chromeLanguages('linux', { LANG: 'fr_FR.UTF-8' }) // 'fr-FR,fr,en-US,en'
 */
export function chromeLanguages(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>): string {
  const setting = platform === 'linux'
    ? [env['LANGUAGE']?.split(':')[0], env['LC_ALL'], env['LC_MESSAGES'], env['LANG']].find((value) => value !== undefined && value !== '')
    : Intl.DateTimeFormat().resolvedOptions().locale
  const locale = /^([a-z]{2,3})(?:[_-]([A-Za-z]{2}))?(?:[.@].*)?$/.exec(setting ?? '')
  const language = locale?.[1]
  if (language === undefined) return 'en-US,en'
  const region = locale?.[2]
  const own = region === undefined ? [language] : [`${language}-${region.toUpperCase()}`, language]
  return [...own, ...(language === 'en' ? [] : ['en-US', 'en'])].join(',')
}

/** The operating system a client hint names, and its version as Chrome gives it. */
type HintedSystem = { readonly platform: string; readonly platformVersion: string; readonly arch: string }

// What Chrome for Testing 153 named the system in its client hints: on Linux no version, on macOS the system's version
// in three parts (27.2.0 on macOS 27.2), and on Windows the version Retest read as Chrome reads it (19.0.0 on Windows
// Server 2025).
function clientHintsSystem(host: ShellHost): HintedSystem | undefined {
  if (host.platform === 'linux') return { platform: 'Linux', platformVersion: '', arch: host.arch }
  if (host.platform === 'win32') return host.windowsVersion === undefined ? undefined : { platform: 'Windows', platformVersion: host.windowsVersion, arch: host.arch }
  if (host.platform !== 'darwin' || host.macosVersion === undefined) return undefined
  const parts = host.macosVersion.split('.')
  if (parts.length > 3 || !parts.every((part) => /^\d+$/.test(part))) return undefined
  return { platform: 'macOS', platformVersion: [...parts, '0', '0'].slice(0, 3).join('.'), arch: host.arch }
}

// Chromium's components/embedder_support/user_agent_utils.cc (BSD-3-Clause) gives Windows 10 1809 and later the version
// of the Windows.Foundation.UniversalApiContract in the registry: its high word, its low word, then 0.
const contractKey = 'HKLM\\SOFTWARE\\Microsoft\\WindowsRuntime\\WellKnownContracts'
const contractValue = 'Windows.Foundation.UniversalApiContract'

function readWindowsVersion(): Promise<string | undefined> {
  const reg = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'reg.exe')
  return new Promise((resolve) => {
    execFile(reg, ['query', contractKey, '/v', contractValue], { windowsHide: true, timeout: 5_000 }, (error, stdout) => resolve(error === null ? windowsVersionFrom(stdout) : undefined))
  })
}

/**
 * The platform version Chrome gives on Windows, from what `reg query` prints of the contract's value, or undefined.
 *
 * @example windowsVersionFrom('    Windows.Foundation.UniversalApiContract    REG_DWORD    0x130000') // '19.0.0'
 */
export function windowsVersionFrom(printed: string): string | undefined {
  const found = /Windows\.Foundation\.UniversalApiContract\s+REG_DWORD\s+0x([0-9a-fA-F]{1,8})\b/.exec(printed)?.[1]
  if (found === undefined) return undefined
  const value = Number.parseInt(found, 16)
  return `${Math.floor(value / 0x10000)}.${value % 0x10000}.0`
}

function readMacosVersion(): string | undefined {
  try {
    return /<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync('/System/Library/CoreServices/SystemVersion.plist', 'utf8'))?.[1]
  } catch {
    return undefined
  }
}

// Chrome's client hints. The brands are listed as Chromium's components/embedder_support/user_agent_utils.cc orders a
// Chromium build's (BSD-3-Clause): the grease brand and Chromium, placed and named by the major version.
function chromeMetadata(major: number, fullVersion: string, system: HintedSystem): UserAgentMetadata {
  const greaseCharacters = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_']
  const greaseVersions = ['8', '99', '24']
  const greaseBrand = `Not${greaseCharacters[major % greaseCharacters.length]}A${greaseCharacters[(major + 1) % greaseCharacters.length]}Brand`
  const greaseVersion = greaseVersions[major % greaseVersions.length] ?? '8'
  const placed = (chromium: string, grease: string) => {
    const list = [{ brand: '', version: '' }, { brand: '', version: '' }]
    list[major % 2] = { brand: greaseBrand, version: grease }
    list[(major + 1) % 2] = { brand: 'Chromium', version: chromium }
    return list
  }
  return {
    brands: placed(String(major), greaseVersion),
    fullVersionList: placed(fullVersion, `${greaseVersion}.0.0.0`),
    platform: system.platform,
    platformVersion: system.platformVersion,
    architecture: system.arch === 'arm64' ? 'arm' : 'x86',
    model: '',
    mobile: false,
    bitness: system.arch === 'ia32' ? '32' : '64',
    wow64: false,
    formFactors: ['Desktop'],
  }
}
