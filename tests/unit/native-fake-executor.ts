import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { Schema } from '../../src/protocol/schema.ts'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { isPlainObject, parse, s } from '../../src/protocol/schema.ts'

// A stand-in for an XCTest executor's HTTP server, close to how WebDriverAgent and the macOS runner answer: W3C JSON
// with `value`, one active session that a new session replaces, the `/wda/apps/*` lifecycle with XCTest's numbered
// states, captures as base64 PNG, and a tree with the app at its root. An app's process is a real `sleep` the server
// starts at launch and records in `apps.json`, so the operating-system checks see a real pid that can die. A route can
// be told to hang, drop its connection, answer late or answer with an error.

/** How one route misbehaves. */
export type RouteBehaviour = { hang?: boolean; drop?: boolean; delayMs?: number; error?: string; garbage?: boolean; exitProcess?: boolean }

/** The stand-in's settings, read from `config.json` in its folder on every request. */
export type FakeExecutorConfig = {
  routes?: Record<string, RouteBehaviour>
  /** The tree's root names this app; another name makes the tree another app's. */
  appName?: string
  /** The main screen in points; captures are this size times `scale`. */
  screen?: { width: number; height: number; scale: number }
  window?: { x: number; y: number; width: number; height: number }
  /** A launched app's process ends this many milliseconds after the launch, as an app that crashes. */
  crashAfterMs?: number
  /** The command line `ps` shows for a launched app, as for a Mac app macOS moved elsewhere before it ran. */
  appCommand?: string
}

/** One app's record: its process while it runs, the command line `ps` shows for it, and whether it is installed. */
export type FakeApp = { pid?: number; command?: string; installed?: boolean }

const behaviourSchema: Schema<RouteBehaviour> = s.object({ hang: s.optional(s.boolean()), drop: s.optional(s.boolean()), delayMs: s.optional(s.number()), error: s.optional(s.string()), garbage: s.optional(s.boolean()), exitProcess: s.optional(s.boolean()) })
const rectSchema = s.object({ x: s.number(), y: s.number(), width: s.number(), height: s.number() })
const configSchema: Schema<FakeExecutorConfig> = s.object({
  routes: s.optional(s.record(behaviourSchema)),
  appName: s.optional(s.string()),
  screen: s.optional(s.object({ width: s.number(), height: s.number(), scale: s.number() })),
  window: s.optional(rectSchema),
  crashAfterMs: s.optional(s.number()),
  appCommand: s.optional(s.string()),
})
const appsSchema: Schema<Record<string, FakeApp>> = s.record(s.object({ pid: s.optional(s.number()), command: s.optional(s.string()), installed: s.optional(s.boolean()) }))

/** Reads a JSON file, or undefined when it is missing or not JSON. */
export function readJsonFile(path: string): unknown {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return value
  } catch {
    return undefined
  }
}

/** The stand-in's settings in `folder`; none when the file is missing. */
export function readConfig(folder: string): FakeExecutorConfig {
  const parsed = parse(configSchema, readJsonFile(join(folder, 'config.json')) ?? {})
  if (!parsed.ok) throw new Error(`config.json: ${parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`)
  return parsed.value
}

/** The apps the stand-in and the fake tools share in `folder`. */
export function readApps(folder: string): Record<string, FakeApp> {
  const parsed = parse(appsSchema, readJsonFile(join(folder, 'apps.json')) ?? {})
  return parsed.ok ? parsed.value : {}
}

/** Writes a shared file whole, so a reader never sees half of it. */
export function writeJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(temporary, JSON.stringify(value))
  renameSync(temporary, path)
}

/** Whether a process exists. */
export function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The app key a lifecycle body names: its bundle id or its path. */
function appKey(body: Record<string, unknown>): string {
  return typeof body['bundleId'] === 'string' ? body['bundleId'] : typeof body['path'] === 'string' ? body['path'] : ''
}

/** A small PNG of solid pixels, `width` by `height`, with a second colour in its first row so it is not one colour. */
export function solidPng(width: number, height: number): Uint8Array {
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const offset = row * (width * 4 + 1) + 1 + column * 4
      raw.set(row === 0 ? [255, 0, 0, 255] : [20, 40, 60, 255], offset)
    }
  }
  const chunk = (type: string, data: Uint8Array): Buffer => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'ascii')
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
    return Buffer.concat([head, data, tail])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))])
}

/** A running stand-in. */
export type FakeExecutor = { readonly port: number; readonly server: Server; close(): Promise<void> }

/**
 * Starts the stand-in on 127.0.0.1. Its files live in `folder`: `config.json` it reads, `apps.json` it shares with the
 * fake tools, and `requests.jsonl` where it writes every request with the number in flight at the time.
 */
