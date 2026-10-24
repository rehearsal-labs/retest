import type { ExecutableHost, ExecutableRequest } from '../../src/browser/executables.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { resolveExecutable, systemFirefoxPaths, systemHost, windowsPaths } from '../../src/browser/executables.ts'

function host(platform: NodeJS.Platform, installed: readonly string[] = [], env: Record<string, string> = {}): ExecutableHost {
  return { platform, env: { HOME: '/Users/ada', ...env }, exists: (path) => installed.includes(path) }
}

const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const userMacChrome = '/Users/ada/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

describe('Chrome and Edge', () => {
  test('stable Chrome on macOS is found in /Applications, and a channel defaults to stable', () => {
    assert.deepEqual(resolveExecutable({ product: 'chrome' }, host('darwin', [macChrome])), { ok: true, path: macChrome })
    assert.deepEqual(resolveExecutable({ product: 'chrome', channel: 'stable' }, host('darwin', [macChrome])), { ok: true, path: macChrome })
  })

  test('a browser installed without admin rights is found in the Applications folder at home', () => {
    assert.deepEqual(resolveExecutable({ product: 'chrome' }, host('darwin', [userMacChrome])), { ok: true, path: userMacChrome })
  })

  test('each channel has its own app on macOS', () => {
    const cases: [ExecutableRequest, string][] = [
      [{ product: 'chrome', channel: 'beta' }, '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta'],
      [{ product: 'chrome', channel: 'dev' }, '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev'],
      [{ product: 'chrome', channel: 'canary' }, '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'],
      [{ product: 'edge' }, '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      [{ product: 'edge', channel: 'beta' }, '/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta'],
      [{ product: 'edge', channel: 'dev' }, '/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev'],
      [{ product: 'edge', channel: 'canary' }, '/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary'],
    ]
    for (const [request, path] of cases) assert.deepEqual(resolveExecutable(request, host('darwin', [path])), { ok: true, path })
  })

  test('on Linux the first standard location that exists wins', () => {
    const linux = host('linux', ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'])
    assert.deepEqual(resolveExecutable({ product: 'chrome' }, linux), { ok: true, path: '/usr/bin/google-chrome-stable' })
    const edge = host('linux', ['/opt/microsoft/msedge-beta/msedge'])
    assert.deepEqual(resolveExecutable({ product: 'edge', channel: 'beta' }, edge), { ok: true, path: '/opt/microsoft/msedge-beta/msedge' })
  })

  test('a browser that is not installed fails setup and names every path that was tried', () => {
    const result = resolveExecutable({ product: 'chrome', channel: 'beta' }, host('linux'))
    const tried = ['/opt/google/chrome-beta/chrome', '/usr/bin/google-chrome-beta']
    assert.deepEqual(result, {
      ok: false,
      failure: {
        class: 'setup_failed',
        message: `Google Chrome Beta is not installed. Retest looked in ${tried.join(', ')}. Install it, or choose another target.`,
      },
      tried,
    })
  })

  test('without a home folder only /Applications is tried on macOS', () => {
    for (const env of [{}, { HOME: '' }]) {
      const result = resolveExecutable({ product: 'chrome' }, { platform: 'darwin', env, exists: () => false })
      assert.ok(!result.ok)
      assert.deepEqual(result.tried, [macChrome])
    }
  })

  test('Edge Canary is not made for Linux, and says so', () => {
    assert.deepEqual(resolveExecutable({ product: 'edge', channel: 'canary' }, host('linux', ['/opt/microsoft/msedge/msedge'])), {
      ok: false,
      failure: { class: 'setup_failed', message: 'Microsoft Edge Canary is not made for Linux. Choose another channel.' },
      tried: [],
    })
  })
})

describe('Chromium', () => {
  test('uses RETEST_CHROMIUM when no executable path is given', () => {
    const path = '/opt/chromium/chrome'
    assert.deepEqual(resolveExecutable({ product: 'chromium' }, host('linux', [path], { RETEST_CHROMIUM: path })), { ok: true, path })
  })

  test('an executable path wins over RETEST_CHROMIUM', () => {
    const path = '/opt/other/chrome'
    const found = host('darwin', [path, '/opt/chromium/chrome'], { RETEST_CHROMIUM: '/opt/chromium/chrome' })
    assert.deepEqual(resolveExecutable({ product: 'chromium', executablePath: path }, found), { ok: true, path })
  })

  test('without a path or RETEST_CHROMIUM, or with it empty, it fails and says how to give one', () => {
    const expected = {
      ok: false,
      failure: {
        class: 'setup_failed',
        message: "chromium() needs a browser. Pass its executablePath, or set RETEST_CHROMIUM to the executable's path.",
      },
      tried: [],
    }
    assert.deepEqual(resolveExecutable({ product: 'chromium' }, host('linux')), expected)
    assert.deepEqual(resolveExecutable({ product: 'chromium' }, host('linux', [], { RETEST_CHROMIUM: '' })), expected)
  })

  test('a path that holds no browser fails and names it and where it came from', () => {
    assert.deepEqual(resolveExecutable({ product: 'chromium' }, host('linux', [], { RETEST_CHROMIUM: '/nowhere/chrome' })), {
      ok: false,
      failure: { class: 'setup_failed', message: 'No browser at /nowhere/chrome, the path RETEST_CHROMIUM gives. Install one there, or change the path.' },
      tried: ['/nowhere/chrome'],
    })
    const result = resolveExecutable({ product: 'chrome', executablePath: '/nowhere/chrome' }, host('darwin', [macChrome]))
    assert.ok(!result.ok)
    assert.match(result.failure.message, /the path executablePath gives/)
  })

  test('a channel is refused, since chromium has none', () => {
    const result = resolveExecutable({ product: 'chromium', channel: 'beta' }, host('linux', [], { RETEST_CHROMIUM: '/opt/chromium/chrome' }))
    assert.ok(!result.ok)
    assert.equal(result.failure.message, 'chromium() has no channels. Pass its executablePath, or set RETEST_CHROMIUM.')
  })
})

describe('Windows', () => {
  // The folders a Windows machine names, spelled as Windows spells them; a copy of the environment keeps that spelling.
  const roots = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local' }
  function windows(installed: readonly string[] = [], env: Record<string, string> = roots): ExecutableHost {
    return { platform: 'win32', env, exists: (path) => installed.includes(path) }
  }

  test('stable Chrome is found under Program Files, for every user, before the copy one person installed', () => {
    const machine = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    const own = 'C:\\Users\\ada\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'
    assert.deepEqual(resolveExecutable({ product: 'chrome' }, windows([machine, own])), { ok: true, path: machine })
    assert.deepEqual(resolveExecutable({ product: 'chrome', channel: 'stable' }, windows([own])), { ok: true, path: own })
  })

  test('Edge is found where Windows installs it, under the 32-bit Program Files, and each channel has its own folder', () => {
    const cases: [ExecutableRequest, string][] = [
      [{ product: 'edge' }, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
      [{ product: 'edge', channel: 'beta' }, 'C:\\Program Files (x86)\\Microsoft\\Edge Beta\\Application\\msedge.exe'],
      [{ product: 'edge', channel: 'dev' }, 'C:\\Program Files\\Microsoft\\Edge Dev\\Application\\msedge.exe'],
      [{ product: 'edge', channel: 'canary' }, 'C:\\Users\\ada\\AppData\\Local\\Microsoft\\Edge SxS\\Application\\msedge.exe'],
      [{ product: 'chrome', channel: 'beta' }, 'C:\\Program Files\\Google\\Chrome Beta\\Application\\chrome.exe'],
      [{ product: 'chrome', channel: 'dev' }, 'C:\\Program Files (x86)\\Google\\Chrome Dev\\Application\\chrome.exe'],
      [{ product: 'chrome', channel: 'canary' }, 'C:\\Users\\ada\\AppData\\Local\\Google\\Chrome SxS\\Application\\chrome.exe'],
    ]
    for (const [request, path] of cases) assert.deepEqual(resolveExecutable(request, windows([path])), { ok: true, path })
  })

  test('a browser that is not installed fails setup and names every folder that was looked in', () => {
    const tried = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Users\\ada\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe']
    assert.deepEqual(resolveExecutable({ product: 'chrome' }, windows()), {
      ok: false,
      failure: { class: 'setup_failed', message: `Google Chrome is not installed. Retest looked in ${tried.join(', ')}. Install it, or choose another target.` },
      tried,
    })
  })

  test('reads the folders by any spelling of their names, skips one that is unset or relative, and says when none is set', () => {
    const env = { PROGRAMFILES: 'D:\\Programs', 'programfiles(x86)': 'relative', LocalAppData: '' }
    assert.deepEqual(windowsPaths('Mozilla Firefox\\firefox.exe', windows([], env)), ['D:\\Programs\\Mozilla Firefox\\firefox.exe'])
    for (const given of [{}, env]) assert.deepEqual(resolveExecutable({ product: 'edge' }, windows([], { ...given, PROGRAMFILES: '' })), {
      ok: false,
      failure: { class: 'setup_failed', message: 'Retest has no folder to look for Microsoft Edge in: none of ProgramFiles, ProgramFiles(x86) and LOCALAPPDATA names an absolute folder.' },
      tried: [],
    })
  })

  test('a path the target names, or RETEST_CHROMIUM, wins as on any other system', () => {
    const path = 'C:\\Browsers\\chrome-win64\\chrome.exe'
    assert.deepEqual(resolveExecutable({ product: 'chromium', executablePath: path }, windows([path])), { ok: true, path })
    assert.deepEqual(resolveExecutable({ product: 'chromium' }, windows([path], { ...roots, RETEST_CHROMIUM: path })), { ok: true, path })
  })

  test('Firefox is looked for where macOS and Windows install it, and nowhere on Linux', () => {
    assert.deepEqual(systemFirefoxPaths(windows()), ['C:\\Program Files\\Mozilla Firefox\\firefox.exe', 'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe', 'C:\\Users\\ada\\AppData\\Local\\Mozilla Firefox\\firefox.exe'])
    assert.deepEqual(systemFirefoxPaths(host('darwin')), ['/Applications/Firefox.app/Contents/MacOS/firefox'])
    assert.deepEqual(systemFirefoxPaths(host('linux')), [])
  })
})

describe('platforms', () => {
  test('a platform Retest runs no browser on is named as it is, before anything is looked for', () => {
    let looked = false
    const result = resolveExecutable({ product: 'chrome' }, { platform: 'freebsd', env: {}, exists: () => (looked = true) })
    assert.ok(!result.ok)
    assert.deepEqual(result.failure, { class: 'unsupported', message: 'Retest runs browsers on macOS, Linux and Windows, not on freebsd.' })
    assert.equal(looked, false)
  })

  test('the system host reads this machine', () => {
    const system = systemHost()
    assert.equal(system.platform, process.platform)
    assert.equal(system.env, process.env)
    assert.equal(system.exists(import.meta.filename), true)
  })
})
