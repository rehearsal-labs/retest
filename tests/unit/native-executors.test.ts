import type { TestContext } from 'node:test'
import type { NativePinSet, PinnedLicense } from '../../src/native/executors.ts'
import type { FakeTools } from './native-fake-tools.ts'
import assert from 'node:assert/strict'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { ensureExecutorBuild, facebookBsdHeader, folderChecksum, nativePins, pinKey } from '../../src/native/executors.ts'
import { sha256Hex } from '../../src/shared/sha256.ts'
import { fakeCheckout, fakeTools } from './native-fake-tools.ts'

const bsdText = 'Fake BSD licence text\n'
const apacheText = 'Fake Apache licence text\n'

// The real pins with licence checksums of the fake texts, so the fake checkouts pass the licence check.
const fakeBsd: PinnedLicense = { from: 'webdriveragent', path: 'LICENSE', copiedAs: 'WebDriverAgent-LICENSE.txt', spdx: 'BSD-3-Clause', sha256: sha256Hex(bsdText) }
const fakeApache: PinnedLicense = { from: 'mac2', path: 'LICENSE', copiedAs: 'Apache-2.0-LICENSE.txt', spdx: 'Apache-2.0', sha256: sha256Hex(apacheText) }
const testPins: NativePinSet = {
  toolchain: nativePins.toolchain,
  executors: {
    webdriveragent: { ...nativePins.executors.webdriveragent, licenses: [fakeBsd, fakeApache] },
    mac2: { ...nativePins.executors.mac2, licenses: [{ ...fakeApache, copiedAs: 'appium-mac2-driver-LICENSE.txt' }, fakeBsd] },
  },
}
const statusCodesHeader = '/*\n * Copyright (C) 2013 Neo Visionaries Inc.\n *\n * Licensed under the Apache License, Version 2.0 (the "License");\n */\n\n#ifndef FBHTTPStatusCodes_h\n'

async function sources(fake: FakeTools, heads: { readonly webdriveragent?: string; readonly mac2?: string } = {}): Promise<{ readonly webdriveragent: string; readonly mac2: string }> {
  const webdriveragent = await fakeCheckout(fake.root, { name: 'WebDriverAgent', head: heads.webdriveragent ?? nativePins.executors.webdriveragent.commit, licenses: { LICENSE: bsdText, 'WebDriverAgentLib/Routing/FBHTTPStatusCodes.h': statusCodesHeader } })
  const mac2 = await fakeCheckout(fake.root, { name: 'appium-mac2-driver', head: heads.mac2 ?? nativePins.executors.mac2.commit, licenses: { LICENSE: apacheText, 'WebDriverAgentMac/WebDriverAgentLib/Routing/FBHTTPStatusCodes.h': statusCodesHeader } })
  await mkdir(join(mac2, 'WebDriverAgentMac', 'WebDriverAgentLib'), { recursive: true })
  await writeFile(join(mac2, 'WebDriverAgentMac', 'WebDriverAgentLib', 'FBLogger.h'), `/**\n * ${facebookBsdHeader.split('\n').join('\n * ')}\n */\n`)
  await writeFile(join(mac2, 'WebDriverAgentMac', 'WebDriverAgentLib', 'AMOwn.h'), '// Apache-2.0\n')
  return { webdriveragent, mac2 }
}

function ensure(fake: FakeTools, options: { readonly executor: 'webdriveragent' | 'mac2'; readonly sources: { readonly webdriveragent: string; readonly mac2: string }; readonly adoptFrom?: readonly string[] }): ReturnType<typeof ensureExecutorBuild> {
  return ensureExecutorBuild({ ...options, pins: testPins, cacheRoot: join(fake.root, 'cache'), logFile: join(fake.root, 'build.log'), timeoutMs: 30_000, tools: fake.tools, architecture: 'arm64' })
}

async function builds(fake: FakeTools): Promise<number> {
  return (await fake.calls()).filter((call) => call.tool === 'xcodebuild' && call.args[0] === 'build-for-testing').length
}

