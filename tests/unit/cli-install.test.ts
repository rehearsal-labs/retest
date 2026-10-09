import type { Server } from 'node:http'
import type { TestContext } from 'node:test'
import type { BuildInspection, PinnedLicences, BuildSourceCode } from '../../src/browser/builds.ts'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { buildFolder, buildPlatform, cacheFolders, findPin } from '../../src/browser/builds.ts'
import { describeResult } from '../../src/cli/install/report.ts'
import { createStyle } from '../../src/reporters/style.ts'
import { tempFolder } from '../support/temp-folder.ts'
import { unpinnedBuilds } from '../support/unpinned-host.ts'
import { listeningPort } from './builds-fixtures.ts'
import { fakeCli } from './cli-fixtures.ts'

// `retest install` through the command line with a home folder of its own. Real downloads never happen here: the
// global fetch fails the test unless a case points the mirror at the stand-in server on this machine.
const cwd = tempFolder('retest-install-cwd-')
let fetches = 0
let allowFetch = false
const realFetch = globalThis.fetch
beforeEach(() => {
  fetches = 0
  allowFetch = false
  globalThis.fetch = async (input, init) => {
    fetches += 1
    if (!allowFetch) throw new Error('this case must not touch the network')
    return realFetch(input, init)
  }
})
afterEach(() => {
  globalThis.fetch = realFetch
})

