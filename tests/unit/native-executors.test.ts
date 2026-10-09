import type { TestContext } from 'node:test'
import type { ExecutorBuild, NativePinSet, PinnedLicense } from '../../src/native/executors.ts'
import type { FakeTools } from './native-fake-tools.ts'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { ensureExecutorBuild, facebookBsdHeader, folderChecksum, nativePins, pinKey, readBuildRecord } from '../../src/native/executors.ts'
import { sha256Hex } from '../../src/shared/sha256.ts'
import { tempFolder } from '../support/temp-folder.ts'
import { fakeCheckout, fakeTools } from './native-fake-tools.ts'

// The build lock stands on the kernel lock `lockf` takes, which only macOS and the BSDs ship at /usr/bin/lockf. Every
// case that reaches a build takes it.
const darwinOnly = { skip: process.platform === 'darwin' ? false : 'the build lock runs only on macOS' }

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

test('a build runs once into a folder keyed by the pin, records its checksums and licences, and is reused after', darwinOnly, async (t) => {
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

test('the macOS runner carries its own licence, WebDriverAgent\'s and the BSD notice its borrowed files keep', darwinOnly, async (t) => {
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

test('a built macOS runner that changed is refused, never built again', darwinOnly, async (t) => {
  const fake = await setUp(t)
  const source = await sources(fake)
  const built = await ensure(fake, { executor: 'mac2', sources: source })
  if (!built.ok) throw new Error(built.failure.message)
  await writeFile(join(built.build.products, 'WebDriverAgentRunner-Runner.app', 'runner'), 'changed')
  const again = await ensure(fake, { executor: 'mac2', sources: source })
  assert.match(!again.ok ? again.failure.message : '', /have checksum .*, not the recorded/)
  assert.equal(await builds(fake), 1)
})

test('an earlier build the pinned Xcode made is taken over in place', darwinOnly, async (t) => {
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

test('an earlier build another Xcode made is not taken over', darwinOnly, async (t) => {
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

// A process of the test's own that holds the kernel lock on a file while it reads a pipe from the test, as Retest's own
// holder does; closing the pipe ends it and lets the lock go, and nothing of it outlives the test.
async function lockHolder(t: TestContext, path: string): Promise<{ end(): Promise<void> }> {
  const holder = spawn('/usr/bin/lockf', ['-k', '-s', '-t', '0', path, '/bin/sh', '-c', 'echo locked; exec /bin/cat > /dev/null'], { stdio: ['pipe', 'pipe', 'ignore'] })
  const exited = new Promise<void>((resolve) => holder.once('exit', () => resolve()))
  const end = async (): Promise<void> => {
    holder.stdin.destroy()
    await exited
  }
  t.after(end)
  await new Promise<void>((resolve, reject) => {
    holder.stdout.once('data', () => {
      holder.stdout.destroy()
      resolve()
    })
    holder.once('exit', (code) => reject(new Error(`lockf exited with ${code ?? 'a signal'} before holding the lock`)))
  })
  return { end }
}

test('a build another live process holds is refused; a lock its dead holder left is taken over', darwinOnly, async (t) => {
  const fake = await setUp(t)
  const source = await sources(fake)
  const folder = join(fake.root, 'cache', `webdriveragent-16.13.6-${pinKey(testPins.executors.webdriveragent, testPins.toolchain, 'arm64')}`)
  await mkdir(folder, { recursive: true })
  const holder = await lockHolder(t, join(folder, 'build.lock'))
  const held = await ensure(fake, { executor: 'webdriveragent', sources: source })
  assert.match(!held.ok ? held.failure.message : '', /Another process holds the build lock .*build\.lock: it is building this executor/)
  assert.equal(await builds(fake), 0, 'nothing was built while the lock was held')
  // The holder dies; what it left in the file is of no account, as the kernel let its lock go.
  await holder.end()
  await writeFile(join(folder, 'build.lock'), '999999')
  const taken = await ensure(fake, { executor: 'webdriveragent', sources: source })
  assert.equal(taken.ok && taken.action, 'built')
})

test('a build lock whose file is still empty, as a holder leaves it before writing anything, is never taken over', darwinOnly, async (t) => {
  const fake = await setUp(t)
  const source = await sources(fake)
  const folder = join(fake.root, 'cache', `webdriveragent-16.13.6-${pinKey(testPins.executors.webdriveragent, testPins.toolchain, 'arm64')}`)
  await mkdir(folder, { recursive: true })
  await lockHolder(t, join(folder, 'build.lock'))
  assert.equal(await readFile(join(folder, 'build.lock'), 'utf8'), '')
  const held = await ensure(fake, { executor: 'webdriveragent', sources: source })
  assert.equal(held.ok, false)
  assert.equal(await builds(fake), 0)
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

test('a build recorded before the pin named all its licence files gets them, products untouched', darwinOnly, async (t) => {
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

// A record anything could have put a link or a FIFO in place of: read only as a regular file of a record's size, so
// neither a run nor doctor can hang on it or take another file for it.
test('the build record is read only as a regular file: a link is never followed, a FIFO never waited on', { timeout: 15_000 }, async () => {
  const folder = tempFolder('retest-executor-record-')
  const record: ExecutorBuild = {
    schemaVersion: 1,
    executor: 'webdriveragent',
    version: nativePins.executors.webdriveragent.version,
    commit: nativePins.executors.webdriveragent.commit,
    key: 'key',
    xcode: nativePins.toolchain.xcode,
    sdk: 'iphonesimulator26.5',
    architecture: 'arm64',
    origin: 'built',
    derivedDataPath: join(folder, 'derived'),
    xctestrun: join(folder, 'runner.xctestrun'),
    products: join(folder, 'products'),
    productsSha256: sha256Hex('products'),
    xctestrunSha256: sha256Hex('xctestrun'),
    recordedAt: '2026-10-05T00:00:00.000Z',
    licenses: [],
    notices: [],
  }
  await writeFile(join(folder, 'build.json'), JSON.stringify(record))
  assert.deepEqual(await readBuildRecord(folder), { kind: 'found', build: record })
  // The link leads to the same record, word for word, so only following it could find a build.
  const elsewhere = join(tempFolder('retest-executor-record-'), 'build.json')
  await rename(join(folder, 'build.json'), elsewhere)
  await symlink(elsewhere, join(folder, 'build.json'))
  assert.deepEqual(await readBuildRecord(folder), { kind: 'unreadable', problem: 'it is a link, not a file' })
  await rm(join(folder, 'build.json'))
  await writeFile(join(folder, 'build.json'), `${JSON.stringify(record)}${' '.repeat(1024 * 1024)}`)
  assert.match(JSON.stringify(await readBuildRecord(folder)), /it is \d+ bytes, more than the 1048576 a record Retest writes may take/)
  await rm(join(folder, 'build.json'))
  assert.equal(spawnSync('/usr/bin/mkfifo', [join(folder, 'build.json')]).status, 0)
  assert.deepEqual(await readBuildRecord(folder), { kind: 'unreadable', problem: 'it is a FIFO, not a file' })
})

test('a run reusing a build is refused by name, never held or misled, by a link or a FIFO at its record or test run file', darwinOnly, async (t) => {
  const fake = await setUp(t)
  const source = await sources(fake)
  const first = await ensure(fake, { executor: 'webdriveragent', sources: source })
  if (!first.ok) throw new Error(first.failure.message)
  const record = join(first.folder, 'build.json')
  const kept = join(fake.root, 'kept-build.json')
  await rename(record, kept)
  await symlink(kept, record)
  const linked = await ensure(fake, { executor: 'webdriveragent', sources: source })
  assert.equal(linked.ok ? linked.action : linked.failure.message, `The executor build record ${record} cannot be read: it is a link, not a file. Remove ${first.folder} to build again.`)
  await rm(record)
  assert.equal(spawnSync('/usr/bin/mkfifo', [record]).status, 0)
  const piped = await ensure(fake, { executor: 'webdriveragent', sources: source })
  assert.equal(piped.ok ? piped.action : piped.failure.message, `The executor build record ${record} cannot be read: it is a FIFO, not a file. Remove ${first.folder} to build again.`)
  await rm(record)
  await rename(kept, record)
  await rm(first.build.xctestrun)
  assert.equal(spawnSync('/usr/bin/mkfifo', [first.build.xctestrun]).status, 0)
  const runFile = await ensure(fake, { executor: 'webdriveragent', sources: source })
  assert.match(runFile.ok ? runFile.action : runFile.failure.message, new RegExp(`^The recorded WebDriverAgent test run file cannot be read: ${first.build.xctestrun.replaceAll('.', '\\.')} is a FIFO, not a file\\. Remove `))
  assert.equal(await builds(fake), 1, 'nothing was built again')
})
