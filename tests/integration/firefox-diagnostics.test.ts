import type { TestContext } from 'node:test'
import type { DiagnosticSink } from '../../src/diagnostics/observations.ts'
import type { Schema } from '../../src/protocol/schema.ts'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { readBidi } from '../../src/browser/firefox/bidi-client.ts'
import { parseBidiMessage } from '../../src/browser/firefox/bidi-message.ts'
import { launchFirefox } from '../../src/browser/firefox/launch.ts'
import { FirefoxPage } from '../../src/browser/firefox/page.ts'
import { AttemptDiagnostics } from '../../src/diagnostics/attempt.ts'
import { firefoxConsoleUnavailable } from '../../src/diagnostics/firefox-collector.ts'
import { defaultDiagnosticsPolicy } from '../../src/diagnostics/policy.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { s } from '../../src/protocol/schema.ts'
import { closeMs, observeUntil, setupMs } from './browser-harness.ts'
import { firefoxPath, testFirefoxRoute } from './engines.ts'

// Network capture on the real Firefox, alone: a page's requests through the attempt that owns its capture, with the
// console kind unavailable, and the page's own getter on a logged object never run by Retest's capture.

const skip = process.platform === 'darwin' && process.arch === 'arm64' ? false : 'Firefox requires macOS on Apple silicon'
const secret = 'kestrel-4417-orchid'

type Site = { url: string; refused: string; hits: (path: string) => number }

async function probeFolder(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'retest-firefox-console-test-'))
}

