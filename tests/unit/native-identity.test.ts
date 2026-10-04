import assert from 'node:assert/strict'
import { test } from 'node:test'
import { folderChecksum } from '../../src/native/executors.ts'
import { appNames, nativeExecutionIdentity, readAppBundle, runtimeIdentity } from '../../src/native/identity.ts'
import { fakeAppBundle, fakeTools } from './native-fake-tools.ts'

test('an app is named by the bundle id, version and build its Info.plist states, and the checksum of its bundle', async (t) => {
  const fake = await fakeTools(t)
  const appPath = await fakeAppBundle(fake.root, { platform: 'ios-simulator', name: 'TaskPhone', bundleId: 'dev.retest.fixtures.taskphone' })
  const read = await readAppBundle(appPath, 'ios-simulator', fake.tools)
  assert.ok(read.ok)
  if (!read.ok) return
  assert.deepEqual(read.bundle, { appPath, bundleId: 'dev.retest.fixtures.taskphone', version: '2.1', build: '42', name: 'TaskPhone', executable: 'TaskPhone', platforms: ['iPhoneSimulator'], sha256: await folderChecksum(appPath) })
  assert.deepEqual(appNames(read.bundle), ['TaskPhone'])
})

test('an app built for another platform is refused, naming what it is built for', async (t) => {
  const fake = await fakeTools(t)
  const appPath = await fakeAppBundle(fake.root, { platform: 'macos', name: 'TaskDesk', bundleId: 'dev.retest.fixtures.taskdesk' })
  const read = await readAppBundle(appPath, 'macos', fake.tools)
  assert.ok(read.ok)
  const wrong = await readAppBundle(appPath, 'ios-simulator', fake.tools)
  assert.equal(!wrong.ok && wrong.failure.class, 'setup_failed')
})

test('a result names the app, the system, the simulator and the executor build of the tested set', async (t) => {
  const fake = await fakeTools(t)
  const appPath = await fakeAppBundle(fake.root, { platform: 'ios-simulator', name: 'TaskPhone', bundleId: 'dev.retest.fixtures.taskphone' })
  const read = await readAppBundle(appPath, 'ios-simulator', fake.tools)
  if (!read.ok) throw new Error(read.failure.message)
  const identity = nativeExecutionIdentity({
    platform: 'ios-simulator',
    bundle: read.bundle,
    os: { name: 'iOS', version: '26.5', build: '23F77' },
    device: { name: 'retest-native-1-00000000', type: 'iPhone 17', udid: 'ABC' },
    build: { schemaVersion: 1, executor: 'webdriveragent', version: '16.13.6', commit: '9d1d17ddb59e6097ddc3324b23ca9f4174507b12', key: 'k', xcode: { version: '26.5', build: '17F42' }, sdk: 'iphonesimulator26.5', architecture: 'arm64', origin: 'built', derivedDataPath: '/d', xctestrun: '/d/x', products: '/d/p', productsSha256: 'p', xctestrunSha256: 'x', codeDirectoryHash: 'cd', recordedAt: '2026-10-03T00:00:00.000Z', licenses: [], notices: [] },
  })
  assert.deepEqual(identity.app, { bundleId: 'dev.retest.fixtures.taskphone', version: '2.1', build: '42', path: appPath, sha256: read.bundle.sha256 })
  assert.deepEqual(identity.executor, { name: 'webdriveragent', version: '16.13.6', commit: '9d1d17ddb59e6097ddc3324b23ca9f4174507b12', commitVerified: true, productsSha256: 'p', codeDirectoryHash: 'cd', origin: 'built' })
  assert.deepEqual(identity.xcode, { version: '26.5', build: '17F42' })
  assert.deepEqual(runtimeIdentity(identity, [7]), { kind: 'ios-simulator', bundleId: 'dev.retest.fixtures.taskphone', appVersion: '2.1', appPath, device: 'iPhone 17', runtime: 'iOS 26.5 (23F77)', processIds: [7] })
})

test('a build taken over is named as one whose commit is not verified', async (t) => {
  const fake = await fakeTools(t)
  const appPath = await fakeAppBundle(fake.root, { platform: 'macos', name: 'TaskDesk', bundleId: 'dev.retest.fixtures.taskdesk' })
  const read = await readAppBundle(appPath, 'macos', fake.tools)
  if (!read.ok) throw new Error(read.failure.message)
  const identity = nativeExecutionIdentity({
    platform: 'macos',
    bundle: read.bundle,
    os: { name: 'macOS', version: '27.0.1', build: '26A434' },
    build: { schemaVersion: 1, executor: 'mac2', version: '4.3.6', commit: 'f38257191fa9f273a684f6a9c8c2b16d1272bd09', key: 'k', xcode: { version: '26.5', build: '17F42' }, sdk: 'macosx26.5', architecture: 'arm64', origin: 'adopted', derivedDataPath: '/d', xctestrun: '/d/x', products: '/d/p', productsSha256: 'p', xctestrunSha256: 'x', recordedAt: '2026-10-03T00:00:00.000Z', licenses: [], notices: [] },
  })
  assert.equal(identity.executor.commitVerified, false)
  assert.equal(identity.executor.origin, 'adopted')
})
