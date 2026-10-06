import type { NativePoolRuntime } from '../../src/runner/native-pool.ts'
import assert from 'node:assert/strict'
import { mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { systemTools } from '../../src/native/processes.ts'
import { NativeBrowserAdapter } from '../../src/runner/native-pool.ts'
import { sha256Hex } from '../../src/shared/sha256.ts'

/** Real kernel exclusion with no app or executor launch, including distinct run temporary directories. */
export async function assertNativeNetworkLockLocation(root: string): Promise<void> {
  const home = join(root, 'home'), firstTmp = join(root, 'first-tmp'), secondTmp = join(root, 'second-tmp')
  await Promise.all([home, firstTmp, secondTmp].map(folder => mkdir(folder, { recursive: true })))
  const network = join(root, 'network.jsonl')
  await writeFile(network, '')
  const previousHome = process.env['HOME'], previousTmp = process.env['TMPDIR']
  const marker = 'fixture refuses before any app opens'
  const runtime: NativePoolRuntime = {
    identity: { kind: 'macos', bundleId: 'dev.retest.networkfixture', appPath: '/fixture/Network.app', processIds: [] },
    execution: { platform: 'macos', app: { bundleId: 'dev.retest.networkfixture', path: '/fixture/Network.app', sha256: 'a'.repeat(64) }, os: { name: 'macOS', version: 'fixture', build: 'fixture' }, executor: { name: 'fixture', version: 'fixture', commit: 'b'.repeat(40), commitVerified: false, productsSha256: 'c'.repeat(64), origin: 'adopted' }, xcode: { version: 'fixture', build: 'fixture' } },
    bundle: { appPath: '/fixture/Network.app', bundleId: 'dev.retest.networkfixture', executable: 'Network', platforms: ['MacOSX'], sha256: 'a'.repeat(64) },
    port: 0, connected: true, onDisconnect: () => () => undefined, close: async () => undefined,
    openSession: async () => { throw new Error(marker) },
  }
  const browsers: NativeBrowserAdapter[] = []
  const browser = (client: 'ios' | 'macos' = 'macos'): NativeBrowserAdapter => {
    const owner = { runId: 'network-fixture', testId: 'network-lock', attemptId: `lock-${browsers.length}`, app: 'desk' }
    const made = new NativeBrowserAdapter({ runtime, close: async () => undefined,
      target: { name: 'desk', platform: 'macos', appPath: runtime.bundle.appPath, diagnostics: { logs: 'none', network: { path: network, client } } },
      owner, options: { owner, launch: { arguments: [], environment: {} }, redact: text => text }, tools: systemTools, signal: new AbortController().signal, cleanupMs: 5000,
      interact: async () => { throw new Error(marker) }, launchWithLogs: async () => { throw new Error(marker) },
    })
    browsers.push(made)
    return made
  }
  try {
    process.env['HOME'] = home
    process.env['TMPDIR'] = firstTmp
    const first = browser()
    await assert.rejects(first.prepare(5000), { message: marker })
    await assert.rejects(browser().prepare(5000), /Another run reads the network file/)
    const separateClient = browser('ios')
    await assert.rejects(separateClient.prepare(5000), { message: marker }, 'distinct declared clients can read their own records from the same file')
    await separateClient.close(5000)
    process.env['TMPDIR'] = secondTmp
    await assert.rejects(browser().prepare(5000), /Another run reads the network file/, 'a different run temporary directory cannot bypass exclusion')
    assert.deepEqual(await readdir(firstTmp), [], 'kernel lock files are outside the first run temporary directory')
    assert.deepEqual(await readdir(secondTmp), [], 'kernel lock files are outside the second run temporary directory')
    const lock = join(home, 'Library', 'Caches', 'retest', 'network-locks', `${sha256Hex(JSON.stringify([await realpath(network), 'macos']))}.lock`)
    const held = await stat(lock)
    await first.close(5000)
    assert.equal((await stat(lock)).ino, held.ino, 'release preserves the inode that another waiter may have opened')
    const next = browser()
    await assert.rejects(next.prepare(5000), { message: marker }, 'another reader acquires the same file after confirmed release')
    assert.equal((await stat(lock)).ino, held.ino)
    await next.close(5000)
  } finally {
    try { for (const made of browsers) await made.close(5000) } finally {
      if (previousHome === undefined) delete process.env['HOME']; else process.env['HOME'] = previousHome
      if (previousTmp === undefined) delete process.env['TMPDIR']; else process.env['TMPDIR'] = previousTmp
    }
  }
}
