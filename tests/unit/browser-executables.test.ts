import type { ExecutableHost, ExecutableRequest } from '../../src/browser/executables.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { resolveExecutable, systemHost } from '../../src/browser/executables.ts'

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

describe('platforms', () => {
  test('Windows is not supported, and says so before looking anywhere', () => {
    let looked = false
    const windows: ExecutableHost = { platform: 'win32', env: {}, exists: () => (looked = true) }
    for (const request of [{ product: 'chrome' }, { product: 'chromium', executablePath: 'C:\\chrome.exe' }] as const) {
      assert.deepEqual(resolveExecutable(request, windows), {
        ok: false,
        failure: { class: 'unsupported', message: 'Retest runs browsers on macOS and Linux, not on Windows.' },
        tried: [],
      })
    }
    assert.equal(looked, false)
  })

  test('another platform is named as it is', () => {
    const result = resolveExecutable({ product: 'chrome' }, host('freebsd'))
    assert.ok(!result.ok)
    assert.equal(result.failure.message, 'Retest runs browsers on macOS and Linux, not on freebsd.')
  })

  test('the system host reads this machine', () => {
    const system = systemHost()
    assert.equal(system.platform, process.platform)
    assert.equal(system.env, process.env)
    assert.equal(system.exists(import.meta.filename), true)
  })
})
