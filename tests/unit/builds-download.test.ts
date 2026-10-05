import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { addressProblem, downloadFile, mirroredUrl } from '../../src/cli/install/download.ts'
import { sha256Hex } from '../../src/shared/sha256.ts'
import { tempFolder } from '../support/temp-folder.ts'
import { listeningPort } from './builds-fixtures.ts'

// A stand-in archive server on this machine: each route answers as the test needs, and every request is counted.
type Route = (request: IncomingMessage, response: ServerResponse) => void
const routes = new Map<string, Route>()
const requests: string[] = []
let server: Server
let origin = ''

before(async () => {
  server = createServer((request, response) => {
    requests.push(request.url ?? '')
    const route = routes.get(request.url ?? '')
    if (route === undefined) {
      response.statusCode = 404
      response.end('not here')
      return
    }
    route(request, response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${listeningPort(server)}`
})
after(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const payload = Buffer.from('a stand-in archive, which is only bytes here\n'.repeat(400))
routes.set('/archive.zip', (_request, response) => {
  response.setHeader('content-length', String(payload.length))
  response.end(payload)
})
// Chunked, so no length is declared before the bytes arrive.
routes.set('/chunked.zip', (_request, response) => {
  response.write(payload.subarray(0, 1000))
  response.end(payload.subarray(1000))
})
routes.set('/stalls.zip', (_request, response) => {
  response.setHeader('content-length', String(payload.length))
  response.write(payload.subarray(0, 100))
})
routes.set('/moved.zip', (_request, response) => {
  response.statusCode = 302
  response.setHeader('location', '/archive.zip')
  response.end()
})
routes.set('/loop.zip', (_request, response) => {
  response.statusCode = 307
  response.setHeader('location', '/loop.zip')
  response.end()
})

function request(path: string, extra: { expectedSize?: number; signal?: AbortSignal; idleMs?: number; fetch?: typeof fetch; maximumBytes?: number } = {}) {
  const to = join(tempFolder('retest-download-'), 'archive.zip.partial')
  return {
    to,
    run: () => downloadFile({
      url: path.startsWith('http') ? path : `${origin}${path}`,
      to,
      expectedSize: extra.expectedSize,
      maximumBytes: extra.maximumBytes ?? 10_000_000,
      signal: extra.signal ?? new AbortController().signal,
      idleMs: extra.idleMs ?? 5000,
      totalMs: 30_000,
      userAgent: 'retest/test',
      fetch: extra.fetch,
    }),
  }
}

describe('downloading an archive', () => {
  test('writes the bytes and returns their size and SHA-256', async () => {
    const download = request('/archive.zip', { expectedSize: payload.length })
    const result = await download.run()
    assert.deepEqual(result, { ok: true, size: payload.length, sha256: sha256Hex(payload), answeredBy: `${origin}/archive.zip` })
    assert.deepEqual(readFileSync(download.to), payload)
  })

  test('refuses a declared size other than the pinned one before reading the body, and leaves no file', async () => {
    const download = request('/archive.zip', { expectedSize: payload.length + 1 })
    const result = await download.run()
    assert.deepEqual(result, { ok: false, message: `127.0.0.1:${new URL(origin).port} offers ${payload.length} bytes, and the pinned archive is ${payload.length + 1} bytes.`, stopped: false })
    assert.equal(existsSync(download.to), false)
  })

  test('stops a body that grows past the pinned size, or ends short of it, and leaves no file', async () => {
    const longer = request('/chunked.zip', { expectedSize: 500 })
    assert.deepEqual(await longer.run(), { ok: false, message: 'The archive grew past the pinned 500 bytes.', stopped: false })
    assert.equal(existsSync(longer.to), false)
    const shorter = request('/chunked.zip', { expectedSize: payload.length + 10 })
    assert.deepEqual(await shorter.run(), { ok: false, message: `The download ended after ${payload.length} bytes, and the pinned archive is ${payload.length + 10} bytes.`, stopped: false })
    assert.equal(existsSync(shorter.to), false)
    const unpinned = request('/chunked.zip', { maximumBytes: 2000 })
    assert.deepEqual(await unpinned.run(), { ok: false, message: 'The archive grew past the 2000 bytes Retest downloads for one archive.', stopped: false })
  })

  test('gives up on a server that stops sending, and on a stop, leaving no file either time', async () => {
    const stalled = request('/stalls.zip', { idleMs: 300 })
    assert.deepEqual(await stalled.run(), { ok: false, message: 'The server sent nothing for 300 ms, so the download was given up.', stopped: false })
    assert.equal(existsSync(stalled.to), false)
    const controller = new AbortController()
    const stopped = request('/stalls.zip', { signal: controller.signal })
    setTimeout(() => controller.abort(), 200)
    assert.deepEqual(await stopped.run(), { ok: false, message: 'The download was stopped.', stopped: true })
    assert.equal(existsSync(stopped.to), false)
  })

  test('says what a server answered when it is not the archive', async () => {
    const missing = request('/nothing.zip')
    assert.deepEqual(await missing.run(), { ok: false, message: `127.0.0.1:${new URL(origin).port} answered 404 for /nothing.zip.`, stopped: false })
    assert.equal(existsSync(missing.to), false)
  })

  test('follows redirects on allowed addresses only, and not for ever', async () => {
    const moved = request('/moved.zip')
    const result = await moved.run()
    assert.ok(result.ok)
    assert.equal(result.answeredBy, `${origin}/archive.zip`)
    assert.equal((await request('/loop.zip').run()).ok, false)
    assert.match(JSON.stringify(await request('/loop.zip').run()), /redirected more than 5 times/)
    const toPlainHttp: typeof fetch = async () => new Response(null, { status: 302, headers: { location: 'http://mirror.example.com/archive.zip' } })
    const refused = await request('https://downloads.example.com/archive.zip', { fetch: toPlainHttp }).run()
    assert.deepEqual(refused, { ok: false, message: 'Retest downloads only over https, or over http from this machine, and was sent to http://mirror.example.com.', stopped: false })
    const visited: string[] = []
    const toHttps: typeof fetch = async (input) => {
      const url = String(input)
      visited.push(url)
      return url.endsWith('/start.zip') ? new Response(null, { status: 301, headers: { location: 'https://objects.example.com/blob' } }) : new Response('blob bytes')
    }
    const followed = await request('https://downloads.example.com/start.zip', { fetch: toHttps }).run()
    assert.deepEqual(followed, { ok: true, size: 10, sha256: sha256Hex('blob bytes'), answeredBy: 'https://objects.example.com/blob' })
    assert.deepEqual(visited, ['https://downloads.example.com/start.zip', 'https://objects.example.com/blob'])
  })
})

describe('download addresses', () => {
  test('are https, or http to this machine, and carry no credentials', () => {
    assert.equal(addressProblem(new URL('https://github.com/electron/electron/releases/download/v44.5.1/a.zip')), undefined)
    assert.equal(addressProblem(new URL('http://127.0.0.1:4100/a.zip')), undefined)
    assert.equal(addressProblem(new URL('http://localhost:4100/a.zip')), undefined)
    assert.equal(addressProblem(new URL('http://[::1]:4100/a.zip')), undefined)
    assert.match(addressProblem(new URL('http://mirror.example.com/a.zip')) ?? '', /^Retest downloads only over https/)
    assert.match(addressProblem(new URL('ftp://mirror.example.com/a.zip')) ?? '', /^Retest downloads only over https/)
    assert.equal(addressProblem(new URL('https://user:secret@mirror.example.com/a.zip')), 'Retest does not send credentials written in an address; the address it was given carries some.')
  })

  test("put the publisher's host first under a mirror", () => {
    const source = 'https://github.com/electron/electron/releases/download/v44.5.1/electron-v44.5.1-darwin-arm64.zip'
    assert.equal(mirroredUrl(source, undefined), source)
    assert.equal(mirroredUrl(source, 'http://127.0.0.1:4100/'), 'http://127.0.0.1:4100/github.com/electron/electron/releases/download/v44.5.1/electron-v44.5.1-darwin-arm64.zip')
    assert.equal(mirroredUrl('https://archive.mozilla.org/pub/firefox/releases/133.0.3/mac/en-US/Firefox%20133.0.3.dmg', 'https://mirror.example.com/builds'), 'https://mirror.example.com/builds/archive.mozilla.org/pub/firefox/releases/133.0.3/mac/en-US/Firefox%20133.0.3.dmg')
  })
})
