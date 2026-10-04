import type { DiagnosticIdentity, DiagnosticLimits } from '../../src/protocol/diagnostics.ts'
import type { NativeNetworkFile, NativeNetworkMetadata } from '../../src/diagnostics/native-network.ts'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { launchLoggedNativeApp, NativeLogSource } from '../../src/native/logs.ts'
import { commandOf, listProcesses, systemTools } from '../../src/native/processes.ts'
import { NativeNetworkSource, readNativeNetworkMetadata } from '../../src/diagnostics/native-network.ts'
import { AttemptBudget } from '../../src/diagnostics/session-capture.ts'
import { defaultDiagnosticLimits, diagnosticRecordSchema } from '../../src/protocol/diagnostics.ts'
import { parse } from '../../src/protocol/schema.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { defaultDiagnosticsPolicy, policyFailure } from '../../src/diagnostics/policy.ts'

const identity: DiagnosticIdentity = { testId: 'native > diagnostics', attemptId: 'attempt', app: 'phone', sessionId: 'attempt:phone' }
function budget(limits: Partial<DiagnosticLimits> = {}): AttemptBudget { return new AttemptBudget({ ...defaultDiagnosticLimits, ...limits }) }
function logs(limits: Partial<DiagnosticLimits> = {}, redactor = new Redactor()): NativeLogSource {
  const source = new NativeLogSource({ identity, budget: budget(limits), redactor, clock: () => 0 })
  source.bind({ pid: 42, command: '/owned/TaskPhone' }, 'simctl-stdout')
  return source
}
function push(source: NativeLogSource, text: string): void { source.push(Buffer.from(text)) }