// A site that answers 404, 500, a redirect of two hops, a request it never answers, and a page that makes them all.
async function site(t: TestContext): Promise<Site> {
  const seen = new Map<string, number>()
  const closed = createServer()
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
  const closedAddress = closed.address()
  const refused = typeof closedAddress === 'object' && closedAddress !== null ? `http://127.0.0.1:${closedAddress.port}/refused` : ''
  await new Promise<void>((resolve) => closed.close(() => resolve()))
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    seen.set(path, (seen.get(path) ?? 0) + 1)
    const answer = (status: number, body: string, headers: Record<string, string> = {}) => {
      response.writeHead(status, { 'content-type': 'text/html', ...headers })
      response.end(body)
    }
    if (path === '/') {
      answer(200, `<!doctype html><title>untouched</title><p data-testid="done"></p><script>
        const logged = { plain: 1 };
        Object.defineProperty(logged, 'tripwire', { enumerable: true, get() { document.title = 'getter ran'; return 2 } });
        console.log('object', logged);
        console.error('a page error with ${secret}');
        fetch('/hang').catch(() => {});
        Promise.allSettled([fetch('/missing'), fetch('/broken'), fetch(${JSON.stringify(refused)}), fetch('/first'), fetch('/items/${secret}?token=${secret}')])
          .then(() => { document.querySelector('[data-testid=done]').textContent = 'done' });
      </script>`)
      return
    }
    if (path === '/hang') return
    if (path === '/missing') return answer(404, 'missing')
    if (path === '/broken') return answer(500, 'broken')
    if (path === '/first') return answer(302, '', { location: '/second' })
    if (path === '/second') return answer(302, '', { location: '/final' })
    answer(200, 'ok', { 'content-type': 'text/plain' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const address = server.address()
  const url = typeof address === 'object' && address !== null ? `http://127.0.0.1:${address.port}` : ''
  return { url, refused, hits: (path) => seen.get(path) ?? 0 }
}

test("Firefox's capture records a page's requests, a 404 and a 500 apart from a refused connection, both redirect hops and the request that never ended, holds no secret, says the console was unavailable, and never runs the page's getter", { skip }, async (t) => {
  const folder = await probeFolder()
  const served = await site(t)
  const browser = await launchFirefox({ executablePath: firefoxPath(), route: testFirefoxRoute(), headless: true, folderRoot: folder, logFile: join(folder, 'browser.log') }, setupMs)
  t.after(async () => { await browser.close(closeMs); await rm(folder, { recursive: true, force: true }) })
  const page = await browser.newPage({ baseUrl: served.url }, setupMs)
  t.after(() => page.dispose(closeMs))
  const redactor = new Redactor()
  redactor.learn('password', secret)
  const written = new Map<string, string>()
  const diagnostics = new AttemptDiagnostics({
    policy: defaultDiagnosticsPolicy,
    redactor,
    writeArtifact: (path, bytes) => void written.set(path, Buffer.from(bytes).toString('utf8')),
    emit: () => {},
    testId: 'firefox.retest.ts > captures',
    attemptId: 'k3v9q0x2mb',
    variant: { web: 'firefox' },
    named: true,
  })
  const session = { sessionId: 'k3v9q0x2mb:web', owner: { runId: 'run', testId: 'firefox.retest.ts > captures', attemptId: 'k3v9q0x2mb', app: 'web' }, runtime: browser.identity }
  const collect = page.collectDiagnostics
  assert.ok(collect !== undefined, 'the Firefox page collects diagnostics')
  await diagnostics.start([{ app: 'web', page: { collectDiagnostics: (sink: DiagnosticSink, timeoutMs: number) => collect.call(page, sink, timeoutMs) }, session }], 5000)
  assert.ok((await page.execute({ kind: 'goto', url: '/' }, setupMs)).ok)
  await observeUntil(page, 'done', (seen) => seen.text === 'done')
  await observeUntil(page, 'done', () => served.hits('/hang') === 1 && served.hits('/final') === 1)
  const looked = await page.execute({ kind: 'observePage' }, setupMs)
  assert.ok(looked.ok && looked.kind === 'observePage')
  assert.equal(looked.observation.title, 'untouched', "capture never ran the getter of the object the page logged")
  const finished = diagnostics.finish('attempt_ended')
  const [summary] = finished.summaries
  assert.deepEqual(summary?.console, { state: 'unavailable', reason: firefoxConsoleUnavailable })
  assert.equal(summary?.network.state, 'complete', JSON.stringify(summary?.network))
  const artifact = [...written.values()].join('')
  assert.doesNotMatch(artifact, new RegExp(secret), 'no secret reaches the artifact')
  assert.doesNotMatch(artifact, /token=/, 'no query reaches the artifact')
  const records = artifact.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
  assert.deepEqual(records.filter((record) => record['type'] === 'console' || record['type'] === 'runtime_error'), [], 'no console record or runtime error is kept')
  const requests = records.filter((record) => record['type'] === 'network.request')
  const idOf = (path: string, nth = 0) => requests.filter((record) => new URL(String(record['url'])).pathname === path)[nth]?.['requestId']
  const of = (type: string, id: unknown) => records.find((record) => record['type'] === type && record['requestId'] === id)
  await t.test('the document is the navigation, and every request is the main frame', () => {
    const document = requests.find((record) => new URL(String(record['url'])).pathname === '/')
    assert.equal(document?.['resourceType'], 'Document')
    for (const request of requests) assert.equal(request['frame'], 'main')
  })
  await t.test('a 404 and a 500 are responses that finished, and the refused connection failed with no status', () => {
    assert.equal(of('network.response', idOf('/missing'))?.['status'], 404)
    assert.equal(of('network.response', idOf('/broken'))?.['status'], 500)
    assert.ok(of('network.finished', idOf('/missing')) !== undefined && of('network.finished', idOf('/broken')) !== undefined)
    const refused = requests.find((record) => String(record['url']).startsWith(served.refused))?.['requestId']
    assert.equal(of('network.response', refused), undefined)
    assert.match(String(of('network.failed', refused)?.['reason']), /CONNECTION_REFUSED/)
  })
  await t.test('a redirect of two hops is three requests, each response naming the next', () => {
    const first = idOf('/first')
    const second = idOf('/second')
    const final = idOf('/final')
    assert.ok(first !== undefined && second !== undefined && final !== undefined, JSON.stringify(requests.map((record) => record['url'])))
    assert.equal(of('network.response', first)?.['redirectedTo'], second)
    assert.equal(of('network.response', second)?.['redirectedTo'], final)
    assert.equal(of('network.request', final)?.['redirectedFrom'], second)
    assert.equal(of('network.response', final)?.['status'], 200)
  })
  await t.test('the request that never ended is marked pending when the attempt ended', () => {
    const pending = of('network.pending', idOf('/hang'))
    assert.equal(pending?.['reason'], 'attempt_ended')
  })
  await t.test('the request whose path held the secret is kept with the secret redacted and no query', () => {
    const kept = requests.find((record) => String(record['url']).includes('/items/'))
    assert.ok(kept !== undefined)
    assert.match(String(kept['url']), /\/items\/\{\{password\}\}\?…$/, 'the secret is named by its placeholder, and the query is cut and marked')
  })
})

// This test deliberately subscribes to the unsafe source to establish why production must not. It never asks for a
// logged object's properties after delivery. The browser changes a title and a marker while preparing the event.
const loggedSchema = s.object({ source: s.object({ context: s.string() }), args: s.array(s.object({ type: s.string() })) })
type Logged = { source: { context: string }; args: { type: string }[] }

class ConsoleProbeSocket extends WebSocket {
  readonly entries: Logged[] = []
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  #nextId = 1_000_000_000

  constructor(url: string) {
    super(url)
    this.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return
      const message = parseBidiMessage(event.data)
      if (message.kind === 'event') {
        if (message.method === 'log.entryAdded') this.entries.push(readBidi(loggedSchema, message.params, message.method))
        return
      }
      if (message.id === undefined) return
      const pending = this.#pending.get(message.id)
      if (pending === undefined) return
      clearTimeout(pending.timer)
      this.#pending.delete(message.id)
      if (message.kind === 'success') pending.resolve(message.result)
      else pending.reject(new Error(message.kind === 'error' ? `${message.error}: ${message.message}` : message.problem))
    })
    this.addEventListener('close', () => {
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('The console probe socket closed.'))
      }
      this.#pending.clear()
    })
  }

  async command<T>(method: string, params: object, schema: Schema<T>): Promise<T> {
    const id = this.#nextId++
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`${method} did not answer the console probe.`)) }, setupMs)
      this.#pending.set(id, { resolve, reject, timer })
      try { this.send(JSON.stringify({ id, method, params })) }
      catch (error) { clearTimeout(timer); this.#pending.delete(id); reject(error) }
    })
    return readBidi(schema, result, method)
  }
}