export async function startFakeExecutor(options: { readonly folder: string; readonly port?: number; readonly host?: string; readonly onShutdown?: () => void }): Promise<FakeExecutor> {
  const { folder } = options
  let session: string | undefined
  let sessions = 0
  let inFlight = 0
  const sockets = new Set<Socket>()
  const server = createServer((request, response) => {
    inFlight += 1
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const parsed: unknown = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const body = isPlainObject(parsed) ? parsed : {}
      appendFileSync(join(folder, 'requests.jsonl'), `${JSON.stringify({ method: request.method, path: request.url, body: JSON.stringify(body), inFlight, at: Date.now() })}\n`)
      void answer(request, response, body).finally(() => {
        inFlight -= 1
      })
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  const config = (): FakeExecutorConfig => readConfig(folder)
  const apps = (): Record<string, FakeApp> => readApps(folder)
  const setApp = (key: string, app: FakeApp): void => writeJson(join(folder, 'apps.json'), { ...apps(), [key]: app })
  const running = (key: string): boolean => alive(apps()[key]?.pid)

  async function answer(request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>): Promise<void> {
    const method = request.method ?? 'GET'
    const path = request.url ?? '/'
    const route = `${method} ${path.replace(/\/session\/[^/]+/, '/session/:session').replace(/\/element\/[^/]+/, '/element/:element')}`
    const behaviour = config().routes?.[route] ?? {}
    if (behaviour.exitProcess === true) process.exit(65)
    if (behaviour.hang === true) return
    if (behaviour.drop === true) {
      request.socket.destroy()
      return
    }
    if (behaviour.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs))
    const send = (status: number, value: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ value, sessionId: session ?? null }))
    }
    if (behaviour.garbage === true) {
      response.end('<html>not json</html>')
      return
    }
    if (behaviour.error !== undefined) return send(500, { error: behaviour.error, message: `the stand-in was told to answer ${behaviour.error}`, traceback: '' })
    if (route === 'GET /status') return send(200, { ready: true, message: 'WebDriverAgent is ready to accept commands', state: 'success', os: { version: 'Fake OS 1.0' } })
    if (route === 'DELETE /' || route === 'GET /wda/shutdown') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('Shutting down')
      setTimeout(() => options.onShutdown?.(), 20)
      return
    }
    if (route === 'POST /session') {
      sessions += 1
      session = `session-${sessions}`
      return send(200, { sessionId: session, capabilities: {} })
    }
    const named = /^\/session\/([^/]+)/.exec(path)?.[1]
    if (named !== undefined && named !== session) return send(404, { error: 'invalid session id', message: `Session does not exist: ${named}` })
    const key = appKey(body)
    switch (route) {
      case 'DELETE /session/:session':
        session = undefined
        return send(200, null)
      case 'POST /session/:session/wda/apps/launch':
      case 'POST /session/:session/wda/apps/activate': {
        // XCTest launches an app that is not running even when asked only to activate it.
        if (!running(key)) {
          const child = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' })
          child.unref()
          // A Mac app launched by path shows in ps as its executable inside the bundle; a simulator's app as its
          // executable inside the simulator's app container.
          const command = config().appCommand ?? (key.endsWith('.app') ? `${key}/Contents/MacOS/${key.slice(key.lastIndexOf('/') + 1, -'.app'.length)}` : `/fake/CoreSimulator/Devices/simulator/data/Containers/Bundle/Application/X/${key}.app/${key}`)
          if (child.pid !== undefined) setApp(key, { ...apps()[key], pid: child.pid, command })
          const crash = config().crashAfterMs
          if (crash !== undefined) setTimeout(() => child.pid !== undefined && alive(child.pid) && process.kill(child.pid, 'SIGKILL'), crash)
        }
        return send(200, null)
      }
      case 'POST /session/:session/wda/apps/terminate': {
        const pid = apps()[key]?.pid
        const was = alive(pid)
        if (was && pid !== undefined) process.kill(pid, 'SIGTERM')
        await new Promise((resolve) => setTimeout(resolve, 30))
        return send(200, was)
      }
      case 'POST /session/:session/wda/apps/state':
        return send(200, running(key) ? 4 : 1)
      case 'GET /session/:session/window/rect': {
        const screen = config().screen ?? { width: 40, height: 30, scale: 2 }
        return send(200, { x: 0, y: 0, width: screen.width, height: screen.height })
      }
      case 'GET /session/:session/screenshot': {
        const screen = config().screen ?? { width: 40, height: 30, scale: 2 }
        return send(200, Buffer.from(solidPng(screen.width * screen.scale, screen.height * screen.scale)).toString('base64'))
      }
      case 'GET /session/:session/source': {
        const name = config().appName ?? 'FakeApp'
        const window = config().window ?? { x: 4, y: 3, width: 20, height: 10 }
        return send(200, `<?xml version="1.0" encoding="UTF-8"?><XCUIElementTypeApplication title="${name}" label="${name}"><XCUIElementTypeMenuBar><XCUIElementTypeMenuItem title="Recent Items: secret-file.txt"/></XCUIElementTypeMenuBar><XCUIElementTypeWindow title="${name}" x="${window.x}" y="${window.y}" width="${window.width}" height="${window.height}"><XCUIElementTypeButton label="Save" identifier="save"/></XCUIElementTypeWindow></XCUIElementTypeApplication>`)
      }
      default:
        return send(404, { error: 'unknown command', message: `Unhandled endpoint: ${route}` })
    }
  }

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve))
  const address = server.address()
  const port = address !== null && typeof address === 'object' ? address.port : 0
  return {
    port,
    server,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

/** One request the stand-in received; `body` is its JSON text. */
export type ReceivedRequest = { method: string; path: string; body: string; inFlight: number; at: number }

const receivedSchema: Schema<ReceivedRequest> = s.object({ method: s.string(), path: s.string(), body: s.string(), inFlight: s.number(), at: s.number() })

/** The requests the stand-in received, in order. */
export function readRequests(folder: string): ReceivedRequest[] {
  const path = join(folder, 'requests.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter((line) => line.length > 0).map((line) => {
    const parsed = parse(receivedSchema, JSON.parse(line))
    if (!parsed.ok) throw new Error(`requests.jsonl: ${parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`)
    return parsed.value
  })
}