test('native stdout keeps its source, pid and every identity key, with no JS error claim', () => {
  const source = logs(); push(source, 'GET /api/health 200 2ms\n')
  const result = source.finish(); assert.equal(result.capture.state, 'complete')
  const [record] = result.records; assert.ok(record)
  assert.deepEqual(record, { ...identity, type: 'console', id: 'c1', consoleType: 'stdout', level: 'info', origin: 'native', source: 'simctl-stdout', processId: 42, text: { text: 'GET /api/health 200 2ms', truncated: false, length: 23 }, time: new Date(0).toISOString() })
  assert.equal(parse(diagnosticRecordSchema, record).ok, true)
  assert.equal(source.finish(), result)
  push(source, 'late\n'); assert.equal(result.records.length, 1)
})
test('native log redacts split secrets before truncating, escaping or persistence', () => {
  const redactor = new Redactor(); redactor.learn('key', 'demo"key\\value')
  const source = logs({}, redactor)
  push(source, 'demo"key'); push(source, '\\value http://user:password@host.test/path?token=hidden#secret\n')
  const text = JSON.stringify(source.finish())
  assert.ok(text.includes('{{key}}')); for (const hidden of ['demo', 'password', 'hidden', '#secret']) assert.equal(text.includes(hidden), false)
})
test('native log bounds entries across apps through the attempt budget', () => {
  const shared = budget({ consoleEntries: 1 }); const redactor = new Redactor()
  const phone = new NativeLogSource({ identity, budget: shared, redactor }); phone.bind({ pid: 42, command: '/phone' }, 'simctl-stdout')
  const desk = new NativeLogSource({ identity: { ...identity, app: 'desk', sessionId: 'attempt:desk' }, budget: shared, redactor }); desk.bind({ pid: 43, command: '/desk' }, 'macos-stdout')
  push(phone, 'one\n'); push(desk, 'two\n')
  assert.equal(phone.finish().capture.state, 'complete'); const result = desk.finish()
  assert.ok(result.capture.state === 'partial'); assert.equal(result.capture.dropped, 1); assert.match(result.capture.reason, /diagnostics limits/)
})
test('native log byte cap includes identity, source and pid as persisted', () => {
  const source = logs({ consoleBytes: 10 }); push(source, 'one\n')
  const result = source.finish(); assert.deepEqual(result.records, []); assert.ok(result.capture.state === 'partial'); assert.equal(result.capture.bytes, 0)
})
test('native log cuts oversized lines and keeps no partial secret at its memory boundary', () => {
  const redactor = new Redactor(); redactor.learn('key', 'sensitive-value')
  const source = logs({ textLength: 4 }, redactor); push(source, 'x'.repeat(12) + 'sensitive-value' + 'z'.repeat(100_000) + '\n')
  const result = source.finish(); assert.ok(result.capture.state === 'partial'); assert.match(result.capture.reason, /text limit/)
  assert.equal(result.records[0]?.text.text, 'xxxx'); assert.equal(result.records[0]?.text.length, 100_027)
  assert.equal(JSON.stringify(result).includes('sens'), false)
})
test('native log handles UTF-8 split across chunks and CRLF', () => {
  const source = logs(); const bytes = Buffer.from('🙂\r\n'); source.push(bytes.subarray(0, 2)); source.push(bytes.subarray(2))
  assert.equal(source.finish().records[0]?.text.text, '🙂')
})
test('native log removes its listeners and marks a stream error partial', () => {
  const source = logs(); const stream = new PassThrough(); source.attach(stream); stream.write('kept\n'); stream.emit('error', new Error('credential must never be quoted'))
  const result = source.finish(); assert.ok(result.capture.state === 'partial'); assert.equal(result.capture.reason, 'the app log stream could not be read')
  assert.equal(stream.listenerCount('data'), 0); assert.equal(stream.listenerCount('error'), 0); assert.equal(stream.listenerCount('end'), 0)
})
test('native log keeps an unterminated line with an explicit partial reason', () => {
  const source = logs(); push(source, 'partial'); const result = source.finish()
  assert.ok(result.capture.state === 'partial'); assert.equal(result.capture.reason, 'the app log ended inside a line'); assert.equal(result.records[0]?.text.text, 'partial')
})
test('native log with no output never claims complete', () => { assert.deepEqual(logs().finish().capture, { state: 'unavailable', reason: 'the app wrote no log lines' }) })
test('late secret learning rebinds text and byte counts before native log persistence', () => {
  const redactor = new Redactor(); const source = logs({ textLength: 8 }, redactor); push(source, 'key\n')
  redactor.learn('long-secret-name', 'key')
  const result = source.finish(); assert.ok(result.capture.state === 'partial'); assert.equal(result.records[0]?.text.text.length, 8)
  assert.equal(JSON.stringify(result.records).includes('"key"'), false)
  assert.equal(result.capture.bytes, result.records.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record)) + 1, 0))
})
test('blank native log lines are no diagnostic output', () => { const source = logs(); push(source, '\n\r\n   \n'); assert.deepEqual(source.finish().capture, { state: 'unavailable', reason: 'the app wrote no log lines' }) })
test('a native source lost after records arrived preserves them and reports partial', () => { const source = logs(); push(source, 'kept\n'); source.unavailable('the app log source could not be opened'); const result = source.finish(); assert.equal(result.capture.state, 'partial'); assert.equal(result.records[0]?.text.text, 'kept') })
test('native log without a source names the missing source', () => { assert.deepEqual(new NativeLogSource({ identity, budget: budget(), redactor: new Redactor() }).finish().capture, { state: 'unavailable', reason: 'the app provides no log source' }) })
test('native log source that cannot open says so', () => { const source = logs(); source.unavailable('the app log source could not be opened'); assert.deepEqual(source.finish().capture, { state: 'unavailable', reason: 'the app log source could not be opened' }) })
test('disabled native logs keep no data', () => { const source = new NativeLogSource({ identity, budget: budget(), redactor: new Redactor(), enabled: false }); source.bind({ pid: 42, command: '/phone' }, 'simctl-stdout'); push(source, 'ignored\n'); assert.deepEqual(source.finish(), { records: [], capture: { state: 'disabled' } }) })
test('native log rejects unowned chunks and a second bind', () => { const source = new NativeLogSource({ identity, budget: budget(), redactor: new Redactor() }); assert.throws(() => push(source, 'line\n'), /no owned process/); assert.throws(() => source.bind({ pid: 0, command: '' }, 'macos-stdout')); source.bind({ pid: 42, command: '/phone' }, 'simctl-stdout'); assert.throws(() => source.bind({ pid: 43, command: '/other' }, 'macos-stdout'), /already bound/) })

