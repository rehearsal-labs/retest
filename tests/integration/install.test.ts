import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { ArchivePin, CacheFolders } from '../../src/browser/builds.ts'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { buildFolder, buildPlatform, cacheFolders, describePin, findPin, inspectBuild, installedExecutablePath, readInstalledRecord } from '../../src/browser/builds.ts'
import { isRecord } from '../../src/browser/cdp/message.ts'
import { archivePath, installArchive, installLockPath } from '../../src/cli/install/install-archive.ts'
import { takeInstallLock } from '../../src/cli/install/lock.ts'
import { systemUnpackTools, unpackArchive } from '../../src/cli/install/unpack.ts'
import { sha256Hex } from '../../src/shared/sha256.ts'
import { isArray } from '../../src/protocol/schema.ts'
import { tempFolder } from '../support/temp-folder.ts'
import { repositoryRoot, runCli, writeFiles, writeProject } from './cli-harness.ts'

// `retest install` against a stand-in archive server this test runs on 127.0.0.1: the real pinned browsers, the
// Electron 44.5.1 archive from its proof cache, and small stand-in builds made here. Publisher archives are local
// fixtures; nothing is fetched from a publisher. The checks unpack with the system's own ditto and hdiutil, so they run on macOS arm64 and are
// skipped by name elsewhere.

const electronArchive = process.env['RETEST_TEST_ELECTRON_ARCHIVE'] ?? join(homedir(), 'Library/Caches/retest-proofs/electron/44.5.1/electron-v44.5.1-darwin-arm64.zip')
const electronRoute = '/github.com/electron/electron/releases/download/v44.5.1/electron-v44.5.1-darwin-arm64.zip'
const unverified = buildPlatform() === 'mac-arm64' ? false : `unverified: the install checks unpack with macOS's ditto and hdiutil, and this machine is ${process.platform} ${process.arch}`

type Route = (request: IncomingMessage, response: ServerResponse) => void
const routes = new Map<string, Route>()
const requests: string[] = []
// Mount points and stand-in images belong to this worker, so earlier files' folders cannot satisfy or fail cleanup.
const inheritedTmpdir = process.env['TMPDIR']
const ownedTemporaryRoot = tempFolder('retest-install-tmp-')
process.env['TMPDIR'] = ownedTemporaryRoot
after(() => {
  if (inheritedTmpdir === undefined) delete process.env['TMPDIR']
  else process.env['TMPDIR'] = inheritedTmpdir
})
let server: Server
let mirror = ''

