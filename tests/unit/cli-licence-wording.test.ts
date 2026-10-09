import type { BuildInspection, BuildPin } from '../../src/browser/builds.ts'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { test } from 'node:test'
import { buildFolder, buildPlatform, findPin, pinnedBuilds } from '../../src/browser/builds.ts'
import { installLicenceText, renderInspections } from '../../src/cli/install/report.ts'
import { renderMediaListing } from '../../src/cli/install/media-report.ts'
import { createStyle } from '../../src/reporters/style.ts'
import { tempFolder } from '../support/temp-folder.ts'
import { unpinnedBuilds } from '../support/unpinned-host.ts'
import { temporaryCache } from './builds-fixtures.ts'
import { fakeCli } from './cli-fixtures.ts'

const style = createStyle(false)
const summaries = [
  'BSD and Widevine, notices kept with the build',
  'MPL 2.0, notices kept with the build',
  'LGPL 2.1 and BSD, notices kept with the build',
  'MIT and BSD, notices kept with the build',
  'BSD and Apache 2.0, notices kept with the build',
  'Apache 2.0 and BSD, notices kept with the build',
]

test('install notice wording is exact, with only WebKit naming the notice folder', () => {
  const folders = { browsers: '/cache/browsers', executors: '/cache/executors' }
  const webkit = findPin('webkit', 'mac-arm64')
  assert.ok(webkit !== undefined)
  assert.equal(installLicenceText(webkit, folders), 'WebKit is open source. Its licence notices are kept with the build in /cache/browsers/webkit-26.6-mac-arm64/build/licenses; `retest licences webkit` prints them.')
  const expected = [
    ['electron', 'Electron is open source; its licence notices are kept with the build, and `retest licences electron` prints them.'],
    ['webdriveragent', 'WebDriverAgent is open source; its licence notices are kept with the build, and `retest licences webdriveragent` prints them.'],
    ['mac2', 'The macOS executor is open source; its licence notices are kept with the build, and `retest licences mac2` prints them.'],
  ] as const
  for (const [engine, wording] of expected) {
    const pin = findPin(engine, 'mac-arm64')
    assert.ok(pin !== undefined)
    const text = installLicenceText(pin, folders)
    assert.equal(text, wording)
    assert.doesNotMatch(text, /\/|SHA-256|[a-f0-9]{64}/)
  }
})

test('the install CLI prints its notice message once per named pin and hides detailed notice events', { skip: unpinnedBuilds }, async () => {
  const platform = buildPlatform()
  assert.ok(platform !== undefined)
  const { home, folders } = temporaryCache()
  const pins = pinnedBuilds.filter(pin => pin.platform === platform)
  // Each folder is deliberately damaged before the install, so no archive or source build can start.
  for (const pin of pins) await mkdir(buildFolder(folders, pin), { recursive: true })
  const fake = fakeCli({ cwd: tempFolder('retest-notice-cli-'), env: { HOME: home, NO_COLOR: '1' } })
  assert.equal(await fake.cli(['install', ...pins.flatMap(pin => [pin.engine, pin.engine])]), 2)
  assert.equal(fake.stderr.text, '')
  for (const pin of pins) {
    const message = installLicenceText(pin, folders)
    assert.ok(message !== undefined)
    assert.equal(fake.stdout.text.split(message).length - 1, 1)
  }
  assert.doesNotMatch(fake.stdout.text, /Licence |Source https:|Patches https:|supplied by Retest|[a-f0-9]{64}/)
  assert.equal(fake.runs.length, 0)
})

test('the plain list gives exactly one short licence line per pin, without notice paths or hashes', () => {
  const folders = { browsers: '/cache/browsers', executors: '/cache/executors' }
  const pins = pinnedBuilds.filter(pin => pin.platform === 'mac-arm64')
  const inspections: BuildInspection[] = pins.map(pin => ({ pin, folder: buildFolder(folders, pin), state: 'missing', problems: [] }))
  const text = renderInspections({ platform: 'mac-arm64', folders, inspections, json: false, style })
  assert.deepEqual(text.split('\n').filter(line => line.includes('notices kept')).map(line => line.trim()), summaries)
  assert.doesNotMatch(text, /Licence |SHA-256|[a-f0-9]{64}|licenses\/|WebInspectorUI|Source https:|Patches https:/)
  for (const pin of pins) if (pin.licences.inspected) for (const file of pin.licences.files) assert.ok(!text.includes(file.path))
})

test('the JSON list retains every notice fact and source pointer when media is appended', () => {
  const folders = { browsers: '/cache/browsers', executors: '/cache/executors' }
  const pins = pinnedBuilds.filter(pin => pin.platform === 'mac-arm64')
  const inspections: BuildInspection[] = pins.map(pin => ({ pin, folder: buildFolder(folders, pin), state: 'missing', problems: [] }))
  const text = renderInspections({ platform: 'mac-arm64', folders, inspections, json: true, style })
  const media = { engine: 'media', version: '0.1.0', protocol: 2, target: 'aarch64-apple-darwin', state: 'missing', folder: '/cache/media', executablePath: '/cache/media/retest-media', problems: [] } as const
  const merged = renderMediaListing(text, media, true)
  const document = JSON.parse(merged) as { builds: { engine: string; licences?: BuildPin['licences']; sourceCode?: { repository: string; revision: string; patches: string } }[] }
  assert.equal(document.builds.length, pins.length + 1)
  for (const pin of pins) {
    const build = document.builds.find(build => build.engine === pin.engine)
    assert.deepEqual(build?.licences, pin.licences)
    if (pin.kind === 'archive' && pin.sourceCode !== undefined) assert.deepEqual(build?.sourceCode, pin.sourceCode)
  }
  const malformed = JSON.parse(text) as { builds: { licences: { files: { sha256: string }[] } }[] }
  const first = malformed.builds[0]?.licences.files[0]
  assert.ok(first !== undefined)
  Object.assign(first, { sha256: 42 })
  assert.throws(() => renderMediaListing(JSON.stringify(malformed), media, true), /versioned document/)
})