test('owned launch stdout resolves the fake app through parent process scope, ignoring stderr acknowledgements, and stops only recorded processes', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-log-launch-unit-')); t.after(() => rm(folder, { recursive: true, force: true }))
  const udid = '12345678-1234-1234-1234-123456789012'
  const appFolder = join(folder, 'Devices', udid); await mkdir(appFolder, { recursive: true })
  const executable = 'TaskPhone.mjs'; const app = join(appFolder, executable)
  await writeFile(app, "process.stdout.write('GET /api/health 200 2ms\\n'); setInterval(() => {}, 1000);\n")
  const proxy = join(folder, 'simctl.mjs')
  await writeFile(proxy, `#!${process.execPath}\nimport { spawn } from 'node:child_process'; const app = spawn(process.execPath, [${JSON.stringify(app)}], { stdio: ['ignore', 'pipe', 'ignore'] }); app.stdout.pipe(process.stdout); app.once('spawn', () => process.stderr.write('dev.test.phone: ' + app.pid + '\\n')); app.once('exit', () => process.exit(0));\n`)
  await chmod(proxy, 0o700)
  const source = new NativeLogSource({ identity, budget: budget(), redactor: new Redactor() })
  const launched = await launchLoggedNativeApp({ source, tools: { ...systemTools, xcrun: proxy }, launch: { arguments: [], environment: {} }, timeoutMs: 5000, processes: async () => { const processes = (await listProcesses(systemTools, 5000)).filter((entry) => entry.command.includes(app)); return { ok: true, running: processes.length > 0, processes, pids: processes.map((entry) => entry.pid) } }, target: { platform: 'ios-simulator', udid, bundleId: 'dev.test.phone', executable } })
  try {
    const started = performance.now(); while (source.entries === 0 && performance.now() - started < 5000) await sleep(10)
    assert.equal(source.entries, 1)
    assert.match(launched.process.command, /TaskPhone\.mjs/)
  } finally { await launched.stop() }
  await launched.stop()
  assert.equal((await commandOf(systemTools, launched.process.pid)).state, 'absent')
  assert.ok(launched.launcher); assert.equal((await commandOf(systemTools, launched.launcher.pid)).state, 'absent')
  const result = source.finish(); assert.equal(result.capture.state, 'complete'); assert.equal(result.records[0]?.text.text, 'GET /api/health 200 2ms'); assert.equal(result.records[0]?.processId, launched.process.pid)
})

function metadata(sequence = 1, changes: Partial<NativeNetworkMetadata> = {}): NativeNetworkMetadata { return { schemaVersion: 1, type: 'http.request', sequence, startedAt: new Date(0).toISOString(), method: 'GET', path: '/api/health', status: 200, durationMs: 2, client: 'ios', completed: true, ...changes } }
function fakeFile(initial = ''): { file: NativeNetworkFile; append(text: string): void; closed(): boolean; failRead(): void; truncate(): void } {
  let content = Buffer.from(initial); let closed = false; let failing = false
  return { file: { size: async () => content.length, read: async (offset, length) => { if (failing) throw new Error('secret file error'); return content.subarray(offset, offset + length) }, close: async () => { closed = true } }, append: (text) => { content = Buffer.concat([content, Buffer.from(text)]) }, closed: () => closed, failRead: () => { failing = true }, truncate: () => { content = Buffer.alloc(0) } }
}
async function network(limits: Partial<DiagnosticLimits> = {}, redactor = new Redactor(), initial = ''): Promise<{ source: NativeNetworkSource; file: ReturnType<typeof fakeFile> }> {
  const file = fakeFile(initial)
  const source = new NativeNetworkSource({ identity, budget: budget(limits), redactor, source: { path: '/declared/metadata', client: 'ios' }, openFile: async () => file.file })
  await source.start(); return { source, file }
}
function append(file: ReturnType<typeof fakeFile>, records: NativeNetworkMetadata[]): void { file.append(records.map((record) => JSON.stringify(record) + '\n').join('')) }

