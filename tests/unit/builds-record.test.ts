import type { BuildPin, SourcePin } from '../../src/browser/builds.ts'
import type { ExecutorBuild } from '../../src/native/executors.ts'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { buildFolder, findPin, inspectBuild, inspectBuilds, installedExecutable, installedExecutablePath, readInstalledRecord, recordFile, treeFolder } from '../../src/browser/builds.ts'
import { folderChecksum } from '../../src/native/executors.ts'
import { sha256Hex } from '../../src/shared/sha256.ts'
import { tempFolder } from '../support/temp-folder.ts'
import { installStandIn, standInLicence, standInPin, temporaryCache, writeEntries } from './builds-fixtures.ts'

// Every inspection reads files only. The global fetch is replaced by one that fails the test, so a reading that
// reached for the network would show here.
let fetches = 0
const realFetch = globalThis.fetch
beforeEach(() => {
  fetches = 0
  globalThis.fetch = async () => {
    fetches += 1
    throw new Error('an inspection must not touch the network')
  }
})
afterEach(() => {
  globalThis.fetch = realFetch
  assert.equal(fetches, 0, 'nothing was fetched')
})

describe('the record of an installed build', () => {
  test('is read back as written, and one Retest did not write is named unreadable', async () => {
    const { folders } = temporaryCache()
    const pin = standInPin()
    const { folder, record } = await installStandIn(folders, pin)
    assert.deepEqual(await readInstalledRecord(folder), { kind: 'found', record })
    await writeFile(join(folder, recordFile), '{"schemaVersion":1,"engine":"netscape"}')
    const unreadable = await readInstalledRecord(folder)
    assert.equal(unreadable.kind, 'unreadable')
    assert.match(unreadable.kind === 'unreadable' ? unreadable.problem : '', /^it is not a record retest install wrote \(.*engine/)
    await writeFile(join(folder, recordFile), '{not json')
    assert.equal((await readInstalledRecord(folder)).kind, 'unreadable')
    await rm(join(folder, recordFile))
    assert.deepEqual(await readInstalledRecord(folder), { kind: 'missing' })
  })

  test('records the checksum, the pin and each licence file it found', async () => {
    const { folders } = temporaryCache()
    const pin = standInPin({ sha256: sha256Hex('archive') })
    const { folder, record } = await installStandIn(folders, pin, { size: 7, sha256: sha256Hex('archive') })
    const saved: unknown = JSON.parse(await readFile(join(folder, recordFile), 'utf8'))
    assert.deepEqual(saved, record)
    assert.equal(record.archive.sha256, pin.archive.sha256)
    assert.deepEqual([record.engine, record.version, record.platform, record.source], ['electron', '1.0.0', 'mac-arm64', pin.archive.url])
    assert.deepEqual(record.licences, [{ path: 'LICENSE', licence: 'MIT', sha256: pin.licences.inspected ? pin.licences.files[0]?.sha256 : '' }])
    assert.equal(record.tree.sha256, await folderChecksum(join(folder, treeFolder)))
  })
})

describe('inspecting the cache', () => {
  test('a pin with no folder is missing', async () => {
    const { folders } = temporaryCache()
    const pin = standInPin()
    assert.deepEqual(await inspectBuild(pin, folders), { pin, folder: buildFolder(folders, pin), state: 'missing', problems: [] })
  })

  test('a build that matches its record is installed, with its executable and checksum', async () => {
    const { folders } = temporaryCache()
    const pin = standInPin({ sha256: sha256Hex('archive') })
    const { folder } = await installStandIn(folders, pin, { size: 7, sha256: sha256Hex('archive') })
    const inspection = await inspectBuild(pin, folders)
    assert.equal(inspection.state, 'installed', inspection.problems.join('\n'))
    assert.equal(inspection.executablePath, join(folder, 'build', 'Stand-in.app/Contents/MacOS/stand-in'))
    assert.equal(inspection.executablePath, installedExecutablePath(folder, pin))
    assert.equal(inspection.sha256, sha256Hex('archive'))
    assert.equal(inspection.installedAt, '2026-10-05T00:00:00.000Z')
    assert.equal((await inspectBuild(pin, folders, { verify: true })).state, 'installed')
  })

  const breaks: [string, (folder: string) => Promise<void>, RegExp][] = [
    ['a changed executable', (folder) => writeFile(join(folder, 'build/Stand-in.app/Contents/MacOS/stand-in'), '#!/bin/sh\necho changed\n'), /stand-in has SHA-256 [0-9a-f]{64}, not the [0-9a-f]{64} recorded at install\./],
    ['an executable that cannot run', (folder) => chmod(join(folder, 'build/Stand-in.app/Contents/MacOS/stand-in'), 0o644), /stand-in cannot be executed\./],
    ['a licence file removed', (folder) => rm(join(folder, 'build/LICENSE')), /build\/LICENSE is missing\./],
    ['a changed licence file', (folder) => writeFile(join(folder, 'build/LICENSE'), 'another licence\n'), /build\/LICENSE has SHA-256/],
    ['a pinned file removed', (folder) => rm(join(folder, 'build/protocol.json')), /protocol\.json is missing\./],
    ['no record', (folder) => rm(join(folder, recordFile)), /holds no build\.json, so nothing records what is in it\./],
    ['an unreadable record', (folder) => writeFile(join(folder, recordFile), '[]'), /Its build\.json cannot be read: it is not a record retest install wrote/],
  ]
  for (const [what, damage, problem] of breaks) {
    test(`${what} makes the build damaged, and says what`, async () => {
      const { folders } = temporaryCache()
      const pin = standInPin({ sha256: sha256Hex('archive') })
      const { folder } = await installStandIn(folders, pin)
      await damage(folder)
      const inspection = await inspectBuild(pin, folders)
      assert.equal(inspection.state, 'damaged')
      assert.match(inspection.problems.join('\n'), problem)
      assert.equal(inspection.executablePath, undefined, 'a damaged build offers no executable')
    })
  }

  test('a build installed from another archive, or recorded without a licence the pin names, is damaged', async () => {
    const { folders } = temporaryCache()
    const installed = standInPin({ sha256: sha256Hex('archive') })
    await installStandIn(folders, installed, { size: 7, sha256: sha256Hex('archive') })
    const repinned = standInPin({ sha256: sha256Hex('another archive') })
    assert.match((await inspectBuild(repinned, folders)).problems.join('\n'), /installed from an archive with SHA-256 [0-9a-f]{64}, not the pinned [0-9a-f]{64}\./)
    const moreLicences = standInPin({ sha256: sha256Hex('archive') }, { licences: { inspected: true, files: [...(installed.licences.inspected ? installed.licences.files : []), { path: 'NOTICE', title: 'a notice added to the pin', licence: 'MIT', published: true }] } })
    assert.match((await inspectBuild(moreLicences, folders)).problems.join('\n'), /Its record lists no NOTICE \(a notice added to the pin\)\./)
    const otherExecutable = standInPin({ sha256: sha256Hex('archive') }, { executable: { path: 'Stand-in.app/Contents/MacOS/stand-in', sha256: sha256Hex('another binary') } })
    assert.match((await inspectBuild(otherExecutable, folders)).problems.join('\n'), /Its record holds the executable with SHA-256 [0-9a-f]{64}, not the pinned [0-9a-f]{64}\./)
  })

  test('a full check reads every file again, and finds a change no pinned file shows', async () => {
    const { folders } = temporaryCache()
    const pin = standInPin({ sha256: sha256Hex('archive') })
    const { folder } = await installStandIn(folders, pin)
    await writeFile(join(folder, 'build/Stand-in.app/Contents/Resources/readme.txt'), 'changed after install\n')
    assert.equal((await inspectBuild(pin, folders)).state, 'installed', 'the quick reading checks only what the pin names')
    const verified = await inspectBuild(pin, folders, { verify: true })
    assert.equal(verified.state, 'damaged')
    assert.match(verified.problems.join('\n'), /Its files read as [0-9a-f]{64}, not the [0-9a-f]{64} recorded at install\./)
  })

  test('something other than a folder where a build belongs is damaged', async () => {
    const { folders } = temporaryCache()
    const pin = standInPin({ sha256: sha256Hex('archive') })
    await mkdir(folders.browsers, { recursive: true })
    await writeFile(buildFolder(folders, pin), 'a file')
    const inspection = await inspectBuild(pin, folders)
    assert.equal(inspection.state, 'damaged')
    assert.match(inspection.problems.join('\n'), /is not a folder\./)
  })

  test('lists every pin of a platform, and no other', async () => {
    const { folders } = temporaryCache()
    const mac = standInPin()
    const linux = standInPin({}, { platform: 'linux-x64' })
    const pins: BuildPin[] = [mac, linux]
    assert.deepEqual((await inspectBuilds('linux-x64', folders, {}, pins)).map((inspection) => [inspection.pin.platform, inspection.state]), [['linux-x64', 'missing']])
  })

  test("names an installed build's executable for a driver, and nothing once it is missing or damaged", async () => {
    const { home, folders } = temporaryCache()
    const pin = standInPin({ sha256: sha256Hex('archive') })
    const options = { platform: 'mac-arm64' as const, pins: [pin] }
    assert.equal(await installedExecutable('electron', { HOME: home }, options), undefined)
    const { folder } = await installStandIn(folders, pin)
    const env = { HOME: home }
    assert.equal(await installedExecutable('electron', env, options), installedExecutablePath(folder, pin))
    assert.equal(await installedExecutable('electron', {}, options), undefined, 'without a home folder there is no cache')
    assert.equal(await installedExecutable('firefox', env, options), undefined, 'an engine with no pin has no build')
    await rm(join(folder, 'build/LICENSE'))
    assert.equal(await installedExecutable('electron', env, options), undefined)
  })
})

describe('what inspection holds against the pin, not the record', () => {
  test('a folder for a pin retest install refuses is never installed, whatever its record and files say, and offers no executable', async () => {
    const { home, folders } = temporaryCache()
    // Every file the record names is there as recorded; only the pin has no archive checksum, so no install of
    // Retest's could have put it there.
    const unpinned = standInPin()
    const { folder } = await installStandIn(folders, unpinned)
    for (const verify of [false, true]) {
      const inspection = await inspectBuild(unpinned, folders, { verify })
      assert.equal(inspection.state, 'unverifiable', `verify: ${verify}`)
      assert.equal(inspection.executablePath, undefined)
      assert.equal(inspection.sha256, undefined)
      assert.match(inspection.problems.join('\n'), new RegExp(`^Retest does not install Stand-in 1\\.0\\.0, so nothing in .+ was installed or checked by Retest: No checksum is pinned for the archive`))
    }
    assert.equal(await installedExecutable('electron', { HOME: home }, { platform: 'mac-arm64', pins: [unpinned] }), undefined, 'its executable is never handed to a run')
    const withoutNotices = standInPin({ sha256: sha256Hex('archive') }, { licences: { inspected: true, files: [{ path: 'LICENSE', title: 'the licence of the stand-in', licence: 'MIT', sha256: sha256Hex(standInLicence), published: false }] } })
    assert.equal((await inspectBuild(withoutNotices, folders)).state, 'unverifiable', 'nor is one published without its notices')
    await rm(join(folder, recordFile))
    assert.equal((await inspectBuild(unpinned, folders)).state, 'unverifiable', 'with or without a record')
  })

  test("the record's tree checksum must be the pin's, and a full check reads the files against the pin", async () => {
    const { folders } = temporaryCache()
    const plain = standInPin({ sha256: sha256Hex('archive') })
    const { folder } = await installStandIn(folders, plain)
    const root = join(folder, treeFolder)
    const pin = standInPin({ sha256: sha256Hex('archive') }, { treeSha256: await folderChecksum(root) })
    assert.equal((await inspectBuild(pin, folders, { verify: true })).state, 'installed')
    // A change the record is rewritten to match: the record agrees with the files, the pin does not.
    await writeFile(join(root, 'Stand-in.app/Contents/Resources/readme.txt'), 'changed after install\n')
    const record: unknown = JSON.parse(await readFile(join(folder, recordFile), 'utf8'))
    assert.ok(typeof record === 'object' && record !== null)
    await writeFile(join(folder, recordFile), JSON.stringify({ ...record, tree: { sha256: await folderChecksum(root) } }))
    const quick = await inspectBuild(pin, folders)
    assert.equal(quick.state, 'damaged')
    assert.match(quick.problems.join('\n'), /Its record holds the tree checksum [0-9a-f]{64}, not the pinned [0-9a-f]{64}\./)
    const verified = await inspectBuild(pin, folders, { verify: true })
    assert.equal(verified.state, 'damaged')
  })

  test('a full check finds a file given a set-id bit and a FIFO put into the build, which the tree checksum passes over', async () => {
    const { folders } = temporaryCache()
    const pin = standInPin({ sha256: sha256Hex('archive') })
    const { folder } = await installStandIn(folders, pin)
    const readme = join(folder, 'build/Stand-in.app/Contents/Resources/readme.txt')
    await chmod(readme, 0o4755)
    assert.equal((await lstat(readme)).mode & 0o4000, 0o4000, 'the file system kept the bit')
    const setId = await inspectBuild(pin, folders, { verify: true })
    assert.equal(setId.state, 'damaged')
    assert.deepEqual(setId.problems, ['It holds files that would run as their owner or group: Stand-in.app/Contents/Resources/readme.txt.'])
    await chmod(readme, 0o644)
    assert.equal(spawnSync('/usr/bin/mkfifo', [join(folder, 'build/Stand-in.app/Contents/Resources/pipe')]).status, 0)
    const fifo = await inspectBuild(pin, folders, { verify: true })
    assert.equal(fifo.state, 'damaged')
    assert.deepEqual(fifo.problems, ['It holds entries that are not files, folders or links: Stand-in.app/Contents/Resources/pipe (a FIFO).'])
  })

  test('a FIFO where a licence belongs makes the build damaged at once, without waiting on it', { timeout: 10_000 }, async () => {
    const { home, folders } = temporaryCache()
    const pin = standInPin({ sha256: sha256Hex('archive') })
    const { folder } = await installStandIn(folders, pin)
    const licence = join(folder, 'build/LICENSE')
    await rm(licence)
    assert.equal(spawnSync('/usr/bin/mkfifo', [licence]).status, 0)
    const inspection = await inspectBuild(pin, folders)
    assert.equal(inspection.state, 'damaged')
    assert.deepEqual(inspection.problems, [`${licence} is a FIFO, not a file.`])
    assert.equal(await installedExecutable('electron', { HOME: home }, { platform: 'mac-arm64', pins: [pin] }), undefined)
  })

  test('a link put where a pinned file was is never followed, even to a file with the same bytes', async () => {
    const { folders } = temporaryCache()
    const pin = standInPin({ sha256: sha256Hex('archive') })
    const { folder } = await installStandIn(folders, pin)
    const elsewhere = join(tempFolder('retest-elsewhere-'), 'LICENSE')
    await writeFile(elsewhere, standInLicence)
    const licence = join(folder, 'build/LICENSE')
    await rm(licence)
    await symlink(elsewhere, licence)
    const inspection = await inspectBuild(pin, folders)
    assert.equal(inspection.state, 'damaged')
    assert.deepEqual(inspection.problems, [`${licence} is a link, not a file.`])
  })

  test('a link or an oversized file where the record belongs makes the build damaged, and the link is never followed', async () => {
    const { folders } = temporaryCache()
    const pin = standInPin({ sha256: sha256Hex('archive') })
    const { folder } = await installStandIn(folders, pin)
    const record = join(folder, recordFile)
    // The record the link leads to is the build's own, word for word, so only following it could make the build installed.
    const elsewhere = join(tempFolder('retest-elsewhere-'), recordFile)
    await rename(record, elsewhere)
    await symlink(elsewhere, record)
    const linked = await inspectBuild(pin, folders)
    assert.equal(linked.state, 'damaged')
    assert.deepEqual(linked.problems, ['Its build.json cannot be read: it is a link, not a file.'])
    await rm(record)
    // Still the build's own record, padded past the size of any record Retest writes; refused before it is read.
    await writeFile(record, `${await readFile(elsewhere, 'utf8')}${' '.repeat(1024 * 1024)}`)
    const oversized = await inspectBuild(pin, folders)
    assert.equal(oversized.state, 'damaged')
    assert.match(oversized.problems.join('\n'), /^Its build\.json cannot be read: it is \d+ bytes, more than the 1048576 a record Retest writes may take\.$/)
  })

  test('a FIFO where the record belongs makes the build damaged at once, without waiting on it', { timeout: 10_000 }, async () => {
    const { home, folders } = temporaryCache()
    const pin = standInPin({ sha256: sha256Hex('archive') })
    const { folder } = await installStandIn(folders, pin)
    await rm(join(folder, recordFile))
    assert.equal(spawnSync('/usr/bin/mkfifo', [join(folder, recordFile)]).status, 0)
    const inspection = await inspectBuild(pin, folders)
    assert.equal(inspection.state, 'damaged')
    assert.deepEqual(inspection.problems, ['Its build.json cannot be read: it is a FIFO, not a file.'])
    assert.equal(await installedExecutable('electron', { HOME: home }, { platform: 'mac-arm64', pins: [pin] }), undefined)
  })
})

describe('inspecting a native executor build', () => {
  const real = findPin('webdriveragent', 'mac-arm64')
  assert.ok(real?.kind === 'source')
  // The real pin's folder and commit, with licence files of the test's own, since only the real build has the texts.
  const pin: SourcePin = {
    ...real,
    licences: {
      inspected: true,
      files: [
        { path: 'licenses/Stand-in-LICENSE.txt', title: 'a licence text', licence: 'BSD-3-Clause', sha256: sha256Hex('licence text\n'), published: true },
        { path: 'licenses/Stand-in-NOTICE.txt', title: 'a header notice', licence: 'Apache-2.0', published: true },
      ],
    },
  }

  async function writeExecutorBuild(folders: { browsers: string; executors: string }, change: Partial<ExecutorBuild> = {}): Promise<{ folder: string; build: ExecutorBuild }> {
    const folder = buildFolder(folders, pin)
    const products = join(folder, 'derived/Build/Products/Debug-iphonesimulator')
    await writeEntries(folder, {
      'licenses/Stand-in-LICENSE.txt': 'licence text\n',
      'licenses/Stand-in-NOTICE.txt': 'header notice\n',
      'derived/Build/Products/Debug-iphonesimulator/WebDriverAgentRunner-Runner.app/runner': 'runner',
      'derived/Build/Products/runner.xctestrun': 'xctestrun',
    })
    const build: ExecutorBuild = {
      schemaVersion: 1,
      executor: 'webdriveragent',
      version: pin.version,
      commit: pin.commit,
      key: 'key',
      xcode: pin.xcode,
      sdk: 'iphonesimulator26.5',
      architecture: 'arm64',
      origin: 'built',
      derivedDataPath: join(folder, 'derived'),
      xctestrun: join(folder, 'derived/Build/Products/runner.xctestrun'),
      products,
      productsSha256: await folderChecksum(products),
      xctestrunSha256: sha256Hex('xctestrun'),
      recordedAt: '2026-10-03T19:01:55.011Z',
      licenses: [{ path: join(folder, 'licenses/Stand-in-LICENSE.txt'), spdx: 'BSD-3-Clause', sha256: sha256Hex('licence text\n') }],
      notices: [{ path: join(folder, 'licenses/Stand-in-NOTICE.txt'), sha256: sha256Hex('header notice\n'), files: 1 }],
      ...change,
    }
    await writeFile(join(folder, 'build.json'), JSON.stringify(build))
    return { folder, build }
  }

  test('is installed when its record names the pin and its licence files are there as recorded', async () => {
    const { folders } = temporaryCache()
    const { folder, build } = await writeExecutorBuild(folders)
    const inspection = await inspectBuild(pin, folders, { verify: true })
    assert.deepEqual(inspection, { pin, folder, state: 'installed', problems: [], sha256: build.productsSha256, installedAt: build.recordedAt })
  })

  test('is damaged by another commit, another Xcode, a missing notice or changed products', async () => {
    const commit = temporaryCache()
    await writeExecutorBuild(commit.folders, { commit: '0000000000000000000000000000000000000000' })
    assert.match((await inspectBuild(pin, commit.folders)).problems.join('\n'), /not the pinned 9d1d17ddb59e6097ddc3324b23ca9f4174507b12\./)
    const xcode = temporaryCache()
    await writeExecutorBuild(xcode.folders, { xcode: { version: '26.4', build: '17E1' } })
    assert.match((await inspectBuild(pin, xcode.folders)).problems.join('\n'), /built with Xcode build 17E1, not the pinned 17F42\./)
    const notice = temporaryCache()
    const { folder } = await writeExecutorBuild(notice.folders)
    await rm(join(folder, 'licenses/Stand-in-NOTICE.txt'))
    assert.match((await inspectBuild(pin, notice.folders)).problems.join('\n'), /Stand-in-NOTICE\.txt is missing\./)
    const products = temporaryCache()
    const written = await writeExecutorBuild(products.folders)
    await writeFile(join(written.build.products, 'WebDriverAgentRunner-Runner.app/runner'), 'rebuilt')
    assert.equal((await inspectBuild(pin, products.folders)).state, 'installed', 'products are read only by a full check')
    assert.match((await inspectBuild(pin, products.folders, { verify: true })).problems.join('\n'), /Its products at .+ read as [0-9a-f]{64}, not the recorded [0-9a-f]{64}\./)
  })

  test('is damaged at once by a link or a FIFO where its record belongs, never following the one or waiting on the other', { timeout: 10_000 }, async () => {
    const linked = temporaryCache()
    const written = await writeExecutorBuild(linked.folders)
    const elsewhere = join(tempFolder('retest-elsewhere-'), 'build.json')
    await rename(join(written.folder, 'build.json'), elsewhere)
    await symlink(elsewhere, join(written.folder, 'build.json'))
    const link = await inspectBuild(pin, linked.folders)
    assert.equal(link.state, 'damaged')
    assert.deepEqual(link.problems, ['Its build.json cannot be read: it is a link, not a file.'])
    const piped = temporaryCache()
    const { folder } = await writeExecutorBuild(piped.folders)
    await rm(join(folder, 'build.json'))
    assert.equal(spawnSync('/usr/bin/mkfifo', [join(folder, 'build.json')]).status, 0)
    const fifo = await inspectBuild(pin, piped.folders)
    assert.equal(fifo.state, 'damaged')
    assert.deepEqual(fifo.problems, ['Its build.json cannot be read: it is a FIFO, not a file.'])
  })
})
