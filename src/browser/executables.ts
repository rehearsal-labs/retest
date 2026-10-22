import type { Failure } from '../protocol/failures.ts'
import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { listWords } from '../shared/list-words.ts'
import { environmentVariable } from './builds.ts'

export type BrowserProduct = 'chromium' | 'chrome' | 'edge'

export type BrowserChannel = 'stable' | 'beta' | 'dev' | 'canary'

/** Which browser a target wants. `executablePath` names the binary itself; `channel` applies to Chrome and Edge. */
export type ExecutableRequest = { product: BrowserProduct; channel?: BrowserChannel; executablePath?: string }

/** What resolution reads of the machine it runs on. */
export type ExecutableHost = {
  platform: NodeJS.Platform
  env: Readonly<Record<string, string | undefined>>
  exists(path: string): boolean
}

/** The executable to launch, or why there is none and every path that was looked at. */
export type ResolvedExecutable = { ok: true; path: string } | { ok: false; failure: Failure; tried: string[] }

/** Where one channel installs: its app's name on macOS, its paths on Linux, and its path under each Windows root. */
type Install = { name: string; mac: string; linux: readonly string[]; windows: string }

const chromiumVariable = 'RETEST_CHROMIUM'

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
 * Finds the browser a target launches: the path it names, `RETEST_CHROMIUM` for `chromium`, or the standard
 * install locations of Chrome and Edge on macOS, Linux and Windows. Reads the machine only through `host`.
 *
 * @example resolveExecutable({ product: 'chrome', channel: 'beta' }, systemHost())
 */
export function resolveExecutable(request: ExecutableRequest, host: ExecutableHost): ResolvedExecutable {
  if (host.platform !== 'darwin' && host.platform !== 'linux' && host.platform !== 'win32') {
    return notFound('unsupported', `Retest runs browsers on macOS, Linux and Windows, not on ${host.platform}.`, [])
  }
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
  return { platform: process.platform, env: process.env, exists: existsSync }
}

function chromium(request: ExecutableRequest, host: ExecutableHost): ResolvedExecutable {
  if (request.channel !== undefined) {
    return notFound('setup_failed', `chromium() has no channels. Pass its executablePath, or set ${chromiumVariable}.`, [])
  }
  const fromEnvironment = host.env[chromiumVariable]
  if (fromEnvironment === undefined || fromEnvironment === '') {
    return notFound('setup_failed', `chromium() needs a browser. Pass its executablePath, or set ${chromiumVariable} to the executable's path.`, [])
  }
  return atPath(fromEnvironment, chromiumVariable, host)
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