test('native network keeps only this interval and client, with identity and source on every lifecycle record', async () => {
  const { source, file } = await network({}, new Redactor(), JSON.stringify(metadata()) + '\n')
  append(file, [metadata(2, { client: 'macos' }), metadata(3)])
  const result = await source.finish(); assert.ok(result.capture.state === 'complete'); assert.equal(result.capture.requests, 1)
  assert.deepEqual(result.records.map((record) => record.type), ['network.request', 'network.response', 'network.finished'])
  for (const record of result.records) { for (const key of ['testId', 'attemptId', 'app', 'sessionId'] as const) assert.equal(record[key], identity[key]); assert.equal('source' in record && record.source, 'app-network-file'); assert.equal('client' in record && record.client, 'ios'); assert.equal(parse(diagnosticRecordSchema, record).ok, true) }
  assert.equal(file.closed(), true); assert.equal(await source.finish(), result)
})
test('native sources keep the original identity and network client when caller objects change', async () => {
  const owned = { ...identity }; const declaration: { path: string; client: 'ios' | 'macos' } = { path: '/metadata', client: 'ios' }
  const file = fakeFile(); const source = new NativeNetworkSource({ identity: owned, budget: budget(), redactor: new Redactor(), source: declaration, openFile: async () => file.file })
  const log = new NativeLogSource({ identity: owned, budget: budget(), redactor: new Redactor() }); log.bind({ pid: 42, command: '/phone' }, 'simctl-stdout')
  owned.app = 'changed'; declaration.client = 'macos'; await source.start(); append(file, [metadata()]); push(log, 'kept\n')
  const result = await source.finish(); assert.equal(result.records.length, 3)
  assert.ok(result.records.every((record) => record.app === 'phone' && 'client' in record && record.client === 'ios'))
  assert.equal(log.finish().records[0]?.app, 'phone')
})
test('native network sanitizes route credentials, query, fragment and token paths, after host redaction', async () => {
  const redactor = new Redactor(); redactor.learn('key', 'demo-secret')
  const { source, file } = await network({}, redactor)
  append(file, [metadata(1, { path: 'http://user:password@host.test/demo-secret/1234567890123456?token=hidden#private' })])
  const result = await source.finish(); const text = JSON.stringify(result)
  for (const secret of ['password', 'demo-secret', '1234567890123456', 'hidden', 'private']) assert.equal(text.includes(secret), false)
  assert.ok(text.includes('{{key}}')); assert.equal(result.capture.state, 'complete')
})
test('native network validates every field and refuses headers and bodies', () => {
  for (const changes of [{ schemaVersion: 2 }, { status: 99 }, { status: 600 }, { durationMs: -1 }, { durationMs: Infinity }, { sequence: 0 }, { sequence: Number.MAX_SAFE_INTEGER + 1 }, { client: 'credential' }, { method: 'secret' }, { startedAt: 'not a date' }, { headers: { authorization: 'credential' } }, { body: 'credential' }]) assert.equal(readNativeNetworkMetadata(JSON.stringify({ ...metadata(), ...changes })), undefined)
  assert.equal(readNativeNetworkMetadata('not json'), undefined)
})
test('native network invalid and repeated records make capture partial while preserving valid records', async () => {
  const { source, file } = await network(); file.append('bad json\n'); append(file, [metadata(1), metadata(1), metadata(2)])
  const result = await source.finish(); assert.ok(result.capture.state === 'partial'); assert.match(result.capture.reason, /invalid or out of order/); assert.equal(result.capture.requests, 2)
})
test('native network HTTP errors and closed responses retain their measured duration and honest ending', async () => {
  const { source, file } = await network(); append(file, [metadata(1, { status: 500 }), metadata(2, { completed: false })])
  const result = await source.finish(); assert.ok(result.capture.state === 'complete'); assert.equal(result.capture.httpErrors, 1); assert.equal(result.capture.transportFailures, 1)
  assert.equal(result.records.at(-1)?.type, 'network.failed'); assert.equal(result.records.some((record) => 'headers' in record || 'body' in record), false)
})
test('native network record limit keeps a hop whole and marks the lost hop partial', async () => {
  const { source, file } = await network({ requests: 1 }); append(file, [metadata(1), metadata(2)])
  const result = await source.finish(); assert.ok(result.capture.state === 'partial'); assert.equal(result.capture.dropped, 1); assert.equal(result.records.length, 3)
})
test('native network byte limit includes all three persisted records', async () => {
  const { source, file } = await network({ networkBytes: 1 }); append(file, [metadata()]); const result = await source.finish()
  assert.ok(result.capture.state === 'partial'); assert.equal(result.capture.bytes, 0); assert.deepEqual(result.records, [])
})
test('native network oversized source lines are bounded and never persisted', async () => {
  const { source, file } = await network({ textLength: 10 }); file.append('x'.repeat(100_000) + '\n'); append(file, [metadata()])
  const result = await source.finish(); assert.ok(result.capture.state === 'partial'); assert.match(result.capture.reason, /input limit/); assert.equal(result.capture.dropped, 1); assert.equal(result.records.length, 3)
})
test('native network route text limits are explicit', async () => {
  const { source, file } = await network({ textLength: 5 }); append(file, [metadata()]); const result = await source.finish(); assert.ok(result.capture.state === 'partial'); assert.equal(result.capture.truncated, 1)
})
test('native network missing declaration has the required reason', async () => { const source = new NativeNetworkSource({ identity, budget: budget(), redactor: new Redactor() }); await source.start(); assert.deepEqual((await source.finish()).capture, { state: 'unavailable', reason: 'the app provides no network source' }) })
for (const [code, reason] of [['ENOENT', 'the declared network file is missing'], ['EACCES', 'the declared network file is unreadable']]) test(`native network ${code} is unavailable without quoting the file error`, async () => { const source = new NativeNetworkSource({ identity, budget: budget(), redactor: new Redactor(), source: { path: '/secret-path', client: 'ios' }, openFile: async () => { throw Object.assign(new Error('secret error'), { code }) } }); await source.start(); assert.deepEqual((await source.finish()).capture, { state: 'unavailable', reason }) })
test('native network empty or other-client file is unavailable', async () => { const { source, file } = await network(); append(file, [metadata(1, { client: 'macos' })]); assert.deepEqual((await source.finish()).capture, { state: 'unavailable', reason: 'the source wrote no network records for the owned app' }) })
test('native network read failure, truncated file and unfinished line are partial with distinct reasons', async () => {
  const failed = await network(); append(failed.file, [metadata()]); failed.file.failRead(); const failure = await failed.source.finish(); assert.ok(failure.capture.state === 'partial'); assert.equal(failure.capture.reason, 'the network file could not be read to its end')
  const truncated = await network({}, new Redactor(), 'old\n'); truncated.file.truncate(); const cut = await truncated.source.finish(); assert.ok(cut.capture.state === 'partial'); assert.equal(cut.capture.reason, 'the network file was truncated during capture')
  const incomplete = await network(); incomplete.file.append('{'); const result = await incomplete.source.finish(); assert.ok(result.capture.state === 'partial'); assert.equal(result.capture.reason, 'the network file ended inside a record')
})
test('native network finish before start is unavailable and a late start is refused', async () => {
  const source = new NativeNetworkSource({ identity, budget: budget(), redactor: new Redactor() })
  assert.deepEqual((await source.finish()).capture, { state: 'unavailable', reason: 'the network source was not opened before the app ran' })
  await assert.rejects(source.start(), /already opened or finished/)
})
test('native network finish waits for an opening file and closes it once', async () => {
  const opening = Promise.withResolvers<NativeNetworkFile>(); const file = fakeFile()
  const source = new NativeNetworkSource({ identity, budget: budget(), redactor: new Redactor(), source: { path: '/metadata', client: 'ios' }, openFile: () => opening.promise })
  const started = source.start(); const finished = source.finish(); opening.resolve(file.file); await started; await finished
  assert.equal(file.closed(), true); await assert.rejects(source.start(), /already opened or finished/)
})
test('native network input scan is bounded even when another client floods the file', async () => {
  let readBytes = 0; const content = Buffer.from('x'.repeat(100_000))
  const source = new NativeNetworkSource({ identity, budget: budget({ networkBytes: 1 }), redactor: new Redactor(), source: { path: '/metadata', client: 'ios' }, openFile: async () => ({ size: async () => readBytes === 0 && !appended ? 0 : content.length, read: async (offset, length) => { readBytes += length; return content.subarray(offset, offset + length) }, close: async () => undefined }) })
  let appended = false; await source.start(); appended = true
  const result = await source.finish(); assert.ok(result.capture.state === 'partial'); assert.match(result.capture.reason, /input byte limit/); assert.equal(readBytes, 4096); assert.deepEqual(result.records, [])
})
test('native network close failures and short reads report their reasons without raw errors', async () => {
  for (const reason of ['the network file could not be closed', 'the network file ended before its captured size']) {
    let opened = false
    const source = new NativeNetworkSource({ identity, budget: budget(), redactor: new Redactor(), source: { path: '/metadata', client: 'ios' }, openFile: async () => ({ size: async () => opened ? 10 : 0, read: async () => new Uint8Array(0), close: async () => { if (reason.includes('closed')) throw new Error('credential') } }) })
    await source.start(); opened = reason.includes('size')
    const result = await source.finish(); assert.ok(result.capture.state === 'partial'); assert.equal(result.capture.reason, reason)
  }
})
test('native network disabled never opens a file', async () => { const source = new NativeNetworkSource({ identity, budget: budget(), redactor: new Redactor(), enabled: false, source: { path: '/never', client: 'ios' }, openFile: async () => { throw new Error('must not open') } }); await source.start(); assert.deepEqual(await source.finish(), { capture: { state: 'disabled' }, records: [] }) })
test('native stdout cannot satisfy strict JavaScript error classification', () => { const source = logs(); push(source, 'GET /api/health 200 2ms\n'); const log = source.finish(); const failure = policyFailure({ ...defaultDiagnosticsPolicy, strict: { consoleErrors: true, runtimeErrors: false, transportFailures: false, httpErrors: false, allow: [] } }, log.records, [{ sessionId: identity.sessionId, scope: { engine: 'ios-simulator', source: 'owned_app', console: { covered: ['owned_process'], notCovered: [] }, network: { covered: [], notCovered: [] } }, console: log.capture, network: { state: 'unavailable', reason: 'the app provides no network source' } }]); assert.equal(failure?.class, 'reporting_failed') })