async function setUp(t: TestContext, tools: Record<string, unknown> = {}): Promise<FakeTools> {
  const fake = await fakeTools(t)
  await fake.configure(tools)
  return fake
}

test('the pin is the tested set the Phase 1 record names', () => {
  assert.deepEqual(nativePins.toolchain.xcode, { version: '26.5', build: '17F42' })
  assert.deepEqual(nativePins.toolchain.iosRuntimes, [{ version: '26.5', build: '23F77' }])
  assert.equal(nativePins.executors.webdriveragent.commit, '9d1d17ddb59e6097ddc3324b23ca9f4174507b12')
  assert.equal(nativePins.executors.mac2.commit, 'f38257191fa9f273a684f6a9c8c2b16d1272bd09')
  assert.equal(nativePins.executors.webdriveragent.licenses[0]?.sha256, 'd9910c6ba5e4c29ae415ee3ce875c9e18a60d8bc4d7fe2c2d104db2a718b1bb4')
  assert.equal(nativePins.executors.mac2.licenses[0]?.sha256, 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4')
})

test('a build key changes with anything that changes the build and with nothing else', () => {
  const pin = nativePins.executors.mac2
  const key = pinKey(pin, nativePins.toolchain, 'arm64')
  assert.match(key, /^[0-9a-f]{16}$/)
  assert.equal(pinKey(pin, nativePins.toolchain, 'arm64'), key)
  assert.notEqual(pinKey(pin, { ...nativePins.toolchain, xcode: { version: '26.5', build: '17F43' } }, 'arm64'), key)
  assert.notEqual(pinKey({ ...pin, commit: '0'.repeat(40) }, nativePins.toolchain, 'arm64'), key)
  assert.notEqual(pinKey(pin, nativePins.toolchain, 'x86_64'), key)
})

test('a build runs once into a folder keyed by the pin, records its checksums and licences, and is reused after', async (t) => {
  const fake = await setUp(t)
  const source = await sources(fake)
  const first = await ensure(fake, { executor: 'webdriveragent', sources: source })
  assert.ok(first.ok, first.ok ? '' : first.failure.message)
  if (!first.ok) return
  assert.equal(first.action, 'built')
  assert.match(first.folder, new RegExp(`webdriveragent-16\\.13\\.6-${pinKey(testPins.executors.webdriveragent, testPins.toolchain, 'arm64')}$`))
  assert.equal(first.build.productsSha256, await folderChecksum(first.build.products))
  assert.equal(first.build.codeDirectoryHash !== undefined, true)
  assert.equal(await readFile(join(first.folder, 'licenses', 'WebDriverAgent-LICENSE.txt'), 'utf8'), bsdText)
  assert.equal(await readFile(join(first.folder, 'licenses', 'Apache-2.0-LICENSE.txt'), 'utf8'), apacheText)
  assert.match(await readFile(join(first.folder, 'licenses', 'FBHTTPStatusCodes-NOTICE.txt'), 'utf8'), /Neo Visionaries Inc\.[\s\S]*Apache License, Version 2\.0/)
  assert.deepEqual(first.build.notices.map((notice) => notice.path.split('/').at(-1)), ['FBHTTPStatusCodes-NOTICE.txt'])
  const second = await ensure(fake, { executor: 'webdriveragent', sources: source })
  assert.equal(second.ok && second.action, 'reused')
  assert.equal(await builds(fake), 1, 'the second call built nothing')
})

test('the macOS runner carries its own licence, WebDriverAgent\'s and the BSD notice its borrowed files keep', async (t) => {
  const fake = await setUp(t)
  const built = await ensure(fake, { executor: 'mac2', sources: await sources(fake) })
  assert.ok(built.ok, built.ok ? '' : built.failure.message)
  if (!built.ok) return
  assert.deepEqual(built.build.licenses.map((license) => license.spdx), ['Apache-2.0', 'BSD-3-Clause'])
  assert.equal(built.build.notices[0]?.files, 1)
  assert.equal(built.build.notices[1]?.path.endsWith('FBHTTPStatusCodes-NOTICE.txt'), true)
  const notice = await readFile(built.build.notices[0]?.path ?? '', 'utf8')
  assert.match(notice, /Copyright \(c\) 2015-present, Facebook, Inc\./)
  assert.match(notice, /WebDriverAgentMac\/WebDriverAgentLib\/FBLogger\.h/)
  assert.doesNotMatch(notice, /AMOwn/)
})

test('a built macOS runner that changed is refused, never built again', async (t) => {
  const fake = await setUp(t)
  const source = await sources(fake)
  const built = await ensure(fake, { executor: 'mac2', sources: source })
  if (!built.ok) throw new Error(built.failure.message)
  await writeFile(join(built.build.products, 'WebDriverAgentRunner-Runner.app', 'runner'), 'changed')
  const again = await ensure(fake, { executor: 'mac2', sources: source })
  assert.match(!again.ok ? again.failure.message : '', /have checksum .*, not the recorded/)
  assert.equal(await builds(fake), 1)
})

test('an earlier build the pinned Xcode made is taken over in place', async (t) => {
  const fake = await setUp(t)
  const source = await sources(fake)
  const earlier = join(fake.root, 'earlier-derived')
  // An earlier build into a folder of its own, as Phase 1 made, from the same pinned checkout.
  const made = await ensureExecutorBuild({ executor: 'mac2', sources: source, pins: testPins, cacheRoot: join(fake.root, 'other-cache'), logFile: join(fake.root, 'build.log'), timeoutMs: 30_000, tools: fake.tools, architecture: 'arm64' })
  if (!made.ok) throw new Error(made.failure.message)
  await cp(made.build.derivedDataPath, earlier, { recursive: true })
  const adopted = await ensure(fake, { executor: 'mac2', sources: source, adoptFrom: [join(fake.root, 'missing'), earlier] })
  assert.ok(adopted.ok)
  if (!adopted.ok) return
  assert.equal(adopted.action, 'adopted')
  assert.equal(adopted.build.origin, 'adopted')
  assert.equal(adopted.build.derivedDataPath, earlier)
  assert.equal(adopted.build.productsSha256, made.build.productsSha256)
  assert.equal(await builds(fake), 1, 'only the earlier build ran xcodebuild')
})

test('an earlier build another Xcode made is not taken over', async (t) => {
  const fake = await setUp(t, { xcodeBuild: '17F41' })
  const source = await sources(fake)
  const earlier = join(fake.root, 'earlier-derived')
  await ensureExecutorBuild({ executor: 'mac2', sources: source, pins: { ...testPins, toolchain: { ...testPins.toolchain, xcode: { version: '26.5', build: '17F41' } } }, cacheRoot: join(fake.root, 'other'), logFile: join(fake.root, 'build.log'), timeoutMs: 30_000, tools: fake.tools, architecture: 'arm64' }).then(async (made) => {
    if (!made.ok) throw new Error(made.failure.message)
    await cp(made.build.derivedDataPath, earlier, { recursive: true })
  })
  await fake.configure({})
  const result = await ensure(fake, { executor: 'mac2', sources: source, adoptFrom: [earlier] })
  assert.equal(result.ok && result.action, 'built')
})

for (const [name, tools, heads, message] of [
  ['an Xcode other than the pinned build', { xcodeBuild: '17F43' }, {}, /pinned to Xcode 26\.5 \(17F42\)/],
  ['a source at another commit', {}, { webdriveragent: '1'.repeat(40) }, /not the pinned 9d1d17dd/],
  ['a source with changed files', { dirtySource: true }, {}, /changes to tracked files/],
  ['a source with files the pinned commit does not hold', { untrackedSource: true }, {}, /holds 1 file\(s\) the pinned commit does not/],
] as const) {
  test(`${name} is refused before anything is built`, async (t) => {
    const fake = await setUp(t, tools)
    const result = await ensure(fake, { executor: 'webdriveragent', sources: await sources(fake, heads) })
    assert.equal(!result.ok && result.failure.class, 'setup_failed')
    assert.match(!result.ok ? result.failure.message : '', message)
    assert.equal(await builds(fake), 0)
  })
}

test('a licence that is not the pinned text is refused', async (t) => {
  const fake = await setUp(t)
  const source = await sources(fake)
  await writeFile(join(source.webdriveragent, 'LICENSE'), 'another licence\n')
  const result = await ensure(fake, { executor: 'webdriveragent', sources: source })
  assert.match(!result.ok ? result.failure.message : '', /not the pinned/)
})

test('a build another live process holds is refused; a lock its dead holder left is taken over', async (t) => {
  const fake = await setUp(t)
  const source = await sources(fake)
  const folder = join(fake.root, 'cache', `webdriveragent-16.13.6-${pinKey(testPins.executors.webdriveragent, testPins.toolchain, 'arm64')}`)
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'build.lock'), String(process.ppid))
  const held = await ensure(fake, { executor: 'webdriveragent', sources: source })
  assert.match(!held.ok ? held.failure.message : '', new RegExp(`pid ${process.ppid}`))
  await writeFile(join(folder, 'build.lock'), '999999')
  const taken = await ensure(fake, { executor: 'webdriveragent', sources: source })
  assert.equal(taken.ok && taken.action, 'built')
})

