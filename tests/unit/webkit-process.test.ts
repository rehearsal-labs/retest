import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { closeGraceMs } from '../../src/browser/contract.ts'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'
import { homePrefix, parseLaunchdServices, parseProcessStart, processStartedAt, WebKitProcess, webKitArguments, webKitEnvironment } from '../../src/browser/webkit/process.ts'

test("reads the services launchd started for the browser, keeping those with a running pid", () => {
  const text = [
    'pid/4242 = {',
    '\ttype = pid',
    '\tservices = {',
    '\t\t   812      - \tcom.apple.WebKit.WebContent.1A2B',
    '\t\t     -      - \tcom.apple.WebKit.GPU.9F',
    '\t\t   813      0 \tcom.apple.WebKit.Networking.33',
    '\t}',
    '\tendpoints = {',
    '\t\t   900      - \tnot.a.service',
    '\t}',
    '}',
  ].join('\n')
  assert.deepEqual(parseLaunchdServices(text), [
    { pid: 812, label: 'com.apple.WebKit.WebContent.1A2B' },
    { pid: 813, label: 'com.apple.WebKit.Networking.33' },
  ])
})

test("launchd's text with no services block is an error, never an empty list", () => {
  assert.throws(() => parseLaunchdServices('pid/4242 = {\n\ttype = pid\n}'), /no services block/)
})

test('the browser starts on the inspector pipe with no startup window, headless unless asked to show one', () => {
  assert.deepEqual(webKitArguments(true), ['--inspector-pipe', '--headless', '--no-startup-window'])
  assert.deepEqual(webKitArguments(false), ['--inspector-pipe', '--no-startup-window'])
})

test("the browser's environment is set in full: nothing of Retest's own passes through, and its home is the temporary one", () => {
  process.env['RETEST_TEST_SECRET_FOR_WEBKIT'] = 'hunter2'
  try {
    const environment = webKitEnvironment({ directory: '/cache/webkit-2359' }, '/tmp/retest-webkit-1-ab')
    assert.deepEqual(environment, {
      PATH: '/usr/bin:/bin',
      HOME: '/tmp/retest-webkit-1-ab',
      CFFIXED_USER_HOME: '/tmp/retest-webkit-1-ab',
      TMPDIR: '/tmp/retest-webkit-1-ab/tmp/',
      DYLD_FRAMEWORK_PATH: '/cache/webkit-2359',
      DYLD_LIBRARY_PATH: '/cache/webkit-2359',
    })
    assert.ok(!Object.values(environment).includes('hunter2'))
  } finally {
    delete process.env['RETEST_TEST_SECRET_FOR_WEBKIT']
  }
})

test("a home's name says which Retest process made it", () => {
  assert.equal(homePrefix(4242), 'retest-webkit-4242-')
})

// Held from the WebKit lane's record, one conformance run ended cleanup_failed: "The browser's output did not finish
// writing and closing within 1000 ms." A timer was racing an output close that needs several turns of the event loop,
// and a busy main thread lets the timer win; Chrome's twin of this code showed it on 8 of 8 healthy closes.
test("a WebKit browser's output that closes while the main thread is busy is not reported as left open", { timeout: 20_000 }, async (t) => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'retest-webkit-output-close-')))
  t.after(() => rm(folder, { recursive: true, force: true }))
  // A stand-in for the build's executable: it writes, reads one command from the inspector pipe, writes again and ends.
  const executable = join(folder, 'Playwright')
  await writeFile(executable, '#!/bin/sh\necho started\nread message <&3\necho ending >&2\nexit 0\n')
  await chmod(executable, 0o755)
  const build = { directory: folder, executable, protocolSha256: '', revision: undefined, version: 'test' }
  const browser = await WebKitProcess.start({ build, logFile: join(folder, 'browser.log'), headless: true, homeParent: folder, redact: (text) => text, listServices: () => 'services = {\n}\n' })
  // Synchronous work, such as process readings for other browsers, holding the main thread most of the time.
  const pause = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  const busy = setInterval(() => { Atomics.wait(pause, 0, 0, 300) }, 10)
  try {
    browser.pipe.writable.end('exit\n')
    assert.deepEqual(await browser.stop(closeGraceMs), [])
  } finally {
    clearInterval(busy)
  }
  assert.match(await readFile(join(folder, 'browser.log'), 'utf8'), /started\n[\s\S]*ending\n|ending\n[\s\S]*started\n/)
  assert.equal(existsSync(browser.home), false, 'the home is removed once nothing of the browser is left')
})

// The same race made certain: the browser and everything that could write its output are gone, and Retest's own log
// writing finishes after the bound, as it did on a busy host. Only output something still holds is a problem.
test("a WebKit browser's output whose writers are gone but whose writing finishes after the bound is not reported, and one still held is", { timeout: 30_000 }, async (t) => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'retest-webkit-output-late-')))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const started = async (output: { closed: Promise<string[]>; cancel(): void; writersRemain(): boolean }, name: string) => {
    const home = join(folder, name)
    const child = spawn('/bin/sh', ['-c', 'exit 0'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
    await once(child, 'spawn')
    const ownership = new OwnedProcessGroup(child.pid ?? 0, process.pid)
    ownership.capture()
    const [, , , writable, readable] = child.stdio
    assert.ok(writable instanceof Writable && readable instanceof Readable)
    const build = { directory: folder, executable: '/bin/sh', protocolSha256: '', revision: undefined, version: 'test' }
    return new WebKitProcess(child, { build, home, pipe: { readable, writable }, ownership, launcher: { pid: process.pid, startedAt: 'now' }, output, listServices: () => 'services = {\n}\n' })
  }
  let canceled = false
  const late = await started({ closed: delay(closeGraceMs + 500).then((): string[] => []), cancel: () => { canceled = true }, writersRemain: () => false }, 'late')
  assert.deepEqual(await late.stop(0), [])
  assert.equal(canceled, false, 'the log was left to finish')
  const held = await started({ closed: new Promise<string[]>(() => undefined), cancel: () => { canceled = true }, writersRemain: () => true }, 'held')
  assert.deepEqual(await held.stop(0), [`The browser's output did not finish writing and closing within ${closeGraceMs} ms.`])
  assert.equal(canceled, true, 'the reading of output still held is stopped')
})

