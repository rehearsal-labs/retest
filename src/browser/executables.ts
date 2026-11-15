import type { Failure } from '../protocol/failures.ts'
import { existsSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'
import { retestCommand } from '../reporters/commands.ts'
import { listWords } from '../shared/list-words.ts'
import { buildFolder, buildPlatform, cacheFolders, environmentVariable, findPin, installedExecutablePath, recordFile } from './builds.ts'

/** `headless-shell` is Chrome's headless shell, a separate program built from the same Chromium release. */
export type BrowserProduct = 'chromium' | 'headless-shell' | 'chrome' | 'edge'

export type BrowserChannel = 'stable' | 'beta' | 'dev' | 'canary'

/** Which browser a target wants. `executablePath` names the binary itself; `channel` applies to Chrome and Edge. */
export type ExecutableRequest = { product: BrowserProduct; channel?: BrowserChannel; executablePath?: string }

/** The two Chromium programs `retest install chromium` puts in Retest's cache. */
export type CachedChromium = 'chromium' | 'headless-shell'

/**
 * What resolution reads of the machine it runs on. `installed` names the binary of a pinned build in Retest's cache
 * when its folder holds one with its record, without reading its files, which a run checks before it launches it.
 */
export type ExecutableHost = {
  platform: NodeJS.Platform
  env: Readonly<Record<string, string | undefined>>
  exists(path: string): boolean
  installed?(engine: CachedChromium): string | undefined
}

/**
 * The executable to launch, or why there is none and every path that was looked at. `cached` names the engine whose
 * build in Retest's cache the path is, when it came from there.
 */
export type ResolvedExecutable = { ok: true; path: string; cached?: CachedChromium } | { ok: false; failure: Failure; tried: string[] }

/** Where one channel installs: its app's name on macOS, its paths on Linux, and its path under each Windows root. */
type Install = { name: string; mac: string; linux: readonly string[]; windows: string }

const chromiumVariable = 'RETEST_CHROMIUM'
/** The variable a headless `chromium()` target with no executablePath reads the headless shell's path from. */
export const headlessShellVariable = 'RETEST_HEADLESS_SHELL'

const installs: Readonly<Record<'chrome' | 'edge', Readonly<Record<BrowserChannel, Install>>>> = {
  chrome: {
    stable: { name: 'Google Chrome', mac: 'Google Chrome', linux: ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'], windows: 'Google\\Chrome\\Application\\chrome.exe' },
    beta: { name: 'Google Chrome Beta', mac: 'Google Chrome Beta', linux: ['/opt/google/chrome-beta/chrome', '/usr/bin/google-chrome-beta'], windows: 'Google\\Chrome Beta\\Application\\chrome.exe' },
    dev: { name: 'Google Chrome Dev', mac: 'Google Chrome Dev', linux: ['/opt/google/chrome-unstable/chrome', '/usr/bin/google-chrome-unstable'], windows: 'Google\\Chrome Dev\\Application\\chrome.exe' },
    // Canary installs side by side with the others, in the folder Google names SxS.
    canary: { name: 'Google Chrome Canary', mac: 'Google Chrome Canary', linux: ['/opt/google/chrome-canary/chrome', '/usr/bin/google-chrome-canary'], windows: 'Google\\Chrome SxS\\Application\\chrome.exe' },
  },
  edge: {
    stable: { name: 'Microsoft Edge', mac: 'Microsoft Edge', linux: ['/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge-stable', '/usr/bin/microsoft-edge'], windows: 'Microsoft\\Edge\\Application\\msedge.exe' },
    beta: { name: 'Microsoft Edge Beta', mac: 'Microsoft Edge Beta', linux: ['/opt/microsoft/msedge-beta/msedge', '/usr/bin/microsoft-edge-beta'], windows: 'Microsoft\\Edge Beta\\Application\\msedge.exe' },
    dev: { name: 'Microsoft Edge Dev', mac: 'Microsoft Edge Dev', linux: ['/opt/microsoft/msedge-dev/msedge', '/usr/bin/microsoft-edge-dev'], windows: 'Microsoft\\Edge Dev\\Application\\msedge.exe' },
    // Microsoft publishes no Canary build of Edge for Linux.
    canary: { name: 'Microsoft Edge Canary', mac: 'Microsoft Edge Canary', linux: [], windows: 'Microsoft\\Edge SxS\\Application\\msedge.exe' },
  },
}

// A browser installs for every user under Program Files, its 32-bit twin on 64-bit Windows, or for one person under
// their local application data, which needs no administrator.
const windowsRoots = ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'] as const

/**
 * Finds the browser a target launches: the path it names, `RETEST_CHROMIUM` for `chromium`, `RETEST_HEADLESS_SHELL`
 * for the headless shell, or the standard install locations of Chrome and Edge on macOS, Linux and Windows. A path
 * given for the headless shell must name a file called chrome-headless-shell. Reads the machine only through `host`.
 *
 * @example resolveExecutable({ product: 'chrome', channel: 'beta' }, systemHost())
 */
export function resolveExecutable(request: ExecutableRequest, host: ExecutableHost): ResolvedExecutable {
  if (host.platform !== 'darwin' && host.platform !== 'linux' && host.platform !== 'win32') {
    return notFound('unsupported', `Retest runs browsers on macOS, Linux and Windows, not on ${host.platform}.`, [])
  }
  if (request.product === 'headless-shell') return headlessShell(request, host)
  if (request.executablePath !== undefined) return atPath(request.executablePath, 'executablePath', host)
  if (request.product === 'chromium') return chromium(request, host)
  const install = installs[request.product][request.channel ?? 'stable']
  const tried = host.platform === 'darwin' ? macPaths(install.mac, host) : host.platform === 'win32' ? windowsPaths(install.windows, host) : [...install.linux]
  if (tried.length === 0 && host.platform === 'win32') return notFound('setup_failed', `Retest has no folder to look for ${install.name} in: none of ${listWords(windowsRoots, 'and')} names an absolute folder.`, [])
  if (tried.length === 0) return notFound('setup_failed', `${install.name} is not made for Linux. Choose another channel.`, [])
  const found = tried.find((path) => host.exists(path))
  if (found !== undefined) return { ok: true, path: found }
  return notFound('setup_failed', `${install.name} is not installed. Retest looked in ${tried.join(', ')}. Install it, or choose another target.`, tried)
}

/**
 * Where Firefox installs on this kind of machine, for a Firefox target that names no executable and has no pinned
 * build: the app in /Applications on macOS, and Mozilla's folder under each Windows root. Nothing is looked for on
 * Linux, where Retest does not run Firefox.
 *
 * @example systemFirefoxPaths({ platform: 'darwin', env: {}, exists: existsSync }) // ['/Applications/Firefox.app/Contents/MacOS/firefox']
 */
export function systemFirefoxPaths(host: ExecutableHost): string[] {
  if (host.platform === 'darwin') return ['/Applications/Firefox.app/Contents/MacOS/firefox']
  if (host.platform === 'win32') return windowsPaths('Mozilla Firefox\\firefox.exe', host)
  return []
}

/**
 * The machine Retest runs on, for `resolveExecutable`.
 *
 * @example resolveExecutable({ product: 'chromium' }, systemHost())
 */
export function systemHost(): ExecutableHost {
  return { platform: process.platform, env: process.env, exists: existsSync, installed: (engine) => cachedBinary(engine, process.env) }
}

/**
 * The binary of the pinned build of `engine` in this user's Retest cache, when its folder holds the binary and the record
 * `retest install` writes beside it. Nothing is read beyond their being there.
 *
 * @example cachedBinary('headless-shell', process.env) // '/home/ada/.cache/retest/browsers/headless-shell-153.0.8010.12-linux-x64/build/chrome-headless-shell-linux64/chrome-headless-shell'
 */
export function cachedBinary(engine: CachedChromium, env: Readonly<Record<string, string | undefined>>): string | undefined {
  const folders = cacheFolders(env)
  const platform = buildPlatform()
  const pin = platform === undefined ? undefined : findPin(engine, platform)
  if (folders === undefined || pin?.kind !== 'archive') return undefined
  const folder = buildFolder(folders, pin)
  const binary = installedExecutablePath(folder, pin)
  return existsSync(binary) && existsSync(join(folder, recordFile)) ? binary : undefined
}

// Chrome for Testing, which a shown run of chromium() and one with headlessShell: false start: RETEST_CHROMIUM, else
// the pinned build in Retest's cache.
function chromium(request: ExecutableRequest, host: ExecutableHost): ResolvedExecutable {
  if (request.channel !== undefined) {
    return notFound('setup_failed', `chromium() has no channels. Pass its executablePath, or set ${chromiumVariable}.`, [])
  }
  const fromEnvironment = host.env[chromiumVariable]
  if (fromEnvironment !== undefined && fromEnvironment !== '') return atPath(fromEnvironment, chromiumVariable, host)
  const cached = host.installed?.('chromium')
  if (cached !== undefined) return { ok: true, path: cached, cached: 'chromium' }
  return notFound('setup_failed', `chromium() needs Chrome for Testing to run shown or with headlessShell: false, and it is not installed: run ${retestCommand} install chromium, or set ${chromiumVariable} to a browser.`, [])
}

// The shell is its own program, so a path to any other browser would run that browser under the shell's name. Google
// names the file chrome-headless-shell on every platform, as Playwright's and Puppeteer's caches keep it. With no path,
// the pinned shell in Retest's cache runs, and Chrome for Testing never stands in for a missing shell: which program ran
// must not depend on what a machine happens to hold.
function headlessShell(request: ExecutableRequest, host: ExecutableHost): ResolvedExecutable {
  if (request.channel !== undefined) return notFound('setup_failed', `The headless shell has no channels. Pass its executablePath, or set ${headlessShellVariable}.`, [])
  const fromEnvironment = host.env[headlessShellVariable]
  const given = request.executablePath ?? (fromEnvironment === '' ? undefined : fromEnvironment)
  const source = request.executablePath === undefined ? headlessShellVariable : 'executablePath'
  if (given === undefined) {
    const cached = host.installed?.('headless-shell')
    if (cached !== undefined) return { ok: true, path: cached, cached: 'headless-shell' }
    return notFound('setup_failed', `A headless chromium() target runs Chrome's headless shell, which is not installed: run ${retestCommand} install chromium.`, [])
  }
  if (!isHeadlessShell(given, host.platform)) {
    return notFound('setup_failed', `headlessShell runs Chrome's headless shell, and ${given}, the path ${source} gives, is not one: the shell's file is named ${shellFileName(host.platform)}. Pass the path ${retestCommand} install chromium prints for it, or remove headlessShell to run that browser.`, [given])
  }
  return atPath(given, source, host)
}

/**
 * Whether a path names Chrome's headless shell by the file name Google gives it: chrome-headless-shell, with .exe on
 * Windows, in any case there, where file names ignore it.
 *
 * @example isHeadlessShell('/cache/chrome-headless-shell-linux64/chrome-headless-shell', 'linux') // true
 */
export function isHeadlessShell(path: string, platform: NodeJS.Platform = process.platform): boolean {
  const name = platform === 'win32' ? win32.basename(path).toLowerCase() : posix.basename(path)
  return name === shellFileName(platform)
}

function shellFileName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell'
}

function atPath(path: string, source: string, host: ExecutableHost): ResolvedExecutable {
  if (host.exists(path)) return { ok: true, path }
  return notFound('setup_failed', `No browser at ${path}, the path ${source} gives. Install one there, or change the path.`, [path])
}

// Chrome and Edge install into /Applications, or into the Applications folder of a person without admin rights.
function macPaths(bundle: string, host: ExecutableHost): string[] {
  const inside = posix.join(`${bundle}.app`, 'Contents', 'MacOS', bundle)
  const home = host.env['HOME']
  return [posix.join('/Applications', inside), ...(home === undefined || home === '' ? [] : [posix.join(home, 'Applications', inside)])]
}

/**
 * Where an installed program is looked for on Windows: its path under each root folder this machine names, in the
 * order every user's install comes before one person's.
 *
 * @example windowsPaths('Mozilla Firefox\\firefox.exe', host) // ['C:\\Program Files\\Mozilla Firefox\\firefox.exe', …]
 */
export function windowsPaths(inside: string, host: ExecutableHost): string[] {
  const roots = windowsRoots.flatMap((name) => {
    const root = environmentVariable(host.env, name, 'win32')
    return root === undefined || !win32.isAbsolute(root) ? [] : [root]
  })
  return [...new Set(roots.map((root) => win32.join(root, inside)))]
}

function notFound(failureClass: 'setup_failed' | 'unsupported', message: string, tried: string[]): ResolvedExecutable {
  return { ok: false, failure: { class: failureClass, message }, tried }
}