before(async () => {
  server = createServer((request, response) => {
    requests.push(request.url ?? '')
    const route = routes.get(request.url ?? '')
    if (route === undefined) {
      response.statusCode = 404
      response.end()
      return
    }
    route(request, response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  mirror = `http://127.0.0.1:${listeningPort(server)}`
})
after(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function serveFile(route: string, path: string): void {
  routes.set(route, (_request, response) => {
    response.setHeader('content-length', String(statSync(path).size))
    createReadStream(path).pipe(response)
  })
}

function requestsSince(start: number): string[] {
  return requests.slice(start)
}

function lines(text: string): string[] {
  return text.split('\n').map((line) => line.trim().replaceAll(/ {2,}/g, ' | '))
}

describe('installing the pinned Electron from a stand-in mirror', { skip: unverified }, () => {
  const pin = findPin('electron', 'mac-arm64')
  assert.ok(pin?.kind === 'archive')
  const home = tempFolder('retest-install-home-')
  const folders = cacheFolders({ HOME: home }) ?? assert.fail('a cache under the test home')
  const env = { HOME: home, NO_COLOR: '1', RETEST_DOWNLOAD_MIRROR: '' }
  const executable = installedExecutablePath(buildFolder(folders, pin), pin)

  before(() => {
    assert.ok(existsSync(electronArchive), `The Electron 44.5.1 archive is not at ${electronArchive}. Set RETEST_TEST_ELECTRON_ARCHIVE to it.`)
    serveFile(electronRoute, electronArchive)
    env.RETEST_DOWNLOAD_MIRROR = mirror
  })

  test('downloads it once asked, checks its size and SHA-256, unpacks it, checks its notices and records it', async (t) => {
    const start = requests.length
    const installed = await runCli(t, ['install', 'electron'], { env })
    assert.equal(installed.exit.code, 0, `${installed.stdout}\n${installed.stderr}`)
    assert.deepEqual(requestsSince(start), [electronRoute])
    const printed = lines(installed.stdout)
    assert.ok(printed.includes(`Downloading Electron 44.5.1 for macOS arm64 from ${mirror}${electronRoute} (124.2 MiB)`), installed.stdout)
    assert.ok(printed.includes('Verified: 130259261 bytes, SHA-256 1d75703019bb16461ae65f3081d7e6f5c0b11e901d0ccb5c343bcf7bcdd6435c'), installed.stdout)
    assert.ok(printed.includes('✓ electron | Electron 44.5.1 installed'), installed.stdout)
    assert.ok(printed.includes(executable), installed.stdout)
    assert.ok(printed.includes('archive SHA-256 1d75703019bb16461ae65f3081d7e6f5c0b11e901d0ccb5c343bcf7bcdd6435c'), installed.stdout)
    const reading = await readInstalledRecord(buildFolder(folders, pin))
    assert.ok(reading.kind === 'found', 'the record is one retest install wrote')
    const { record } = reading
    assert.deepEqual(record.archive, { size: 130_259_261, sha256: pin.archive.sha256 })
    assert.equal(record.fetchedFrom, `${mirror}${electronRoute}`)
    assert.equal(record.source, pin.archive.url)
    assert.equal(record.tree.sha256, pin.treeSha256, 'the unpacked build reads as the one the Electron proof unpacked')
    assert.deepEqual(record.executable, { path: 'Electron.app/Contents/MacOS/Electron', sha256: 'ca7e3290800255f5018160cff99cf6ecc58eae299c66148de1374a70e2715c83' })
    assert.deepEqual(record.licences.map((licence) => [licence.path, licence.sha256]), [['LICENSE', '5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d'], ['LICENSES.chromium.html', 'a62dabd1c6ef1327365b2a3fdffb806222684a746dcb8f4afd1c1f690eba5535']])
    assert.deepEqual(readdirSync(join(folders.browsers, 'downloads')), [], 'the archive is deleted once the build is recorded')
    assert.deepEqual(readdirSync(folders.browsers).sort(), ['downloads', 'electron-44.5.1-mac-arm64'], 'no staging folder is left')
    assert.deepEqual(lockState(installLockPath(folders, pin)), { generation: 1, released: true }, 'the install took the lock in the cache\'s locks folder and let it go')
    const lock = await takeInstallLock(installLockPath(folders, pin))
    assert.ok(lock.ok, 'the install lock was let go')
    await lock.release()
    assert.equal(statSync(executable).mode & 0o111, 0o111, 'the binary keeps its execute bits')
  })

  test('lists it as installed, verifies every file against its record, and leaves it alone when asked again', async (t) => {
    const listed = await runCli(t, ['install', '--list', '--json'], { env })
    assert.equal(listed.exit.code, 0, listed.stderr)
    const document = JSON.parse(listed.stdout) as { builds: { engine: string; state: string; sha256?: string; executablePath?: string }[] }
    const electron = document.builds.find((build) => build.engine === 'electron')
    assert.deepEqual([electron?.state, electron?.sha256, electron?.executablePath], ['installed', pin.archive.sha256, executable])
    const verified = await runCli(t, ['install', '--list', '--verify'], { env })
    assert.equal(verified.exit.code, 0, verified.stdout)
    assert.ok(lines(verified.stdout).some((line) => line.startsWith('electron | Electron 44.5.1 | ✓ installed · archive SHA-256 1d75703019bb')), verified.stdout)
    const start = requests.length
    const again = await runCli(t, ['install', 'electron'], { env })
    assert.equal(again.exit.code, 0)
    assert.ok(lines(again.stdout).includes('✓ electron | Electron 44.5.1 was already installed'), again.stdout)
    assert.deepEqual(requestsSince(start), [], 'nothing is fetched for a build installed as recorded')
  })

  test('shows doctor the installed build an electron() target runs, and nothing is fetched', async (t) => {
    const root = await writeProject(t, {})
    await writeFiles(root, {
      'retest.config.ts': `import { defineConfig, electron } from '@rehearsal-labs/retest'\n\nexport default defineConfig({ apps: { desk: electron({ executablePath: ${JSON.stringify(executable)}, appPath: ${JSON.stringify(join(repositoryRoot, 'fixtures/electron'))} }) } })\n`,
    })
    const start = requests.length
    const doctor = await runCli(t, ['doctor'], { cwd: root, env })
    assert.equal(doctor.exit.code, 0, `${doctor.stdout}\n${doctor.stderr}`)
    const printed = lines(doctor.stdout)
    assert.ok(printed.includes(`desk | electron({ ... }) | ✓ Electron 44.5.1 and the app found; a run starts the app | ${executable}`), doctor.stdout)
    assert.ok(printed.includes(`builds | electron | ✓ Electron 44.5.1, installed by Retest · sha256 1d75703019bb; licence notices present and verified | ${executable}`), doctor.stdout)
    assert.deepEqual(requestsSince(start), [])
  })

  test('finds a notice removed after the install, in the list, in doctor and in the install, and fetches nothing', async (t) => {
    const folder = buildFolder(folders, pin)
    await rm(join(folder, 'build', 'LICENSES.chromium.html'))
    const start = requests.length
    const listed = await runCli(t, ['install', '--list'], { env })
    assert.equal(listed.exit.code, 2)
    assert.match(listed.stdout, new RegExp(`electron +Electron 44\\.5\\.1 +✗ not as recorded in ${folder.replaceAll('.', '\\.')}\\n +${join(folder, 'build', 'LICENSES').replaceAll('.', '\\.')}\\.chromium\\.html is missing\\.`))
    const root = await writeProject(t, {})
    await writeFiles(root, { 'retest.config.ts': `import { defineConfig, electron } from '@rehearsal-labs/retest'\n\nexport default defineConfig({ apps: { desk: electron({ executablePath: ${JSON.stringify(executable)}, appPath: ${JSON.stringify(join(repositoryRoot, 'fixtures/electron'))} }) } })\n` })
    const doctor = await runCli(t, ['doctor'], { cwd: root, env })
    assert.equal(doctor.exit.code, 2)
    assert.match(doctor.stdout, /builds +electron +✗ Electron 44\.5\.1 in .+ does not match its record: .+LICENSES\.chromium\.html is missing\.\n +Remove .+electron-44\.5\.1-mac-arm64 and run npx retest install electron again\./)
    const install = await runCli(t, ['install', 'electron'], { env })
    assert.equal(install.exit.code, 2)
    assert.match(install.stdout, /✗ electron +Electron 44\.5\.1 is in .+, but not as recorded: .+LICENSES\.chromium\.html is missing\. Remove .+ and run the install again\./)
    assert.deepEqual(requestsSince(start), [])
  })
})

// Real publisher archives are explicit local fixtures. This suite never fetches a publisher and never supplies
// substitute bytes. Use the existing proof cache, or name another local fixture folder with RETEST_TEST_BROWSER_ARCHIVES.
const browserArchives = process.env['RETEST_TEST_BROWSER_ARCHIVES'] ?? join(homedir(), 'Library/Caches/retest-proofs/downloads')
const browserProofLogs = process.env['RETEST_TEST_INSTALL_LOGS']

describe('installing the three pinned browsers from real publisher archives on a local mirror', { skip: unverified }, () => {
  const home = tempFolder('retest-browser-install-home-')
  const folders = cacheFolders({ HOME: home }) ?? assert.fail('a cache')
  const env = { HOME: home, NO_COLOR: '1', RETEST_DOWNLOAD_MIRROR: '', RETEST_CHROMIUM: '' }

  before(() => {
    env.RETEST_DOWNLOAD_MIRROR = mirror
    routes.set('/doctor-app', (_request, response) => {
      response.setHeader('content-type', 'text/html')
      response.end('<!doctype html><title>Install doctor fixture</title>')
    })
  })

  for (const engine of ['chromium', 'firefox', 'webkit'] as const) {
    test(`${engine}: install, list, verify, repeat without fetching, and doctor`, async t => {
      const pin = findPin(engine, 'mac-arm64')
      assert.ok(pin?.kind === 'archive' && pin.licences.inspected)
      assert.ok(browserArchives !== undefined)
      const archiveName = decodeURIComponent(new URL(pin.archive.url).pathname.split('/').at(-1) ?? assert.fail('an archive name'))
      const archive = join(browserArchives, `${engine}-mac-arm64-${archiveName}`)
      assert.ok(existsSync(archive), `The real archive is required at ${archive}`)
      const route = `/${new URL(pin.archive.url).host}${new URL(pin.archive.url).pathname}`
      serveFile(route, archive)
      const save = async (name: string, result: Awaited<ReturnType<typeof runCli>>) => {
        if (browserProofLogs !== undefined) {
          await mkdir(browserProofLogs, { recursive: true })
          await writeFile(join(browserProofLogs, `${engine}-${name}.log`), `exit: ${result.exit.code}; signal: ${result.exit.signal}
${result.stdout}
${result.stderr}`)
        }
      }
      const start = requests.length
      const installed = await runCli(t, ['install', engine], { env })
      await save('install', installed)
      assert.equal(installed.exit.code, 0, `${installed.stdout}
${installed.stderr}`)
      assert.deepEqual(requestsSince(start), [route], 'exactly one request reaches the local mirror')
      assert.match(installed.stdout, new RegExp(`✓ ${engine} +`))
      assert.ok(installed.stdout.includes(`archive SHA-256 ${pin.archive.sha256}`))
      assert.equal(existsSync(archivePath(folders, pin)), false, 'the installer deletes its archive')
      const record = await readInstalledRecord(buildFolder(folders, pin))
      assert.ok(record.kind === 'found')
      if (browserProofLogs !== undefined) await writeFile(join(browserProofLogs, `${engine}-build-record.json`), `${JSON.stringify(record.record, null, 2)}\n`)
      assert.deepEqual(record.record.archive, { size: statSync(archive).size, sha256: pin.archive.sha256 })
      assert.equal(record.record.executable.sha256, pin.executable.sha256)
      assert.deepEqual(record.record.files.map(file => [file.path, file.sha256]), pin.files.map(file => [file.path, file.sha256]))
      assert.deepEqual(record.record.licences.map(file => [file.path, file.sha256]), pin.licences.files.map(file => [file.path, file.sha256]))
      assert.deepEqual(record.record.sourceCode, pin.sourceCode)
      assert.equal((await inspectBuild(pin, folders, { verify: true })).state, 'installed')
      if (engine === 'firefox') assert.deepEqual(readdirSync(join(buildFolder(folders, pin), 'build')), ['Firefox.app'], 'only the disk image app is installed')
      if (engine === 'webkit') {
        const notices = pin.licences.files.filter(file => file.bundled !== undefined)
        assert.equal(notices.length, 9)
        const notice = `WebKit is open source. Its licence notices are kept with the build in ${join(buildFolder(folders, pin), 'build', 'licenses')}; \`retest licences webkit\` prints them.`
        assert.deepEqual(installed.stdout.split('\n').map(line => line.trim()).filter(line => /licence/i.test(line)), [notice], 'install prints exactly the founder-requested notice message')
        for (const file of notices) assert.equal(installed.stdout.includes(file.sha256 ?? assert.fail('a notice checksum')), false, 'notice hashes belong to the structured list')
      }
      const listed = await runCli(t, ['install', '--list', '--json'], { env })
      await save('list', listed)
      assert.equal(listed.exit.code, 0, listed.stderr)
      const document: unknown = JSON.parse(listed.stdout)
      assert.ok(isRecord(document) && isArray(document['builds']))
      const row = document['builds'].find(build => isRecord(build) && build['engine'] === engine)
      assert.ok(isRecord(row))
      assert.deepEqual([row['state'], row['sha256']], ['installed', pin.archive.sha256])
      assert.deepEqual(row['licences'], pin.licences, 'the structured list retains every notice path, identifier, checksum and bundled source')
      assert.deepEqual(row['sourceCode'], pin.sourceCode, 'the structured list retains source and patches pointers')
      if (engine === 'webkit') {
        const notices = await runCli(t, ['licences', 'webkit'], { env })
        await save('licences', notices)
        assert.equal(notices.exit.code, 0, notices.stderr)
        assert.deepEqual(notices.stdout.split('\n').filter(line => line.startsWith('--- ')), pin.licences.files.map(file => `--- ${file.path} (${file.licence}) ---`), 'every published and supplied notice is available in order')
        for (const file of pin.licences.files) {
          const bytes: Buffer = readFileSync(join(buildFolder(folders, pin), 'build', file.path))
          assert.equal(sha256Hex(bytes), file.sha256, file.path)
          assert.ok(notices.stdout.includes(`--- ${file.path} (${file.licence}) ---\n${bytes.toString('utf8').replace(/\n?$/, '\n')}`), `${file.path}: the command prints the actual installed notice`)
        }
        assert.ok(pin.sourceCode !== undefined)
        assert.ok(notices.stdout.endsWith(`Source ${pin.sourceCode.repository}/tree/${pin.sourceCode.revision}\nPatches ${pin.sourceCode.patches}\n`), 'the full notice command retains source and patches at the end')
      }
      const verified = await runCli(t, ['install', '--list', '--verify'], { env })
      await save('verify', verified)
      assert.equal(verified.exit.code, 0, verified.stdout)
      assert.ok(lines(verified.stdout).some(line => line.startsWith(`${engine} |`) && line.includes('✓ installed') && line.includes(pin.archive.sha256 ?? assert.fail('an archive checksum'))))
      const again = await runCli(t, ['install', engine], { env })
      await save('repeat', again)
      assert.equal(again.exit.code, 0, again.stdout)
      assert.ok(again.stdout.includes('was already installed'))
      assert.deepEqual(requestsSince(start), [route], 'list, verify and repeat fetch nothing')
      const executable = engine === 'webkit' ? join(buildFolder(folders, pin), 'build') : installedExecutablePath(buildFolder(folders, pin), pin)
      const root = await writeProject(t, {
        'retest.config.ts': `import { app, defineConfig } from '@rehearsal-labs/retest'
export default defineConfig({ apps: { web: app({ baseUrl: ${JSON.stringify(`${mirror}/doctor-app`)}, targets: { ${engine}: { browser: '${engine}', executablePath: ${JSON.stringify(executable)} } } }) } })
`,
      })
      const doctor = await runCli(t, ['doctor'], { cwd: root, env })
      await save('doctor', doctor)
      assert.equal(doctor.exit.code, 0, `${doctor.stdout}
${doctor.stderr}`)
      assert.match(doctor.stdout, new RegExp(`builds +${engine} +✓ .+installed by Retest`))
      if (engine === 'webkit') assert.ok(lines(doctor.stdout).includes(`builds | webkit | ✓ ${describePin(pin)}, installed by Retest · sha256 ${pin.archive.sha256?.slice(0, 12) ?? assert.fail('an archive checksum')}; licence notices present and verified | ${installedExecutablePath(buildFolder(folders, pin), pin)}`), doctor.stdout)
      assert.deepEqual(requestsSince(start), [route, '/doctor-app'], 'doctor reads the fixture URL once and fetches no archive')
    })
  }
})

describe('what retest install refuses, and what run and doctor never do', { skip: unverified }, () => {
  // A chromium() target that names no browser, with Chrome for Testing pinned: run and doctor say what is missing,
  // and neither installs it.
  test('a run and doctor name the usable install command and fetch and install nothing', async (t) => {
    const home = tempFolder('retest-install-home-')
    const env = { HOME: home, NO_COLOR: '1', RETEST_DOWNLOAD_MIRROR: mirror, RETEST_CHROMIUM: '' }
    const start = requests.length
    const root = await writeProject(t, {
      'retest.config.ts': `import { chromium, defineConfig } from '@rehearsal-labs/retest'\n\nexport default defineConfig({ apps: { web: chromium({ baseUrl: 'http://127.0.0.1:9' }) } })\n`,
      'tests/one.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'\n\ntest('opens', async ({ page }) => {\n  await page.goto('/')\n  await expect(page).toHaveTitle('x')\n})\n`,
    })
    const doctor = await runCli(t, ['doctor'], { cwd: root, env })
    assert.equal(doctor.exit.code, 2, 'chromium() names no browser here')
    assert.match(doctor.stdout, /chromium\(\) +✗ chromium\(\) needs a browser\./)
    assert.match(doctor.stdout, /builds +chromium +✗ Chrome for Testing 153\.0\.8010\.12 is not installed, and the target names no build\n +Run npx retest install chromium, then give the target its executablePath or set RETEST_CHROMIUM\./)
    const run = await runCli(t, ['run', '--reporter', 'agent'], { cwd: root, env })
    assert.equal(run.exit.code, 2, `${run.stdout}\n${run.stderr}`)
    assert.deepEqual(requestsSince(start), [], 'not one request reached the mirror')
    assert.equal(existsSync(join(home, 'Library', 'Caches', 'retest')), false, 'nothing was written to the cache')
  })
})

describe('installing stand-in builds through the install itself', { skip: unverified }, () => {
  const executableText = '#!/bin/sh\necho "stand-in build ran"\n'
  const licenceText = 'Stand-in licence: anyone may use this.\n'

  function pinOf(archive: { url: string; sha256: string; size: number }, overrides: Partial<ArchivePin> = {}): ArchivePin {
    return {
      kind: 'archive',
      engine: 'electron',
      title: 'Stand-in',
      version: '2.0.0',
      platform: 'mac-arm64',
      archive: { format: 'zip', url: archive.url, sha256: archive.sha256, size: archive.size },
      executable: { path: 'Stand-in.app/Contents/MacOS/stand-in', sha256: sha256Hex(executableText) },
      files: [],
      licences: { inspected: true, files: [{ path: 'LICENSE', title: 'the licence of the stand-in', licence: 'MIT', sha256: sha256Hex(licenceText), published: true }] },
      provenance: 'made by the test',
      ...overrides,
    }
  }

  // Packs a folder the way a publisher's zip holds a build: its contents at the root, links kept as links.
  async function zipOf(name: string, entries: Readonly<Record<string, string | { link: string } | { text: string; mode: number }>>): Promise<{ route: string; url: string; path: string; sha256: string; size: number }> {
    const folder = tempFolder(`retest-stand-in-${name}-`)
    const source = join(folder, 'source')
    for (const [path, entry] of Object.entries(entries)) {
      const target = join(source, path)
      await mkdir(dirname(target), { recursive: true })
      if (typeof entry === 'string') await writeFile(target, entry)
      else if ('link' in entry) await symlink(entry.link, target)
      else {
        await writeFile(target, entry.text)
        await chmod(target, entry.mode)
      }
    }
    const path = join(folder, `${name}.zip`)
    execFileSync('/usr/bin/zip', ['-q', '-r', '-y', path, '.'], { cwd: source })
    const bytes = readFileSync(path)
    const route = `/example.invalid/${name}.zip`
    serveFile(route, path)
    return { route, url: `https://example.invalid/${name}.zip`, path, sha256: sha256Hex(bytes), size: bytes.length }
  }

  const goodBuild = {
    'Stand-in.app/Contents/MacOS/stand-in': { text: executableText, mode: 0o755 },
    'Stand-in.app/Contents/Frameworks/Versions/A/library': 'a library',
    'Stand-in.app/Contents/Frameworks/Current': { link: 'Versions/A' },
    'LICENSE': licenceText,
  }

  function install(folders: CacheFolders, pin: ArchivePin, extra: { signal?: AbortSignal; ditto?: string; idleMs?: number } = {}) {
    const lines: string[] = []
    const done = installArchive({ pin, folders, mirror, signal: extra.signal ?? new AbortController().signal, tools: { ...systemUnpackTools, ditto: extra.ditto ?? systemUnpackTools.ditto }, platform: process.platform, version: '0.0.0-test', report: (line) => lines.push(line), ...(extra.idleMs === undefined ? {} : { idleMs: extra.idleMs }) })
    return { lines, done }
  }

  function cache(): CacheFolders {
    return cacheFolders({ HOME: tempFolder('retest-install-home-') }) ?? assert.fail('a cache')
  }

  test('installs a zip whose links stay inside it, and its binary runs from the path the record names', async () => {
    const archive = await zipOf('good', goodBuild)
    const folders = cache()
    const pin = pinOf(archive)
    const result = await install(folders, pin).done
    assert.ok(result.ok, result.ok ? '' : result.message)
    assert.equal(result.action, 'installed')
    const executable = result.inspection.executablePath ?? assert.fail('an executable')
    assert.equal(spawnSync(executable, { encoding: 'utf8' }).stdout, 'stand-in build ran\n')
    assert.equal((await inspectBuild(pin, folders, { verify: true })).state, 'installed')
    assert.equal(existsSync(archivePath(folders, pin)), false)
  })

  test('refuses a zip without a licence notice the pin names, naming it, and deletes the archive', async () => {
    const withoutLicence = Object.fromEntries(Object.entries(goodBuild).filter(([path]) => path !== 'LICENSE'))
    const archive = await zipOf('no-licence', withoutLicence)
    const folders = cache()
    const pin = pinOf(archive)
    const result = await install(folders, pin).done
    assert.equal(result.ok, false)
    assert.deepEqual(result.ok ? undefined : result.notices, { lead: 'Stand-in 2.0.0 lacks these licence notices, so Retest deleted its archive and installed nothing:', files: [{ path: 'LICENSE', title: 'the licence of the stand-in, missing' }] })
    assert.match(result.ok ? '' : result.message, /^The build lacks licence notices it must carry: LICENSE \(the licence of the stand-in, missing\)\. Retest does not install a build without them\. The archive was deleted and nothing was installed\.$/)
    assert.equal(existsSync(buildFolder(folders, pin)), false)
    assert.deepEqual(readdirSync(join(folders.browsers, 'downloads')), [])
    assert.deepEqual(readdirSync(folders.browsers).sort(), ['downloads'], 'no staging folder is left')
  })

  test('records and prints only the origin and path of the address a download was redirected to', async () => {
    const archive = await zipOf('redirected', goodBuild)
    const signed = `${archive.route}?X-Amz-Signature=redirect-secret&X-Amz-Credential=redirect-secret`
    serveFile(signed, archive.path)
    const route = '/example.invalid/redirect-signed.zip'
    routes.set(route, (_request, response) => {
      response.statusCode = 302
      response.setHeader('location', signed)
      response.end()
    })
    const folders = cache()
    const pin = pinOf({ ...archive, url: 'https://example.invalid/redirect-signed.zip' })
    const running = install(folders, pin)
    const result = await running.done
    assert.ok(result.ok, result.ok ? '' : result.message)
    const reading = await readInstalledRecord(buildFolder(folders, pin))
    assert.ok(reading.kind === 'found')
    assert.equal(reading.record.fetchedFrom, `${mirror}${archive.route}`, 'the record keeps the origin and path the archive came from')
    assert.ok(!readFileSync(join(buildFolder(folders, pin), 'build.json'), 'utf8').includes('redirect-secret'), 'the record holds no query')
    assert.ok(!running.lines.join('\n').includes('redirect-secret'), 'nothing printed holds the query')
  })

  test('refuses a zip with a link that leads outside the build', async () => {
    const archive = await zipOf('escape', { ...goodBuild, 'Stand-in.app/Contents/Resources/passwords': { link: '/etc/passwd' } })
    const folders = cache()
    const result = await install(folders, pinOf(archive)).done
    assert.match(result.ok ? '' : result.message, /^The archive holds links that lead outside the build: Stand-in\.app\/Contents\/Resources\/passwords -> \/etc\/passwd\. The archive was deleted and nothing was installed\.$/)
  })

  test('keeps a verified archive whose unpacking failed, and uses it again without fetching', async () => {
    const archive = await zipOf('kept', goodBuild)
    const folders = cache()
    const pin = pinOf(archive)
    const start = requests.length
    const failed = await install(folders, pin, { ditto: '/usr/bin/false' }).done
    assert.equal(failed.ok, false)
    assert.match(failed.ok ? '' : failed.message, new RegExp(`^Unpacking the archive failed: ditto ended with exit code 1\\. The verified archive is kept at ${archivePath(folders, pin).replaceAll('.', '\\.')} for the next attempt\\.$`))
    assert.ok(existsSync(archivePath(folders, pin)))
    assert.equal(existsSync(buildFolder(folders, pin)), false)
    const again = install(folders, pin)
    const result = await again.done
    assert.ok(result.ok, result.ok ? '' : result.message)
    assert.deepEqual(requestsSince(start), [archive.route], 'the second attempt fetched nothing')
    assert.match(again.lines[0] ?? '', /^Using the archive kept from an earlier attempt, .+; its SHA-256 matches the pin\.$/)
    assert.equal(existsSync(archivePath(folders, pin)), false)
  })

  test('stops a download that is interrupted, and leaves no partial archive, staging folder or record', async () => {
    const archive = await zipOf('interrupted', goodBuild)
    const bytes = readFileSync(archive.path)
    const route = '/example.invalid/interrupted-slow.zip'
    const controller = new AbortController()
    // The stop lands once the server has sent the first bytes, so it is the download that is interrupted, however long
    // the steps before it took.
    routes.set(route, (_request, response) => {
      response.setHeader('content-length', String(bytes.length))
      response.write(bytes.subarray(0, 64), () => setTimeout(() => controller.abort(), 100))
    })
    const folders = cache()
    const pin = pinOf({ ...archive, url: 'https://example.invalid/interrupted-slow.zip' })
    const running = install(folders, pin, { signal: controller.signal })
    const result = await running.done
    assert.deepEqual(result, { ok: false, message: 'The download was stopped. Nothing was installed.', stopped: true })
    assert.deepEqual(readdirSync(join(folders.browsers, 'downloads')), [])
    assert.deepEqual(readdirSync(folders.browsers).sort(), ['downloads'])
  })

  test('copies the app out of a disk image, detaches it, and records the build', async () => {
    const folder = tempFolder('retest-stand-in-image-')
    const source = join(folder, 'volume')
    await mkdir(join(source, 'Stand-in.app/Contents/MacOS'), { recursive: true })
    await mkdir(join(source, 'Stand-in.app/Contents/Resources'), { recursive: true })
    await writeFile(join(source, 'Stand-in.app/Contents/MacOS/stand-in'), executableText)
    await chmod(join(source, 'Stand-in.app/Contents/MacOS/stand-in'), 0o755)
    await writeFile(join(source, 'Stand-in.app/Contents/Resources/LICENSE'), licenceText)
    await writeFile(join(source, 'Read me.txt'), 'not part of the app')
    const image = join(folder, 'Stand-in 2.0.0.dmg')
    execFileSync('/usr/bin/hdiutil', ['create', '-quiet', '-fs', 'HFS+', '-volname', 'Stand-in', '-srcfolder', source, '-format', 'UDZO', image])
    const bytes = readFileSync(image)
    const route = '/example.invalid/Stand-in%202.0.0.dmg'
    serveFile(route, image)
    const url = 'https://example.invalid/Stand-in%202.0.0.dmg'
    const pin = pinOf({ url, sha256: sha256Hex(bytes), size: bytes.length }, {
      archive: { format: 'dmg', app: 'Stand-in.app', url, sha256: sha256Hex(bytes), size: bytes.length },
      licences: { inspected: true, files: [{ path: 'Stand-in.app/Contents/Resources/LICENSE', title: 'the licence of the stand-in', licence: 'MIT', sha256: sha256Hex(licenceText), published: true }] },
    })
    const mountsBefore = imageMounts()
    const folders = cache()
    const result = await install(folders, pin).done
    assert.ok(result.ok, result.ok ? '' : result.message)
    assert.deepEqual(readdirSync(join(buildFolder(folders, pin), 'build')), ['Stand-in.app'], 'only the app is copied out of the image')
    assert.equal(spawnSync(result.inspection.executablePath ?? '', { encoding: 'utf8' }).stdout, 'stand-in build ran\n')
    assert.deepEqual(imageMounts(), mountsBefore, 'the image is detached again')
    assert.deepEqual(readdirSync(tmpdir()).filter((name) => name.startsWith('retest-install-image-')), [], 'its mount point is removed')
  })

  // hdiutil hands an attach to a system helper that can finish it after hdiutil is ended. Before the fix, a stop 100 ms
  // into the attach of this image left it mounted on this Mac, and every later attach of it failed as busy.
  test('leaves no disk image attached when a stop lands during its attach, whenever it lands', { timeout: 180_000 }, async () => {
    const folder = tempFolder('retest-stopped-image-')
    const source = join(folder, 'volume')
    await mkdir(join(source, 'Stand-in.app/Contents/MacOS'), { recursive: true })
    await writeFile(join(source, 'Stand-in.app/Contents/MacOS/blob'), randomBytes(20 * 1024 * 1024))
    const image = join(folder, 'Stopped 1.0.0.dmg')
    execFileSync('/usr/bin/hdiutil', ['create', '-quiet', '-fs', 'HFS+', '-volname', 'Stopped', '-srcfolder', source, '-format', 'UDZO', image])
    const attachedFrom = (): string[] => execFileSync('/usr/bin/hdiutil', ['info'], { encoding: 'utf8' }).split('\n').filter((line) => line.includes(ownedTemporaryRoot))
    const mountPoints = (): string[] => readdirSync(tmpdir()).filter((name) => name.startsWith('retest-install-image-'))
    const pointsBefore = new Set(mountPoints())
    assert.deepEqual(attachedFrom(), [], 'nothing of this test is attached before it starts')
    // The first attach of a new image spends its time checking the image, where a stop ends it cleanly; once it has
    // been attached whole, later attaches reach the mount within these delays.
    const whole = join(tempFolder('retest-stopped-into-'), 'build')
    await mkdir(whole)
    assert.equal(await unpackArchive({ archive: image, format: { format: 'dmg', app: 'Stand-in.app' }, into: whole, platform: 'darwin', tools: systemUnpackTools, signal: new AbortController().signal, timeoutMs: 60_000 }), undefined, 'the image unpacks whole when nothing stops it')
    for (const delay of [40, 60, 80, 100, 120, 150, 200, 300]) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), delay)
      const into = join(tempFolder('retest-stopped-into-'), 'build')
      await mkdir(into)
      await unpackArchive({ archive: image, format: { format: 'dmg', app: 'Stand-in.app' }, into, platform: 'darwin', tools: systemUnpackTools, signal: controller.signal, timeoutMs: 60_000 })
      clearTimeout(timer)
      assert.deepEqual(attachedFrom(), [], `nothing is left attached after a stop at ${delay} ms`)
      assert.deepEqual(mountPoints().filter((name) => !pointsBefore.has(name)), [], `no mount point is left after a stop at ${delay} ms`)
    }
  })
})

// The newest generation of an install lock, and whether the released mark named after its own token is beside it.
function lockState(path: string): { readonly generation: number; readonly released: boolean } {
  const names = existsSync(path) ? readdirSync(path) : []
  const generation = Math.max(0, ...names.map((name) => Number(/^(\d+)\.json$/.exec(name)?.[1] ?? 0)))
  if (generation === 0) return { generation, released: false }
  const value: unknown = JSON.parse(readFileSync(join(path, `${generation}.json`), 'utf8'))
  const token = typeof value === 'object' && value !== null && 'token' in value && typeof value.token === 'string' ? value.token : ''
  return { generation, released: names.includes(`${generation}.${token}.released`) }
}

// The mount points of disk images attached under the temporary folder, as hdiutil lists them.
function imageMounts(): string[] {
  const listed = execFileSync('/usr/bin/hdiutil', ['info'], { encoding: 'utf8' })
  return listed.split('\n').filter((line) => line.includes('retest-install-image-'))
}

// The port the stand-in server listens on.
function listeningPort(listening: Server): number {
  const address = listening.address()
  assert.ok(address !== null && typeof address === 'object', 'the stand-in server listens on a port')
  return address.port
}
