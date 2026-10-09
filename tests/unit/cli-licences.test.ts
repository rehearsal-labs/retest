import assert from 'node:assert/strict'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildFolder, buildPlatform, findPin, pinnedBuilds, readBundledLicence } from '../../src/browser/builds.ts'
import { listLicencePins, readLicenceNotices } from '../../src/cli/commands/licences.ts'
import { tempFolder } from '../support/temp-folder.ts'
import { unpinnedBuilds } from '../support/unpinned-host.ts'
import { installStandIn, standInLicence, standInPin, temporaryCache, writeEntries } from './builds-fixtures.ts'
import { fakeCli } from './cli-fixtures.ts'
import { fileSha256 } from '../../src/browser/builds.ts'
import { runCommand } from '../../src/native/processes.ts'

const signal = (): AbortSignal => new AbortController().signal

test('licences alone lists notice-bearing pins and explains the read command, without reading a cache', async () => {
  const fake = fakeCli({ cwd: tempFolder('retest-licences-list-') })
  assert.equal(await fake.cli(['licences']), 0)
  assert.equal(fake.stderr.text, '')
  assert.equal(fake.stdout.text, listLicencePins(pinnedBuilds))
  assert.match(fake.stdout.text, /^Licence notices are kept with these pinned builds:\n/)
  assert.match(fake.stdout.text, /  webkit \(mac-arm64\)  WebKit \(Playwright build\) 26\.6 \(build 2359\): LGPL 2\.1 and BSD, notices kept with the build\n/)
  assert.match(fake.stdout.text, /Run `retest licences <engine>` to read them\.\n$/)
  assert.doesNotMatch(fake.stdout.text, /SHA-256|[a-f0-9]{64}|licenses\//)
  assert.equal(fake.runs.length, 0)
  assert.equal(fake.loads.length, 0)
})

test('pinned WebKit prints every shipped notice byte and puts source and patches pointers last', async () => {
  const real = findPin('webkit', 'mac-arm64')
  assert.ok(real?.kind === 'archive' && real.licences.inspected && real.sourceCode !== undefined)
  const files = real.licences.files.filter(file => file.bundled !== undefined)
  const pin = { ...real, licences: { inspected: true as const, files } }
  const result = await readLicenceNotices(pin, undefined, signal())
  assert.equal(result.complete, true)
  const expected = [`Licence notices for WebKit (Playwright build) 26.6 (build 2359) (mac-arm64)`, '']
  for (const file of files) {
    assert.ok(file.bundled !== undefined)
    const text = await readFile(new URL(`../../src/cli/install/licences/${file.bundled}`, import.meta.url), 'utf8')
    expected.push(`--- ${file.path} (${file.licence}) ---`, text.replace(/\n?$/, '\n'))
  }
  expected.push(`Source ${real.sourceCode.repository}/tree/${real.sourceCode.revision}`, `Patches ${real.sourceCode.patches}`)
  assert.equal(result.text, `${expected.join('\n')}\n`)
  assert.equal((result.text.match(/^--- /gm) ?? []).length, files.length)
})

test('archive-only notices are named when not installed, while all bundled texts remain readable', async () => {
  const real = findPin('webkit', 'mac-arm64')
  assert.ok(real?.kind === 'archive' && real.licences.inspected)
  const { folders } = temporaryCache()
  const result = await readLicenceNotices(real, folders, signal())
  assert.equal(result.complete, false)
  for (const file of real.licences.files) {
    if (file.bundled === undefined) assert.ok(result.text.includes(`${file.path}: notice text is available only with the installed build.`))
    else {
      const reading = readBundledLicence(file)
      assert.ok(reading.ok)
      assert.ok(result.text.includes(reading.bytes.toString('utf8')))
    }
  }
  assert.match(result.text, /Run `retest install webkit` to install the pinned build\.\n\nSource https:.*\nPatches https:.*\n$/)
})

test('a changed or absent bundled notice is named and its unchecked text is never printed', async () => {
  const real = findPin('webkit', 'mac-arm64')
  assert.ok(real?.kind === 'archive' && real.licences.inspected)
  const notice = real.licences.files.find(file => file.bundled !== undefined)
  assert.ok(notice !== undefined)
  for (const changed of [{ ...notice, sha256: '0'.repeat(64) }, { ...notice, bundled: 'webkit/absent.txt' }]) {
    const result = await readLicenceNotices({ ...real, licences: { inspected: true, files: [changed] } }, undefined, signal())
    assert.equal(result.complete, false)
    assert.ok(result.text.includes(notice.path))
    assert.doesNotMatch(result.text, /^--- /m)
  }
})

test('an installed notice prints its exact text, and a missing or changed installed notice refuses reading', async () => {
  const { folders } = temporaryCache()
  const pin = standInPin({ sha256: 'a'.repeat(64) })
  const { folder } = await installStandIn(folders, pin, { size: 7, sha256: 'a'.repeat(64) })
  const result = await readLicenceNotices(pin, folders, signal())
  assert.deepEqual(result, { complete: true, text: `Licence notices for Stand-in 1.0.0 (mac-arm64)\n\n--- LICENSE (MIT) ---\n${standInLicence}\nSource https://example.invalid/releases/stand-in-1.0.0.zip\n` })
  await writeFile(join(folder, 'build/LICENSE'), 'different notice text')
  const changed = await readLicenceNotices(pin, folders, signal())
  assert.equal(changed.complete, false)
  assert.match(changed.text, /LICENSE.*SHA-256/)
  assert.ok(!changed.text.includes('different notice text'))
  await rm(join(folder, 'build/LICENSE'))
  const missing = await readLicenceNotices(pin, folders, signal())
  assert.equal(missing.complete, false)
  assert.match(missing.text, /LICENSE is missing\./)
})

test('an installed build never masks a missing notice with a bundled copy', async () => {
  const { folders } = temporaryCache()
  const real = findPin('webkit', 'mac-arm64')
  assert.ok(real?.licences.inspected)
  const notice = real.licences.files.find(file => file.bundled !== undefined)
  assert.ok(notice !== undefined)
  const supplied = readBundledLicence(notice)
  assert.ok(supplied.ok)
  const pin = standInPin({ sha256: 'b'.repeat(64) }, { licences: { inspected: true, files: [notice] } })
  await writeEntries(join(buildFolder(folders, pin), 'build'), { [notice.path]: supplied.bytes.toString('utf8') })
  const { folder } = await installStandIn(folders, pin, { size: 7, sha256: 'b'.repeat(64) })
  assert.equal((await readLicenceNotices(pin, folders, signal())).complete, true)
  await rm(join(folder, 'build', notice.path))
  const missing = await readLicenceNotices(pin, folders, signal())
  assert.equal(missing.complete, false)
  assert.ok(missing.text.includes(notice.path))
  assert.ok(!missing.text.includes(supplied.bytes.toString('utf8')))
})

test('a notice symlink refuses reading instead of following it', async () => {
  const { folders } = temporaryCache()
  const pin = standInPin({ sha256: 'c'.repeat(64) })
  const { folder } = await installStandIn(folders, pin, { size: 7, sha256: 'c'.repeat(64) })
  const outside = join(tempFolder('retest-notice-outside-'), 'secret.txt')
  await writeFile(outside, 'outside contents must not be printed')
  await rm(join(folder, 'build/LICENSE'))
  await symlink(outside, join(folder, 'build/LICENSE'))
  const result = await readLicenceNotices(pin, folders, signal())
  assert.equal(result.complete, false)
  assert.match(result.text, /LICENSE.*link/)
  assert.ok(!result.text.includes('outside contents must not be printed'))
})

test('the Firefox notice archive prints the complete licence page rather than ZIP bytes', { skip: process.platform === 'darwin' ? false : "unverified: the stand-in archive is packed with macOS's ditto, and Retest pins Firefox for macOS arm64 only" }, async () => {
  const { folders } = temporaryCache()
  const source = tempFolder('retest-licence-zip-source-')
  const page = '<html><body>Complete licence text for the stand-in Firefox.</body></html>\n'
  await writeEntries(source, { 'chrome/toolkit/content/global/license.html': page })
  const archive = join(tempFolder('retest-licence-zip-'), 'omni.ja')
  const zipped = await runCommand('/usr/bin/ditto', ['-c', '-k', source, archive], { timeoutMs: 10_000 })
  assert.equal(zipped.code, 0, zipped.stderr)
  const path = 'Firefox.app/Contents/Resources/omni.ja'
  const pin = standInPin({ sha256: 'e'.repeat(64) }, { engine: 'firefox', title: 'Firefox', licences: { inspected: true, files: [{ path, title: 'the licence page in the archive', licence: 'MPL-2.0', published: true, sha256: await fileSha256(archive) }] } })
  const root = join(buildFolder(folders, pin), 'build')
  await mkdir(join(root, 'Firefox.app/Contents/Resources'), { recursive: true })
  await writeFile(join(root, path), await readFile(archive))
  await installStandIn(folders, pin, { size: 7, sha256: 'e'.repeat(64) })
  const result = await readLicenceNotices(pin, folders, signal())
  assert.equal(result.complete, true, result.text)
  assert.equal(result.text, `Licence notices for Firefox 1.0.0 (mac-arm64)\n\n--- ${path} (MPL-2.0) ---\n${page}\nSource https://example.invalid/releases/stand-in-1.0.0.zip\n`)
})

test('licences help and usage errors describe only the implemented command', async () => {
  for (const args of [['help', 'licences'], ['licences', '--help']]) {
    const fake = fakeCli({ cwd: tempFolder('retest-licences-help-') })
    assert.equal(await fake.cli(args), 0)
    assert.match(fake.stdout.text, /^Usage\n  retest licences \[engine\]\n/)
    assert.match(fake.stdout.text, /Nothing is downloaded\./)
    assert.doesNotMatch(fake.stdout.text, /--json|--install/)
  }
  for (const [args, message] of [
    [['licences', 'webkit', 'electron'], 'licences takes one engine at most.'],
    [['licences', 'webkt'], 'Unknown engine webkt. Did you mean webkit?'],
    [['licences', '--json'], 'Unknown option --json.'],
  ] as const) {
    const fake = fakeCli({ cwd: tempFolder('retest-licences-usage-') })
    assert.equal(await fake.cli(args), 2)
    assert.equal(fake.stdout.text, '')
    assert.equal(fake.stderr.text, `error: ${message}\nSee retest help licences.\n`)
  }
})

test('the licences CLI uses the caller cache and never starts a run', { skip: unpinnedBuilds }, async () => {
  const platform = buildPlatform()
  assert.ok(platform !== undefined)
  const { home, folders } = temporaryCache()
  const pin = findPin('chromium', platform)
  assert.ok(pin !== undefined)
  await mkdir(buildFolder(folders, pin), { recursive: true })
  const fake = fakeCli({ cwd: tempFolder('retest-licences-cache-'), env: { HOME: home } })
  assert.equal(await fake.cli(['licences', 'chromium']), 2)
  assert.ok(fake.stdout.text.includes(buildFolder(folders, pin)))
  assert.match(fake.stdout.text, /holds no build\.json/)
  assert.doesNotMatch(fake.stdout.text, /^--- /m)
  assert.equal(fake.runs.length, 0)
  assert.equal(fake.loads.length, 0)
})

test('licences returns interrupted before reading or printing when already cancelled', async () => {
  const controller = new AbortController()
  controller.abort()
  for (const args of [['licences'], ['licences', 'webkit']]) {
    const fake = fakeCli({ cwd: tempFolder('retest-licences-cancelled-'), signal: controller.signal })
    assert.equal(await fake.cli(args), 130)
    assert.equal(fake.stdout.text, '')
    assert.equal(fake.stderr.text, '')
    assert.equal(fake.runs.length, 0)
  }
})