test('Firefox 133 console serialization runs logged enumerable getters before a primitive filter could see the entry, and log subscription depth options do not prevent it', { skip }, async (t) => {
  const folder = await probeFolder()
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(`<!doctype html><title>untouched</title><div id="node">node</div><script>
      globalThis.getterReads = 0;
      const mark = () => { getterReads++; document.title = 'getter ran'; return 2 };
      const unlogged = { get tripwire() { return mark() } };
      globalThis.probeValue = name => {
        if (name === 'string') return 'safe text';
        if (name === 'number') return 37;
        if (name === 'plain') return { plain: 1 };
        if (name === 'getter') return { plain: 1, get tripwire() { return mark() } };
        if (name === 'nested') return { inner: { get tripwire() { return mark() } } };
        const node = document.getElementById('node');
        Object.defineProperty(node, 'tripwire', { enumerable: true, get: mark });
        return node;
      };
    </script>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const address = server.address()
  assert.ok(typeof address === 'object' && address !== null)
  const baseUrl = `http://127.0.0.1:${address.port}`
  let socket: ConsoleProbeSocket | undefined
  const browser = await launchFirefox({ executablePath: firefoxPath(), route: testFirefoxRoute(), headless: true, folderRoot: folder, logFile: join(folder, 'browser.log') }, setupMs, (url) => { socket = new ConsoleProbeSocket(url); return socket })
  t.after(async () => { await browser.close(closeMs); await rm(folder, { recursive: true, force: true }) })
  assert.equal(browser.version, '133.0.3', 'the refusal is verified against the pinned Firefox')
  assert.equal(browser.buildId, '20241209150345', 'the serialization evidence belongs to the pinned build')
  assert.ok(socket !== undefined)
  const wire = socket
  const empty = s.object({})
  const evaluated = s.object({ type: s.literal('success') })
  const scriptResult = s.object({ type: s.literal('success'), result: s.object({ type: s.literal('string'), value: s.string() }) })
  const modes = [
    { name: 'none', events: [], options: {} },
    { name: 'network', events: ['network.beforeRequestSent'], options: {} },
    { name: 'log', events: ['log.entryAdded'], options: {} },
    { name: 'log serializationOptions maxObjectDepth 0', events: ['log.entryAdded'], options: { serializationOptions: { maxObjectDepth: 0 } } },
    { name: 'log maxObjectDepth 0', events: ['log.entryAdded'], options: { maxObjectDepth: 0 } },
    { name: 'log primitive filter', events: ['log.entryAdded'], options: { filter: { argumentTypes: ['string', 'number'] } } },
  ] as const
  for (const mode of modes) {
    for (const value of ['string', 'number', 'plain', 'getter', 'dom', 'nested'] as const) {
      for (let trial = 1; trial <= 2; trial++) {
        await t.test(`${mode.name}, ${value}, trial ${trial}`, async () => {
          const page = await browser.newPage({ baseUrl }, setupMs)
          try {
            assert.ok(page instanceof FirefoxPage, 'the probe uses the actual Firefox browsing context')
            if (mode.events.length > 0) await wire.command('session.subscribe', { events: mode.events, contexts: [page.context], ...mode.options }, empty)
            assert.ok((await page.execute({ kind: 'goto', url: '/' }, setupMs)).ok)
            wire.entries.length = 0
            const target = { context: page.context }
            await wire.command('script.evaluate', { expression: `console.log(probeValue(${JSON.stringify(value)}))`, target, awaitPromise: false, serializationOptions: { maxObjectDepth: 0 } }, evaluated)
            const logging = mode.events.some((event) => event === 'log.entryAdded')
            if (logging) {
              const bound = performance.now() + setupMs
              while (wire.entries.length === 0 && performance.now() < bound) await delay(10)
              assert.equal(wire.entries.length, 1, 'the entry arrived before reading the marker')
              assert.equal(wire.entries[0]?.source.context, page.context)
              assert.deepEqual(wire.entries[0]?.args.map((arg) => arg.type), [value === 'plain' || value === 'getter' || value === 'nested' ? 'object' : value === 'dom' ? 'node' : value])
            } else await delay(150)
            const read = await wire.command('script.evaluate', { expression: `JSON.stringify({ title: document.title, getterReads })`, target, awaitPromise: false }, scriptResult)
            const mutation = logging && (value === 'getter' || value === 'nested')
            assert.equal(read.result.value, JSON.stringify({ title: mutation ? 'getter ran' : 'untouched', getterReads: mutation ? 1 : 0 }))
            if (mode.name === 'log primitive filter' && mutation) {
              const primitiveEntries = wire.entries.filter((entry) => entry.args.every((arg) => arg.type === 'string' || arg.type === 'number'))
              assert.deepEqual(primitiveEntries, [], 'discarding the object entry did not prevent its already-observed getter mutation')
            }
            assert.equal(wire.entries.length, logging ? 1 : 0)
            if (mode.events.length > 0) await wire.command('session.unsubscribe', { events: mode.events, contexts: [page.context] }, empty)
          } finally { await page.dispose(closeMs) }
        })
      }
    }
  }
  for (const maxObjectDepth of [0, 1]) {
    await t.test(`script result depth ${maxObjectDepth} is honoured independently of log events`, async () => {
      const page = await browser.newPage({ baseUrl }, setupMs)
      try {
        assert.ok(page instanceof FirefoxPage)
        assert.ok((await page.execute({ kind: 'goto', url: '/' }, setupMs)).ok)
        const target = { context: page.context }
        await wire.command('script.evaluate', { expression: `probeValue('getter')`, target, awaitPromise: false, serializationOptions: { maxObjectDepth } }, evaluated)
        const read = await wire.command('script.evaluate', { expression: `JSON.stringify({ title: document.title, getterReads })`, target, awaitPromise: false }, scriptResult)
        assert.equal(read.result.value, JSON.stringify({ title: maxObjectDepth === 0 ? 'untouched' : 'getter ran', getterReads: maxObjectDepth === 0 ? 0 : 1 }))
      } finally { await page.dispose(closeMs) }
    })
  }
})