test('a user scheme of the runner\'s name in the checkout is refused, even where git ignores it', async (t) => {
  const fake = await setUp(t)
  const source = await sources(fake)
  const schemes = join(source.mac2, 'WebDriverAgentMac', 'WebDriverAgentMac.xcodeproj', 'xcuserdata', 'someone.xcuserdatad', 'xcschemes')
  await mkdir(schemes, { recursive: true })
  await writeFile(join(schemes, 'WebDriverAgentRunner.xcscheme'), '<Scheme/>')
  const result = await ensure(fake, { executor: 'mac2', sources: source })
  assert.match(!result.ok ? result.failure.message : '', /user scheme .*WebDriverAgentRunner\.xcscheme that would replace the pinned WebDriverAgentRunner scheme/)
  assert.equal(await builds(fake), 0)
})

test('a missing checkout names the repository and the commit to clone', async (t) => {
  const fake = await setUp(t)
  const result = await ensure(fake, { executor: 'webdriveragent', sources: { webdriveragent: join(fake.root, 'absent'), mac2: join(fake.root, 'absent-too') } })
  assert.match(!result.ok ? result.failure.message : '', /git clone https:\/\/github\.com\/appium\/WebDriverAgent .*absent && git -C .*absent checkout 9d1d17ddb59e6097ddc3324b23ca9f4174507b12/)
})

test('a build recorded before the pin named all its licence files gets them, products untouched', async (t) => {
  const fake = await setUp(t)
  const source = await sources(fake)
  const first = await ensure(fake, { executor: 'webdriveragent', sources: source })
  if (!first.ok) throw new Error(first.failure.message)
  const record = join(first.folder, 'build.json')
  const older = { ...first.build, licenses: first.build.licenses.slice(0, 1), notices: [] }
  await writeFile(record, JSON.stringify(older))
  const again = await ensure(fake, { executor: 'webdriveragent', sources: source })
  assert.ok(again.ok)
  if (!again.ok) return
  assert.equal(again.action, 'reused')
  assert.equal(again.build.productsSha256, first.build.productsSha256)
  assert.deepEqual(again.build.notices.map((notice) => notice.path.split('/').at(-1)), ['FBHTTPStatusCodes-NOTICE.txt'])
  assert.equal(again.build.licenses.length, 2)
  assert.equal(await builds(fake), 1)
})