// A failed `ps` and a pid that is not there once read the same, and the sweep took a failed reading for a Retest process
// that had ended. Only a reading that lists the reading process itself shows the asked one is not there.
test('a start time reading tells a process that is not there from a reading that shows nothing', { timeout: 10_000 }, () => {
  const own = '  700 Mon Oct  5 01:00:00 2026    \n'
  assert.equal(parseProcessStart(`  812 Mon Oct  5 01:23:45 2026    \n${own}`, 812, 700), 'Mon Oct  5 01:23:45 2026')
  assert.equal(parseProcessStart(own, 812, 700), undefined, 'a reading that lists only the reading process shows the asked one is not there')
  assert.equal(parseProcessStart(own, 700, 700), 'Mon Oct  5 01:00:00 2026', 'the reading process reads its own start')
  assert.throws(() => parseProcessStart('', 812, 700), /did not list the process reading it/)
  assert.throws(() => parseProcessStart('  812 Mon Oct  5 01:23:45 2026\n', 812, 700), /did not list the process reading it/, 'without its own line a reading shows nothing, even of a pid it lists')
  assert.throws(() => parseProcessStart(`ps: process table full\n${own}`, 812, 700), /not a pid and a start time/)
  assert.throws(() => parseProcessStart(`  812\n${own}`, 812, 700), /not a pid and a start time/)
})

test("the host's start time reading gives a running process its start and one that has ended none", { timeout: 10_000 }, async () => {
  assert.match(processStartedAt(process.pid) ?? '', /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/)
  const child = spawn('/bin/sh', ['-c', 'exit 0'], { stdio: 'ignore' })
  await once(child, 'exit')
  assert.ok(child.pid !== undefined)
  // The child has been reaped, so its pid names no process unless another took it in the moment since.
  assert.equal(processStartedAt(child.pid), undefined)
  assert.throws(() => processStartedAt(0), RangeError)
})

test('WebKit cleanup shares one helper snapshot for 100 dead helpers and checks only its live root before signalling', async () => {
  const { ChildProcess } = await import('node:child_process')
  const child = new ChildProcess()
  const pid = 6101
  Object.defineProperty(child, 'pid', { value: pid })
  const home = await mkdtemp(join(tmpdir(), 'retest-webkit-history-'))
  const root = { pid, parentPid: process.pid, groupId: pid, startedAt: 'birth', command: '/owned/browser' }
  const helpers = Array.from({ length: 100 }, (_, index) => ({ pid: 7000 + index, parentPid: 1, groupId: 7000 + index, startedAt: 'birth', command: `/owned/build/helper-${index}` }))
  let entries = [root, ...helpers]
  let cleaning = false
  const calls: string[] = []
  const system = {
    read: () => { if (cleaning) throw new Error('cleanup used a synchronous table'); return entries },
    readAsync: async () => { calls.push('table'); return entries },
    readProcess: (pid: number) => { if (cleaning) throw new Error('cleanup used a synchronous identity'); return entries.find((entry) => entry.pid === pid) },
    readProcessAsync: async (pid: number) => { calls.push(`identity ${pid}`); return entries.find((entry) => entry.pid === pid) },
    signal: (pid: number) => { calls.push(`signal ${pid}`); entries = []; child.emit('exit', null, 'SIGKILL') },
  }
  const ownership = new OwnedProcessGroup(pid, process.pid, system)
  assert.deepEqual(ownership.capture(), [])
  const before = new Set(process.listeners('exit'))
  const webkit = new WebKitProcess(child, {
    build: { directory: '/owned/build', executable: '/owned/browser', protocolSha256: '', revision: undefined, version: 'test' },
    home, ownership, launcher: { pid: process.pid, startedAt: 'birth' },
    pipe: { readable: new Readable({ read() {} }), writable: new Writable({ write(_chunk, _encoding, callback) { callback() } }) },
    output: { closed: Promise.resolve([]), cancel() {}, writersRemain: () => false }, system,
    listServices: () => `services = {\n${helpers.map((entry) => ` ${entry.pid} - helper-${entry.pid}`).join('\n')}\n}\n`,
  })
  try {
    assert.deepEqual(await webkit.recordHelpers(), [])
    assert.equal(webkit.helpers.length, 100)
    entries = [root]
    calls.length = 0
    cleaning = true
    assert.deepEqual(await webkit.stop(0), [])
    assert.deepEqual(calls.filter((call) => call.startsWith('identity')), [`identity ${pid}`])
    assert.deepEqual(calls.filter((call) => call.startsWith('signal')), [`signal ${pid}`])
    assert.equal(calls.filter((call) => call === 'table').length, 3, 'one signal table, one main liveness table and one table for all 100 helpers')
    const signalAt = calls.indexOf(`signal ${pid}`)
    assert.deepEqual(calls.slice(signalAt - 2, signalAt + 1), ['table', `identity ${pid}`, `signal ${pid}`])
  } finally {
    cleaning = false
    entries = []
    for (const hook of process.listeners('exit')) if (!before.has(hook)) process.off('exit', hook)
    await rm(home, { recursive: true, force: true })
  }
})
