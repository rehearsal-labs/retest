import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { findPin, inspectBuild, readBundledLicence, readInstalledRecord } from '../../src/browser/builds.ts'
import { checkBuilds } from '../../src/cli/install/doctor-rows.ts'
import { archivePath, checkUnpacked, copyBundledLicences, installArchive } from '../../src/cli/install/install-archive.ts'
import { systemUnpackTools } from '../../src/cli/install/unpack.ts'
import { app } from '../../src/config/define.ts'
import { runCommand } from '../../src/native/processes.ts'
import { fileSha256 } from '../../src/browser/builds.ts'
import { tempFolder } from '../support/temp-folder.ts'
import { standInFiles, standInPin, temporaryCache, writeEntries } from './builds-fixtures.ts'
import { loadedConfig } from './cli-fixtures.ts'

test('all nine bundled notices survive a synthetic archive install and are checked from its record, with the source pointers', { skip: process.platform === 'darwin' ? false : "unverified: the stand-in archive is packed and unpacked with macOS's ditto, as the macOS WebKit pin is installed" }, async () => {
  const real = findPin('webkit', 'mac-arm64')
  assert.ok(real?.kind === 'archive' && real.licences.inspected && real.sourceCode !== undefined)
  const notices = real.licences.files.filter(file => file.bundled !== undefined)
  assert.equal(notices.length, 9)
  const source = tempFolder('retest-webkit-notices-source-')
  await writeEntries(source, standInFiles)
  const archive = join(tempFolder('retest-webkit-notices-archive-'), 'stand-in.zip')
  const zipped = await runCommand('/usr/bin/ditto', ['-c', '-k', source, archive], { timeoutMs: 10_000 })
  assert.equal(zipped.code, 0, zipped.stderr)
  const pin = standInPin({ sha256: await fileSha256(archive) }, { engine: 'webkit', licences: { inspected: true, files: notices }, sourceCode: real.sourceCode })
  const { folders } = temporaryCache()
  const kept = archivePath(folders, pin)
  await mkdir(dirname(kept), { recursive: true })
  await writeFile(kept, await readFile(archive))
  let fetches = 0
  const lines: string[] = []
  const installed = await installArchive({ pin, folders, signal: new AbortController().signal, tools: systemUnpackTools, platform: 'darwin', version: '0.0.0-test', report: line => lines.push(line), fetch: async () => { fetches += 1; throw new Error('no download allowed') } })
  assert.ok(installed.ok, installed.ok ? '' : installed.message)
  assert.equal(fetches, 0)
  const reading = await readInstalledRecord(installed.inspection.folder)
  assert.ok(reading.kind === 'found')
  assert.deepEqual(reading.record.sourceCode, real.sourceCode)
  assert.deepEqual(reading.record.licences.map(file => [file.path, file.sha256]), notices.map(file => [file.path, file.sha256]))
  assert.equal((await inspectBuild(pin, folders, { verify: true })).state, 'installed')
  for (const file of notices) {
    const supplied = readBundledLicence(file)
    assert.ok(supplied.ok)
    assert.deepEqual(await readFile(join(installed.inspection.folder, 'build', file.path)), supplied.bytes)
    assert.ok(lines.some(line => line.includes(file.path) && line.includes(file.sha256 ?? 'missing checksum')))
  }
  await rm(join(installed.inspection.folder, 'build/licenses/WebRTC-LICENSE.txt'))
  const damaged = await inspectBuild(pin, folders)
  assert.equal(damaged.state, 'damaged')
  assert.ok(damaged.problems.some(problem => problem.includes('licenses/WebRTC-LICENSE.txt') && problem.includes('missing')))
})

test('a changed bundled checksum or missing notice refuses placement by name, and an archive cannot replace a supplied notice', async () => {
  const real = findPin('webkit', 'mac-arm64')
  assert.ok(real?.kind === 'archive' && real.licences.inspected)
  const notice = real.licences.files.find(file => file.path === 'licenses/ANGLE-LICENSE.txt')
  assert.ok(notice !== undefined)
  for (const changed of [{ ...notice, bundled: 'webkit/missing.txt' }, { ...notice, sha256: '0'.repeat(64) }]) {
    const root = tempFolder('retest-webkit-notice-refused-')
    const reason = await copyBundledLicences({ ...real, licences: { inspected: true, files: [changed] } }, root)
    assert.ok(reason?.startsWith('licenses/ANGLE-LICENSE.txt:'), reason)
  }
  const root = tempFolder('retest-webkit-notice-replacement-')
  await mkdir(join(root, 'licenses'))
  await writeFile(join(root, notice.path), 'an archive supplied different bytes')
  assert.equal(await copyBundledLicences({ ...real, licences: { inspected: true, files: [notice] } }, root), undefined)
  assert.equal(await readFile(join(root, notice.path), 'utf8'), 'an archive supplied different bytes', 'the later checksum check must refuse these bytes, never overwrite them')
  await writeEntries(root, standInFiles)
  const checked = await checkUnpacked(standInPin(undefined, { licences: { inspected: true, files: [notice] } }), root)
  assert.equal(checked.ok, false)
  assert.ok(!checked.ok && checked.message.includes(notice.path) && checked.message.includes('not the pinned'), 'the differing archive notice is refused by name and checksum')
})

test('doctor names all nine WebKit notices, their checksums and source pointers beside the usable install command', async () => {
  const real = findPin('webkit', 'mac-arm64')
  assert.ok(real?.kind === 'archive' && real.licences.inspected)
  const { home } = temporaryCache()
  const config = loadedConfig(tempFolder('retest-webkit-notice-doctor-'), { apps: { web: app({ targets: { webkit: { browser: 'webkit' } } }) } })
  const rows = await checkBuilds(config, { HOME: home }, { platform: 'mac-arm64' })
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row?.ok, false)
  assert.equal(row?.fix, 'Run npx retest install webkit, then give the target its executablePath or set RETEST_WEBKIT_BUILD.')
  for (const file of real.licences.files.filter(file => file.bundled !== undefined)) assert.ok(row?.detail?.includes(file.path) && row.detail.includes(file.sha256 ?? 'missing checksum'))
  assert.ok(row?.detail?.includes(real.sourceCode?.revision ?? 'missing revision'))
  assert.ok(row?.detail?.includes(real.sourceCode?.patches ?? 'missing patches'))
})

test('doctor still reports supplied notices when a WebKit target names a build outside the installer cache', async () => {
  const real = findPin('webkit', 'mac-arm64')
  assert.ok(real?.kind === 'archive' && real.licences.inspected)
  const { home } = temporaryCache()
  const configured = tempFolder('retest-webkit-configured-notice-build-')
  const config = loadedConfig(tempFolder('retest-webkit-configured-notice-doctor-'), { apps: { web: app({ targets: { webkit: { browser: 'webkit', executablePath: configured } } }) } })
  const rows = await checkBuilds(config, { HOME: home }, { platform: 'mac-arm64' })
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row?.ok, true, 'this row verifies the notice pin; the target row checks the configured build')
  assert.match(row?.text ?? '', /supplied licence notices match their pin; the configured build is checked by its target row/)
  assert.ok(!row?.text.includes('installed by Retest'))
  for (const file of real.licences.files.filter(file => file.bundled !== undefined)) assert.ok(row?.detail?.includes(file.path) && row.detail.includes(file.sha256 ?? 'missing checksum'))
  assert.ok(!row?.detail?.includes('No checksum is pinned'))
})
