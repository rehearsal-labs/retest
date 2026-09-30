import type { Failure } from '../protocol/failures.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

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

type Install = { name: string; mac: string; linux: readonly string[] }

const chromiumVariable = 'RETEST_CHROMIUM'

const installs: Readonly<Record<'chrome' | 'edge', Readonly<Record<BrowserChannel, Install>>>> = {
  chrome: {
    stable: { name: 'Google Chrome', mac: 'Google Chrome', linux: ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'] },
    beta: { name: 'Google Chrome Beta', mac: 'Google Chrome Beta', linux: ['/opt/google/chrome-beta/chrome', '/usr/bin/google-chrome-beta'] },
    dev: { name: 'Google Chrome Dev', mac: 'Google Chrome Dev', linux: ['/opt/google/chrome-unstable/chrome', '/usr/bin/google-chrome-unstable'] },
    canary: { name: 'Google Chrome Canary', mac: 'Google Chrome Canary', linux: ['/opt/google/chrome-canary/chrome', '/usr/bin/google-chrome-canary'] },
  },
  edge: {
    stable: { name: 'Microsoft Edge', mac: 'Microsoft Edge', linux: ['/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge-stable', '/usr/bin/microsoft-edge'] },
    beta: { name: 'Microsoft Edge Beta', mac: 'Microsoft Edge Beta', linux: ['/opt/microsoft/msedge-beta/msedge', '/usr/bin/microsoft-edge-beta'] },
    dev: { name: 'Microsoft Edge Dev', mac: 'Microsoft Edge Dev', linux: ['/opt/microsoft/msedge-dev/msedge', '/usr/bin/microsoft-edge-dev'] },
    // Microsoft publishes no Canary build of Edge for Linux.
    canary: { name: 'Microsoft Edge Canary', mac: 'Microsoft Edge Canary', linux: [] },
  },
}

/**
 * Finds the browser a target launches: the path it names, `RETEST_CHROMIUM` for `chromium`, or the standard
 * install locations of Chrome and Edge on macOS and Linux. Reads the machine only through `host`.
 *
 * @example resolveExecutable({ product: 'chrome', channel: 'beta' }, systemHost())
 */
export function resolveExecutable(request: ExecutableRequest, host: ExecutableHost): ResolvedExecutable {
  if (host.platform !== 'darwin' && host.platform !== 'linux') {
    return notFound('unsupported', `Retest runs browsers on macOS and Linux, not on ${platformName(host.platform)}.`, [])
  }
  if (request.executablePath !== undefined) return atPath(request.executablePath, 'executablePath', host)
  if (request.product === 'chromium') return chromium(request, host)
  const install = installs[request.product][request.channel ?? 'stable']
  const tried = host.platform === 'darwin' ? macPaths(install.mac, host) : [...install.linux]
  if (tried.length === 0) return notFound('setup_failed', `${install.name} is not made for Linux. Choose another channel.`, [])
  const found = tried.find((path) => host.exists(path))
  if (found !== undefined) return { ok: true, path: found }
  return notFound('setup_failed', `${install.name} is not installed. Retest looked in ${tried.join(', ')}. Install it, or choose another target.`, tried)
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
  const inside = join(`${bundle}.app`, 'Contents', 'MacOS', bundle)
  const home = host.env['HOME']
  return [join('/Applications', inside), ...(home === undefined || home === '' ? [] : [join(home, 'Applications', inside)])]
}

function notFound(failureClass: 'setup_failed' | 'unsupported', message: string, tried: string[]): ResolvedExecutable {
  return { ok: false, failure: { class: failureClass, message }, tried }
}

function platformName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'Windows' : platform
}
