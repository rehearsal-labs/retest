import type { Server } from 'node:http'
import type { ArchivePin, CacheFolders } from '../../src/browser/builds.ts'
import type { NativeTools } from '../../src/native/processes.ts'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { chmod, lstat, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createSocketServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { buildFolder, findPin, installedExecutablePath } from '../../src/browser/builds.ts'
import { archivePath, checkUnpacked, installArchive } from '../../src/cli/install/install-archive.ts'
import { installExecutor } from '../../src/cli/install/install-executor.ts'
import { takeInstallLock } from '../../src/cli/install/lock.ts'
import { systemUnpackTools } from '../../src/cli/install/unpack.ts'
import { systemTools } from '../../src/native/processes.ts'
import { sha256Hex } from '../../src/shared/sha256.ts'
import { tempFolder } from '../support/temp-folder.ts'
import { holdLockInChild, installStandIn, listeningPort, lockState, standInFiles, standInLicence, standInPin, takeWhenFree, temporaryCache, writeEntries } from './builds-fixtures.ts'

// The install up to the point an archive would be unpacked, against a stand-in archive server on this machine, and the
// check of an unpacked build on folders the test writes. Unpacking real archives is the integration test's.

const requests: string[] = []
let server: Server
let mirror = ''
const served = Buffer.from('bytes that are not the pinned archive\n')

before(async () => {
  server = createServer((request, response) => {
    requests.push(request.url ?? '')
    response.setHeader('content-length', String(served.length))
    response.end(served)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  mirror = `http://127.0.0.1:${listeningPort(server)}`
})
after(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function install(folders: { browsers: string; executors: string }, pin = standInPin({ sha256: sha256Hex('the pinned archive') }), signal = new AbortController().signal, from = mirror) {
  const lines: string[] = []
  return { lines, done: installArchive({ pin, folders, mirror: from, signal, tools: systemUnpackTools, platform: process.platform, version: '0.0.0-test', report: (line) => lines.push(line) }) }
}

// Where the install lock of a build lives: a folder of locks beside the cache's builds, never beside the build itself.
function lockOf(folders: CacheFolders, pin: ArchivePin): string {
  return join(dirname(folders.browsers), 'locks', `${basename(buildFolder(folders, pin))}.lock`)
}

function escape(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// The pid of a process that has just ended, which no process holds until the system hands it out again.
function gonePid(): string {
  return spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout
}

describe('installing an archive build', () => {
  test('deletes an archive whose SHA-256 is not the pinned one, unread, and installs nothing', async () => {
    const { folders } = temporaryCache()
    const pin = standInPin({ sha256: sha256Hex('the pinned archive') })
    const before = requests.length
    const { lines, done } = install(folders, pin)
    const result = await done
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.message, `The archive from ${mirror}/example.invalid/releases/stand-in-1.0.0.zip has SHA-256 ${sha256Hex(served)}, not the pinned ${sha256Hex('the pinned archive')}. It was deleted unread and nothing was installed.`)
    assert.deepEqual(requests.slice(before), ['/example.invalid/releases/stand-in-1.0.0.zip'])
    assert.deepEqual(lines, [`Downloading Stand-in 1.0.0 for macOS arm64 from ${mirror}/example.invalid/releases/stand-in-1.0.0.zip`])
    assert.deepEqual(readdirSync(join(folders.browsers, 'downloads')), [], 'neither the archive nor its partial file is left')
    assert.equal(existsSync(buildFolder(folders, pin)), false)
    assert.deepEqual(readdirSync(folders.browsers).sort(), ['downloads'], 'no staging folder is left')
    assert.deepEqual(lockState(lockOf(folders, pin)), { generation: 1, released: true }, 'the install took the lock and let it go')
  })

  test('refuses a pin without a checksum, or without its notices, before anything is fetched', async () => {
    const { folders } = temporaryCache()
    const before = requests.length
    const unpinned = await install(folders, standInPin()).done
    assert.deepEqual(unpinned, { ok: false, message: 'No checksum is pinned for the archive of Stand-in 1.0.0 for macOS arm64, so Retest has nothing to check a download against and downloads nothing.', stopped: false })
    const withoutNotices = standInPin({ sha256: sha256Hex('x') }, { licences: { inspected: true, files: [{ path: 'licenses/NOTICE.txt', title: 'the notice it must carry', licence: 'BSD-2-Clause', published: false }] } })
    const refused = await install(folders, withoutNotices).done
    assert.equal(refused.ok, false)
    assert.deepEqual(refused.ok ? undefined : refused.notices, { lead: 'Stand-in 1.0.0 for macOS arm64 is published without these licence notices, and Retest installs it only once they ship with it:', files: [{ path: 'licenses/NOTICE.txt', title: 'the notice it must carry', licence: 'BSD-2-Clause', published: false }] })
    assert.match(refused.ok ? '' : refused.message, /licenses\/NOTICE\.txt \(the notice it must carry\)/)
    const real = findPin('webkit', 'mac-arm64')
    assert.ok(real?.kind === 'archive')
    const shown: string[] = []
    const webkit = await installArchive({ pin: { ...real, archive: { format: 'zip', url: real.archive.url } }, folders, mirror, signal: new AbortController().signal, tools: systemUnpackTools, platform: process.platform, version: '0.0.0-test', report: line => shown.push(line) })
    assert.equal(webkit.ok, false)
    assert.match(webkit.ok ? '' : webkit.message, /^No checksum is pinned/)
    assert.ok(real.licences.inspected)
    for (const file of real.licences.files.filter(file => file.bundled !== undefined)) assert.ok(shown.some(line => line.includes(file.path) && line.includes(file.sha256 ?? 'missing checksum')), file.path)
    assert.ok(shown.some(line => line.includes(real.sourceCode?.revision ?? 'missing revision')))
    assert.equal(requests.length, before, 'the server was never asked')
    assert.equal(existsSync(folders.browsers), false, 'the cache was not even made')
  })

  test('leaves a build installed as recorded alone, and refuses one that is not, without fetching', async () => {
    const { folders } = temporaryCache()
    const pin = standInPin({ sha256: sha256Hex('archive') })
    const { folder } = await installStandIn(folders, pin, { size: 7, sha256: sha256Hex('archive') })
    const before = requests.length
    const again = await install(folders, pin).done
    assert.equal(again.ok && again.action, 'already_installed')
    assert.equal(again.ok ? again.inspection.executablePath : '', installedExecutablePath(folder, pin))
    await rm(join(folder, 'build/LICENSE'))
    const damaged = await install(folders, pin).done
    assert.equal(damaged.ok, false)
    assert.match(damaged.ok ? '' : damaged.message, new RegExp(`^Stand-in 1\\.0\\.0 is in ${folder.replaceAll('.', '\\.')}, but not as recorded: .+LICENSE is missing\\. Remove .+ and run the install again\\.$`))
    assert.equal(requests.length, before)
  })

  // A live holder is another process holding the lock, and a gone one is that process killed, whose generation the next
  // taker passes over without anyone deleting a file; so "released" means another process takes it.
  test('waits for no other installer: a live one holding the lock refuses this one, a gone one is taken over', async () => {
    const { folders } = temporaryCache()
    const pin = standInPin({ sha256: sha256Hex('the pinned archive') })
    const lock = lockOf(folders, pin)
    const holder = await holdLockInChild(lock)
    const before = requests.length
    const held = await install(folders, pin).done
    assert.equal(held.ok, false)
    assert.match(held.ok ? '' : held.message, new RegExp(`^Another Retest process \\(pid ${holder.pid}, started as ".+", since [0-9T:.Z-]+\\) holds the install lock ${escape(lock)} and is installing this build\\. Wait for it to finish, then run the install again\\.$`))
    assert.equal(requests.length, before, 'nothing was fetched while another installer held the lock')
    await holder.kill()
    await (await takeWhenFree(lock)).release()
    const taken = await install(folders, pin).done
    assert.match(taken.ok ? '' : taken.message, /has SHA-256 [0-9a-f]{64}, not the pinned/, 'the install went on to the download')
    assert.equal(lockState(lock).released, true, 'the install let the lock go')
    const again = await takeInstallLock(lock)
    assert.ok(again.ok, 'the lock is released')
    await again.release()
  })

  test('removes the staging folder an install whose process is gone left behind', async () => {
    const { folders } = temporaryCache()
    const pin = standInPin({ sha256: sha256Hex('the pinned archive') })
    const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
    const left = `${buildFolder(folders, pin)}.staging-${gone.stdout}`
    await writeEntries(left, { 'build/half.txt': 'half unpacked' })
    await install(folders, pin).done
    assert.equal(existsSync(left), false)
  })

  test('deletes the partial downloads installs whose process is gone left, of any build, and keeps a live one', async () => {
    const { folders } = temporaryCache()
    const pin = standInPin({ sha256: sha256Hex('the pinned archive') })
    const downloads = join(folders.browsers, 'downloads')
    await mkdir(downloads, { recursive: true })
    const gone = gonePid()
    const left = `${archivePath(folders, pin)}.partial-${gone}`
    const otherBuild = join(downloads, `firefox-133.0.3-mac-arm64-Firefox 133.0.3.dmg.partial-${gone}`)
    const live = `${archivePath(folders, pin)}.partial-${process.ppid}`
    for (const path of [left, otherBuild, live]) await writeFile(path, 'half a download')
    await install(folders, pin).done
    assert.equal(existsSync(left), false, "this build's partial download from a gone install is deleted")
    assert.equal(existsSync(otherBuild), false, "another build's partial download from a gone install is deleted")
    assert.equal(existsSync(live), true, 'a partial download whose process still runs is left to it')
  })

  test('deletes a partial download and a staging folder named after a number no process can have, and goes on', async () => {
    const { folders } = temporaryCache()
    const pin = standInPin({ sha256: sha256Hex('the pinned archive') })
    const downloads = join(folders.browsers, 'downloads')
    await mkdir(downloads, { recursive: true })
    // Larger than any pid the system hands out, which the system refuses even to be asked about.
    const partial = `${archivePath(folders, pin)}.partial-99999999999`
    const staging = `${buildFolder(folders, pin)}.staging-99999999999`
    await writeFile(partial, 'half a download')
    await writeEntries(staging, { 'build/half.txt': 'half unpacked' })
    const before = requests.length
    const result = await install(folders, pin).done
    assert.match(result.ok ? '' : result.message, /has SHA-256 [0-9a-f]{64}, not the pinned/, 'the install went on to the download')
    assert.equal(requests.length, before + 1)
    assert.equal(existsSync(partial), false, 'nobody can be writing that partial download')
    assert.equal(existsSync(staging), false, 'nobody can be unpacking into that staging folder')
  })

  test('deletes an archive left beside a build that is already installed, and fetches nothing', async () => {
    const { folders } = temporaryCache()
    const pin = standInPin({ sha256: sha256Hex('archive') })
    await installStandIn(folders, pin, { size: 7, sha256: sha256Hex('archive') })
    const archive = archivePath(folders, pin)
    await mkdir(dirname(archive), { recursive: true })
    await writeFile(archive, 'archive')
    const before = requests.length
    const again = await install(folders, pin).done
    assert.equal(again.ok && again.action, 'already_installed')
    assert.equal(existsSync(archive), false, 'the archive a killed install left behind is deleted')
    assert.equal(requests.length, before)
  })

  test('refuses a mirror with a query, a fragment or credentials before anything is fetched, and never repeats it', async () => {
    const { folders } = temporaryCache()
    const before = requests.length
    for (const [given, named] of [[`${mirror}/?token=mirror-secret`, 'a query'], [`${mirror}/#mirror-secret`, 'a fragment'], [`http://user:mirror-secret@127.0.0.1:${new URL(mirror).port}`, 'credentials']] as const) {
      const { lines, done } = install(folders, standInPin({ sha256: sha256Hex('the pinned archive') }), new AbortController().signal, given)
      const result = await done
      assert.equal(result.ok, false, given)
      const message = result.ok ? '' : result.message
      assert.match(message, named === 'credentials' ? /does not send credentials written in an address/ : new RegExp(`carries ${named}, which Retest neither sends to a mirror nor records`), given)
      assert.ok(!message.includes('mirror-secret') && !lines.join('\n').includes('mirror-secret'), 'the refusal never repeats what it refused')
    }
    assert.equal(requests.length, before, 'the server was never asked')
  })

  test('downloads to a name of its own beside the builds', () => {
    const folders = { browsers: '/cache/retest/browsers', executors: '/cache/retest/native-executors' }
    const firefox = findPin('firefox', 'mac-arm64')
    assert.ok(firefox?.kind === 'archive')
    assert.equal(archivePath(folders, firefox), '/cache/retest/browsers/downloads/firefox-133.0.3-mac-arm64-Firefox 133.0.3.dmg')
  })
})

describe('checking an unpacked build', () => {
  async function unpacked(entries = standInFiles): Promise<string> {
    const root = join(tempFolder('retest-unpacked-'), 'build')
    await writeEntries(root, entries)
    return root
  }

  test('passes a build with its executable, pinned files and licences, and reads each licence', async () => {
    const root = await unpacked()
    const checked = await checkUnpacked(standInPin(), root)
    assert.ok(checked.ok, checked.ok ? '' : checked.message)
    assert.equal(checked.executableSha256, sha256Hex('#!/bin/sh\necho stand-in\n'))
    assert.deepEqual(checked.licences.map((reading) => [reading.file.path, reading.state, reading.sha256]), [['LICENSE', 'present', sha256Hex(standInLicence)]])
  })

  test('refuses a build without a licence notice it must carry, naming the file', async () => {
    const root = await unpacked()
    await rm(join(root, 'LICENSE'))
    const missing = await checkUnpacked(standInPin(), root)
    assert.deepEqual(missing, { ok: false, message: 'The build lacks licence notices it must carry: LICENSE (the licence of the stand-in, missing). Retest does not install a build without them.', missing: [{ path: 'LICENSE', title: 'the licence of the stand-in, missing' }] })
    await writeFile(join(root, 'LICENSE'), 'a different licence\n')
    const changed = await checkUnpacked(standInPin(), root)
    assert.match(changed.ok ? '' : changed.message, new RegExp(`LICENSE \\(the licence of the stand-in, SHA-256 ${sha256Hex('a different licence\n')}, not the pinned ${sha256Hex(standInLicence)}\\)`))
  })

  test('refuses a build whose executable is missing, other than pinned or not executable', async () => {
    const root = await unpacked()
    const executable = join(root, 'Stand-in.app/Contents/MacOS/stand-in')
    await chmod(executable, 0o644)
    assert.deepEqual(await checkUnpacked(standInPin(), root), { ok: false, message: 'Stand-in.app/Contents/MacOS/stand-in is not executable.' })
    await writeFile(executable, 'other')
    assert.match(JSON.stringify(await checkUnpacked(standInPin(), root)), /stand-in has SHA-256 [0-9a-f]{64}, not the pinned/)
    await rm(executable)
    assert.deepEqual(await checkUnpacked(standInPin(), root), { ok: false, message: 'The archive holds no Stand-in.app/Contents/MacOS/stand-in.' })
  })

  test('refuses a pinned file with another checksum, saying why the pin holds it', async () => {
    const root = await unpacked()
    await writeFile(join(root, 'protocol.json'), '{}')
    assert.deepEqual(await checkUnpacked(standInPin(), root), { ok: false, message: `protocol.json is there with SHA-256 ${sha256Hex('{}')}, and the pin needs SHA-256 ${sha256Hex('{"domains":[]}\n')}: the protocol the client speaks.` })
  })

  test('refuses a link that leads outside the build, and keeps links inside it', async () => {
    const root = await unpacked({ ...standInFiles, 'Stand-in.app/Contents/Frameworks/Current': { link: 'Versions/A' }, 'Stand-in.app/Contents/Frameworks/Versions/A/lib': 'library' })
    assert.equal((await checkUnpacked(standInPin(), root)).ok, true)
    await symlink('/etc', join(root, 'Stand-in.app/Contents/Resources/escape'))
    await symlink('../../../..', join(root, 'Stand-in.app/Contents/Resources/up'))
    assert.deepEqual(await checkUnpacked(standInPin(), root), { ok: false, message: 'The archive holds links that lead outside the build: Stand-in.app/Contents/Resources/escape -> /etc, Stand-in.app/Contents/Resources/up -> ../../../...' })
  })

  test('refuses a FIFO, a socket and a file with a set-id bit, naming each, and reads none of them', async () => {
    const fifo = await unpacked()
    const pipe = join(fifo, 'Stand-in.app/Contents/Resources/pipe')
    assert.equal(spawnSync('/usr/bin/mkfifo', [pipe]).status, 0, 'mkfifo made the FIFO')
    assert.deepEqual(await checkUnpacked(standInPin(), fifo), { ok: false, message: 'The archive holds entries that are not files, folders or links: Stand-in.app/Contents/Resources/pipe (a FIFO).' })
    const atLicence = await unpacked()
    await rm(join(atLicence, 'LICENSE'))
    assert.equal(spawnSync('/usr/bin/mkfifo', [join(atLicence, 'LICENSE')]).status, 0)
    assert.deepEqual(await checkUnpacked(standInPin(), atLicence), { ok: false, message: 'The archive holds entries that are not files, folders or links: LICENSE (a FIFO).' }, 'a FIFO where a licence belongs is named, never opened')
    const socket = await unpacked()
    // A socket's path must be short, so it is made in the temporary folder and moved into the build.
    const short = join(tmpdir(), `rt-${process.pid}.sock`)
    const listening = createSocketServer()
    await new Promise<void>((resolve) => listening.listen(short, resolve))
    try {
      await rename(short, join(socket, 'Stand-in.app/Contents/Resources/control'))
      assert.deepEqual(await checkUnpacked(standInPin(), socket), { ok: false, message: 'The archive holds entries that are not files, folders or links: Stand-in.app/Contents/Resources/control (a socket).' })
    } finally {
      await new Promise<void>((resolve) => listening.close(() => resolve()))
    }
    for (const [mode, bit] of [[0o4755, 'set-user-id'], [0o2755, 'set-group-id']] as const) {
      const root = await unpacked()
      const readme = join(root, 'Stand-in.app/Contents/Resources/readme.txt')
      await chmod(readme, mode)
      assert.equal((await lstat(readme)).mode & 0o7777, mode, `the file system kept the ${bit} bit`)
      assert.deepEqual(await checkUnpacked(standInPin(), root), { ok: false, message: 'The archive holds files that would run as their owner or group: Stand-in.app/Contents/Resources/readme.txt.' }, bit)
    }
  })

  test('refuses a build that does not read as the pinned tree, and one whose notices nobody looked at', async () => {
    const root = await unpacked()
    assert.match(JSON.stringify(await checkUnpacked(standInPin({}, { treeSha256: sha256Hex('another tree') }), root)), /The unpacked build reads as [0-9a-f]{64}, not the pinned [0-9a-f]{64}\./)
    assert.deepEqual(await checkUnpacked(standInPin({}, { licences: { inspected: false, reason: 'Nobody looked.' } }), root), { ok: false, message: 'Nobody looked.' })
  })
})

describe('installing a native executor', () => {
  // Tools that are not there: any tool run would fail, so a result that needs none shows no tool was run.
  const absent: NativeTools = {
    ...systemTools,
    xcrun: '/nonexistent/xcrun',
    xcodebuild: '/nonexistent/xcodebuild',
    plutil: '/nonexistent/plutil',
    git: '/nonexistent/git',
    codesign: '/nonexistent/codesign',
    ps: '/nonexistent/ps',
    lsappinfo: '/nonexistent/lsappinfo',
    swVers: '/nonexistent/sw_vers',
    automationModeTool: '/nonexistent/automationmodetool',
    osascript: '/nonexistent/osascript',
    lsof: '/nonexistent/lsof',
    lockf: '/nonexistent/lockf',
  }

  test('leaves a recorded build alone without running a tool, and passes on why one cannot be built', async () => {
    const { home, folders } = temporaryCache()
    const pin = findPin('mac2', 'mac-arm64')
    assert.ok(pin?.kind === 'source')
    const lines: string[] = []
    const refused = await installExecutor({ pin, folders, home, signal: new AbortController().signal, report: (line) => lines.push(line), tools: absent, now: () => new Date('2026-10-05T01:02:03.456Z') })
    assert.equal(refused.ok, false)
    // The executors are pinned for arm64 alone. On arm64 the build goes as far as the Xcode check, whose tool is absent;
    // on any other machine it is refused by the architecture first, before a tool could run.
    const why = process.arch === 'arm64' ? /^Xcode is needed for native apps and xcodebuild -version ended with exit code 127/ : new RegExp(`^The native executors are pinned and tested on arm64, not on ${process.arch}\\.$`)
    assert.match(refused.ok ? '' : refused.message, why)
    assert.deepEqual(lines, [`Building WebDriverAgentMac (appium-mac2-driver) 4.3.6 from ${join(home, 'Library/Caches/retest-proofs/appium-mac2-driver')} at ${pin.commit}; the log is ${join(folders.executors, 'logs', 'mac2-install-2026-10-05T01-02-03Z.log')}`])
  })
})