const requests: string[] = []
let server: Server
let mirror = ''
before(async () => {
  server = createServer((request, response) => {
    requests.push(request.url ?? '')
    response.setHeader('content-length', '11')
    response.end('not a build')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  mirror = `http://127.0.0.1:${listeningPort(server)}`
})
after(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function install(args: string[], env: Record<string, string> = { HOME: tempFolder('retest-install-home-') }, signal?: AbortSignal) {
  const fake = fakeCli({ cwd, env, ...(signal === undefined ? {} : { signal }) })
  const code = await fake.cli(['install', ...args])
  return { code, stdout: fake.stdout.text, stderr: fake.stderr.text }
}

// The pins differ by machine; the cases that read the macOS arm64 pins are skipped by name elsewhere.
function onMac(t: TestContext): boolean {
  if (buildPlatform() === 'mac-arm64') return true
  t.skip(`unverified here: these cases read the macOS arm64 pins, and this machine is ${process.platform} ${process.arch}`)
  return false
}

describe('retest install', () => {
  test('documents its engines, the cache, and the mirror variable', async () => {
    const fake = fakeCli({ cwd })
    assert.equal(await fake.cli(['help', 'install']), 0)
    const help = fake.stdout.text
    assert.match(help, /^Usage\n {2}retest install <engine\.\.\.> \| --list \[options\]\n/)
    assert.match(help, /Engines: chromium, firefox, webkit, electron, webdriveragent, mac2, media\./)
    assert.match(help, /RETEST_DOWNLOAD_MIRROR names a mirror/)
    assert.match(help, /run, doctor and --list never download/)
    const general = fakeCli({ cwd })
    await general.cli(['--help'])
    assert.match(general.stdout.text, /\n {2}install <engine\.\.\.> +Install pinned browser builds, or list what this machine holds\n/)
  })

  test('asks for engines, names the ones it knows, and keeps --verify and --json to --list', async () => {
    const none = await install([])
    assert.equal(none.code, 2)
    assert.match(none.stderr, /^error: Name the engines to install: chromium, firefox, webkit, electron, webdriveragent, mac2 or media\. Or list them with --list\.\nSee retest help install\.\n$/)
    const typo = await install(['firefx'])
    assert.equal(typo.code, 2)
    assert.match(typo.stderr, /Unknown engine firefx\. Did you mean firefox\?/)
    const unknown = await install(['safari'])
    assert.match(unknown.stderr, /Unknown engine safari\. The engines are chromium, firefox, webkit, electron, webdriveragent, mac2 and media\./)
    assert.match((await install(['electron', '--json'])).stderr, /--verify and --json go with --list\./)
    assert.match((await install(['--list', 'electron'])).stderr, /--list takes no engines, received electron\./)
    assert.equal(fetches, 0)
  })

  // A machine with no pins is refused for that before its cache folder is looked for.
  test('refuses a HOME that is not an absolute folder, which leaves no cache folder', { skip: unpinnedBuilds }, async () => {
    const homeless = await install(['--list'], {})
    assert.equal(homeless.code, 2)
    assert.match(homeless.stderr, /HOME is not set to an absolute folder, so Retest has no cache folder to install into or read\./)
    assert.equal(fetches, 0)
  })

  test('lists every pin for this machine and what the cache holds, downloading nothing', async (t) => {
    if (!onMac(t)) return
    const home = tempFolder('retest-install-home-')
    const listed = await install(['--list'], { HOME: home, NO_COLOR: '1' })
    assert.equal(listed.code, 0, listed.stderr)
    const lines = listed.stdout.split('\n').map((line) => line.trim().replaceAll(/ {2,}/g, ' | '))
    assert.ok(lines.includes(`Pinned builds for macOS arm64, in ${join(home, 'Library/Caches/retest')}`), listed.stdout)
    assert.ok(lines.includes('electron | Electron 44.5.1 | - not installed · npx retest install electron'), listed.stdout)
    assert.ok(lines.includes('chromium | Chrome for Testing 153.0.8010.12 | - not installed · npx retest install chromium'), listed.stdout)
    assert.ok(lines.includes('webkit | WebKit (Playwright build) 26.6 (build 2359) | - not installed · npx retest install webkit'), listed.stdout)
    assert.ok(lines.includes('LGPL 2.1 and BSD, notices kept with the build'), listed.stdout)
    assert.doesNotMatch(listed.stdout, /Licence licenses\/|SHA-256|Source https:|Patches https:/)
    for (const line of [
      'firefox | Firefox 133.0.3 (build 20241209150345) | - not installed · npx retest install firefox',
      'webdriveragent | WebDriverAgent 16.13.6 | - not installed · npx retest install webdriveragent',
      'mac2 | WebDriverAgentMac (appium-mac2-driver) 4.3.6 | - not installed · npx retest install mac2',
    ]) assert.ok(lines.includes(line), `${line}:\n${listed.stdout}`)
    assert.ok(lines.includes('Nothing was downloaded.'))
    assert.equal(fetches, 0)
    assert.equal(existsSync(join(home, 'Library')), false, 'listing makes no folder')
  })

  test('lists as JSON, with each pin, its state and how it is installed or why not', async (t) => {
    if (!onMac(t)) return
    const listed = await install(['--list', '--json'])
    assert.equal(listed.code, 0)
    const document = JSON.parse(listed.stdout) as { schemaVersion: number; platform: string; builds: { engine: string; state: string; pinnedSha256: string | null; licences?: PinnedLicences; sourceCode?: BuildSourceCode; install: { command?: string; refused?: string; missingNotices?: string[] } }[] }
    assert.equal(document.schemaVersion, 1)
    assert.equal(document.platform, 'mac-arm64')
    assert.deepEqual(document.builds.map((build) => [build.engine, build.state]), [['chromium', 'missing'], ['firefox', 'missing'], ['webkit', 'missing'], ['electron', 'missing'], ['webdriveragent', 'missing'], ['mac2', 'missing'], ['media', 'missing']])
    const byEngine = new Map(document.builds.map((build) => [build.engine, build]))
    assert.deepEqual(byEngine.get('electron')?.install, { command: 'npx retest install electron' })
    assert.equal(byEngine.get('electron')?.pinnedSha256, '1d75703019bb16461ae65f3081d7e6f5c0b11e901d0ccb5c343bcf7bcdd6435c')
    assert.equal(byEngine.get('webkit')?.install.missingNotices, undefined)
    const webkit = findPin('webkit', 'mac-arm64')
    assert.ok(webkit?.kind === 'archive' && webkit.licences.inspected)
    assert.deepEqual(byEngine.get('webkit')?.licences, webkit.licences)
    assert.deepEqual(byEngine.get('webkit')?.sourceCode, webkit.sourceCode)
    const notices = byEngine.get('webkit')?.licences
    assert.ok(notices?.inspected)
    assert.equal(notices.files.filter(file => file.bundled !== undefined).length, 9)
    assert.equal(byEngine.get('webkit')?.sourceCode?.revision, '4d05d732e5a84f32675bef4cc135a2e7a9269a87')
    for (const engine of ['webkit', 'chromium', 'firefox']) {
      assert.deepEqual(byEngine.get(engine)?.install, { command: `npx retest install ${engine}` })
      assert.match(byEngine.get(engine)?.pinnedSha256 ?? '', /^[a-f0-9]{64}$/)
    }
    assert.equal(fetches, 0)
  })

  test('marks a build folder that holds no record as not matching, and exits 2', async (t) => {
    if (!onMac(t)) return
    const home = tempFolder('retest-install-home-')
    const folders = cacheFolders({ HOME: home })
    const pin = findPin('electron', 'mac-arm64')
    assert.ok(folders !== undefined && pin !== undefined)
    await mkdir(buildFolder(folders, pin), { recursive: true })
    const listed = await install(['--list'], { HOME: home, NO_COLOR: '1' })
    assert.equal(listed.code, 2)
    assert.match(listed.stdout, /electron +Electron 44\.5\.1 +✗ not as recorded in .+electron-44\.5\.1-mac-arm64\n +.+ holds no build\.json, so nothing records what is in it\.\n +Remove the folder and run npx retest install electron again\./)
    assert.match(listed.stdout, /One build does not match its record\./)
    const refused = await install(['electron'], { HOME: home, NO_COLOR: '1' })
    assert.equal(refused.code, 2)
    assert.match(refused.stdout, /✗ electron +Electron 44\.5\.1 is in .+, but not as recorded: .+ Remove .+ and run the install again\./)
    assert.equal(fetches, 0)
  })

  test('moves all nine retained WebKit notice texts and pointers to licences, fetching nothing', async (t) => {
    if (!onMac(t)) return
    const home = tempFolder('retest-install-home-')
    const fake = fakeCli({ cwd, env: { HOME: home, NO_COLOR: '1' } })
    assert.equal(await fake.cli(['licences', 'webkit']), 2, 'archive-only notices are unavailable before installation')
    const text = fake.stdout.text
    const lines = text.split('\n')
    for (const name of ['WebKit-LGPL-2.1.txt', 'WebKit-BSD-2-Clause.txt', 'ANGLE-LICENSE.txt', 'WebRTC-LICENSE.txt', 'BoringSSL-LICENSE.txt', 'abseil-cpp-LICENSE.txt', 'libvpx-LICENSE.txt', 'swiftCompatibilitySpan-LICENSE.txt', 'SOURCE.txt']) {
      assert.ok(lines.some((line) => line.startsWith(`--- licenses/${name} (`)), `${name} is named:\n${text}`)
    }
    assert.match(text, /Source https:\/\/github.com\/WebKit\/WebKit\/tree\/4d05d732e5a84f32675bef4cc135a2e7a9269a87\nPatches https:\/\/github.com\/microsoft\/playwright\/tree\/v1\.63\.0\/browser_patches\/webkit\n$/)
    assert.equal((text.match(/notice text is available only with the installed build\./g) ?? []).length, 4)
    assert.equal(fetches, 0)
    assert.equal(existsSync(join(home, 'Library')), false, 'nothing was written')
  })

  test('downloads Electron from a mirror only when asked, and stops at a size that is not the pinned one', async (t) => {
    if (!onMac(t)) return
    allowFetch = true
    const home = tempFolder('retest-install-home-')
    const before = requests.length
    const result = await install(['electron'], { HOME: home, NO_COLOR: '1', RETEST_DOWNLOAD_MIRROR: mirror })
    assert.equal(result.code, 2)
    assert.deepEqual(requests.slice(before), ['/github.com/electron/electron/releases/download/v44.5.1/electron-v44.5.1-darwin-arm64.zip'])
    assert.ok(result.stdout.includes(`  Downloading Electron 44.5.1 for macOS arm64 from ${mirror}/github.com/electron/electron/releases/download/v44.5.1/electron-v44.5.1-darwin-arm64.zip (124.2 MiB)\n`), result.stdout)
    assert.ok(result.stdout.includes(`✗ electron         127.0.0.1:${new URL(mirror).port} offers 11 bytes, and the pinned archive is 130259261 bytes. Nothing was installed.`), result.stdout)
    const browsers = join(home, 'Library/Caches/retest/browsers')
    assert.deepEqual(readdirSync(join(browsers, 'downloads')), [], 'no partial archive is left')
    assert.deepEqual(readdirSync(browsers).sort(), ['downloads'])
  })

  test('rejects a hand-written cache record that disagrees with the archive pin, and exits 2', async (t) => {
    if (!onMac(t)) return
    const home = tempFolder('retest-install-home-')
    const folders = cacheFolders({ HOME: home })
    const pin = findPin('chromium', 'mac-arm64')
    assert.ok(folders !== undefined && pin?.kind === 'archive')
    const folder = buildFolder(folders, pin)
    // A hand-written record that claims everything, as the review's hand-filled cache did.
    await mkdir(join(folder, 'build'), { recursive: true })
    await writeFile(join(folder, 'build.json'), JSON.stringify({ schemaVersion: 1, engine: 'chromium', version: pin.version, platform: 'mac-arm64', source: pin.archive.url, fetchedFrom: 'hand', archive: { size: 1, sha256: 'not-an-archive' }, executable: { path: pin.executable.path, sha256: pin.executable.sha256 }, files: [], licences: [], tree: { sha256: 'x' }, installedAt: '2026-10-05T00:00:00.000Z', installedBy: 'hand' }))
    for (const args of [['--list'], ['--list', '--verify']]) {
      const listed = await install(args, { HOME: home, NO_COLOR: '1' })
      assert.equal(listed.code, 2, args.join(' '))
      const lines = listed.stdout.split('\n').map((line) => line.trim().replaceAll(/ {2,}/g, ' | '))
      assert.ok(lines.includes(`chromium | Chrome for Testing 153.0.8010.12 | ✗ not as recorded in ${folder}`), listed.stdout)
      assert.ok(lines.includes('Remove the folder and run npx retest install chromium again.'), listed.stdout)
      assert.ok(lines.includes(`It was installed from an archive with SHA-256 not-an-archive, not the pinned ${pin.archive.sha256}.`), listed.stdout)
      assert.ok(lines.includes('One build does not match its record.'), listed.stdout)
      assert.ok(!/chromium .*✓/.test(listed.stdout), 'it is never listed as installed')
    }
    const document = JSON.parse((await install(['--list', '--json'], { HOME: home })).stdout) as { builds: { engine: string; state: string; executablePath?: string }[] }
    const chromium = document.builds.find((build) => build.engine === 'chromium')
    assert.deepEqual([chromium?.state, chromium?.executablePath], ['damaged', undefined])
    assert.equal(fetches, 0)
  })

  test('refuses a mirror with a query or a fragment by name, before anything is fetched, and never prints it back', { skip: unpinnedBuilds }, async () => {
    for (const [given, named] of [['https://mirror.example.com/?token=mirror-secret', 'a query'], ['https://mirror.example.com/builds#mirror-secret', 'a fragment'], ['https://mirror.example.com/?', 'a query']] as const) {
      const result = await install(['electron'], { HOME: tempFolder('retest-install-home-'), RETEST_DOWNLOAD_MIRROR: given })
      assert.equal(result.code, 2, given)
      assert.match(result.stderr, new RegExp(`^error: RETEST_DOWNLOAD_MIRROR carries ${named}, which Retest neither sends to a mirror nor records\\. Give the mirror's address without it\\.`), given)
      assert.ok(!result.stderr.includes('mirror-secret') && !result.stdout.includes('mirror-secret'), 'the mirror is not printed back')
    }
    assert.equal(fetches, 0)
  })

  test('refuses a mirror that is not https or this machine, before anything is fetched', { skip: unpinnedBuilds }, async () => {
    for (const given of ['http://mirror.example.com', 'ftp://127.0.0.1', 'https://user:password@mirror.example.com', 'not an address']) {
      const result = await install(['electron'], { HOME: tempFolder('retest-install-home-'), RETEST_DOWNLOAD_MIRROR: given })
      assert.equal(result.code, 2, given)
      assert.match(result.stderr, /^error: RETEST_DOWNLOAD_MIRROR/, given)
      assert.ok(!result.stderr.includes('password'), 'the mirror is not printed back with its credentials')
    }
    assert.equal(fetches, 0)
  })

  // Each line names the way that engine's driver finds a binary: only Firefox's runs the installed build unasked.
  test('says how a target runs a build it installed, as that engine\'s driver looks for one', () => {
    const style = createStyle(false)
    const installed = (engine: 'firefox' | 'electron' | 'chromium'): string => {
      const pin = findPin(engine, 'mac-arm64')
      assert.ok(pin?.kind === 'archive')
      const inspection: BuildInspection = { pin, folder: `/cache/${engine}`, state: 'installed', problems: [], executablePath: `/cache/${engine}/build/${pin.executable.path}`, sha256: 'a'.repeat(64) }
      return describeResult(engine, { ok: true, action: 'installed', inspection }, style).trimEnd().split('\n').at(-1)?.trim() ?? ''
    }
    assert.equal(installed('firefox'), 'A Firefox target that names no executablePath runs it.')
    assert.equal(installed('electron'), 'An electron() target runs it once its executablePath names this path.')
    assert.equal(installed('chromium'), 'A chromium() target runs it once its executablePath, or RETEST_CHROMIUM, names this path.')
  })

  test('exits as interrupted when stopped before it starts', { skip: unpinnedBuilds }, async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await install(['electron'], { HOME: tempFolder('retest-install-home-') }, controller.signal)
    assert.equal(result.code, 130)
    assert.equal(fetches, 0)
  })
})
