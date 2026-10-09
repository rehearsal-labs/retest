import type { TestContext } from 'node:test'
import type { LoadedStart } from '../../src/config/loaded.ts'
import type { AppServerHandle } from '../../src/runner/app-server.ts'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { AppServerError, probeReady, startAppServer } from '../../src/runner/app-server.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { isGoneWithin, isRunning } from '../support/run-harness.ts'
import { tempFolder } from '../support/temp-folder.ts'

const serverScript = fileURLToPath(new URL('../support/http-server.ts', import.meta.url))
const node = JSON.stringify(process.execPath)
const started: AppServerHandle[] = []

after(async () => {
  for (const server of started) await server.stop(1000)
})

async function freePort(): Promise<number> {
  const server = createTcpServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  assert.ok(address !== null && typeof address === 'object')
  return address.port
}

// A port no other test can take while this one runs, where nothing answers: each connection is closed at once, as
// a refused one would be. A port from freePort() is free again at once, and another file's server may take it.
async function heldPort(t: TestContext): Promise<number> {
  const holder = createTcpServer((socket) => socket.destroy())
  t.after(() => holder.close())
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve))
  const address = holder.address()
  assert.ok(address !== null && typeof address === 'object')
  return address.port
}

// A server reported ready where none should be is stopped, so a failing test leaves no process that keeps this
// file from ending.
function unexpectedlyReady(server: AppServerHandle): never {
  started.push(server)
  assert.fail(`the server was reported ${server.status}`)
}

async function listening(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return address.port
}

function startOf(command: string, port: number, cwd = tempFolder('app-')): LoadedStart {
  return { command, ready: `http://127.0.0.1:${port}/health`, cwd }
}

function serverCommand(port: number, delayMs = 0, printed?: string): string {
  return [node, JSON.stringify(serverScript), port, delayMs, ...(printed === undefined ? [] : [printed])].join(' ')
}

function logIn(name: string): string {
  return join(tempFolder('logs-'), 'logs', `app-${name}.log`)
}

// The server script prints its own process id, which is not the shell's.
function printedPid(log: string): number {
  const pid = /pid (\d+)/.exec(readFileSync(log, 'utf8'))?.[1]
  assert.ok(pid !== undefined, 'the server printed its process id')
  return Number(pid)
}

// Whether a server process has ended. macOS's sh runs the command in its own place, so the server is this process's
// child, reaped once it is killed. Debian's dash forks it instead: killed after its shell, it is an orphan that stays a
// zombie until the container's init reaps it, ended though its pid still answers.
function hasEnded(pid: number): boolean {
  if (!isRunning(pid)) return true
  if (process.platform === 'darwin') return false
  return spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim().startsWith('Z')
}

// Ends a server a failing test left running, so the file still ends: only while that pid still runs the test server.
function endLeftOver(pid: number): void {
  if (!isRunning(pid)) return
  const command = spawnSync('/bin/ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).stdout
  if (command.includes(serverScript)) process.kill(pid, 'SIGKILL')
}

// Resolves once the server has printed its process id, or after `timeoutMs`, when `printedPid` then says it did not.
async function pidPrinted(log: string, timeoutMs = 5000): Promise<void> {
  const end = performance.now() + timeoutMs
  while (!(existsSync(log) && /pid \d+/.test(readFileSync(log, 'utf8'))) && performance.now() < end) await delay(10)
}

describe('probeReady', () => {
  test('any HTTP answer counts, whatever its status', async (t) => {
    const server = createServer((_request, response) => {
      response.statusCode = 500
      response.end()
    })
    t.after(() => server.close())
    assert.equal(await probeReady(`http://127.0.0.1:${await listening(server)}/`, 1000), true)
  })

  test('a refused connection, a server that never answers, or an address that is not http do not', async (t) => {
    assert.equal(await probeReady(`http://127.0.0.1:${await freePort()}/`, 1000), false)
    const silent = createTcpServer((socket) => socket.on('error', () => undefined))
    t.after(() => silent.close())
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    const address = silent.address()
    assert.ok(address !== null && typeof address === 'object')
    const before = performance.now()
    assert.equal(await probeReady(`http://127.0.0.1:${address.port}/`, 200), false)
    assert.ok(performance.now() - before < 1000, 'it gave up at its timeout')
    assert.equal(await probeReady('ftp://127.0.0.1/', 200), false)
    assert.equal(await probeReady('not a url', 200), false)
  })
})

describe('startAppServer', () => {
  test('starts the command in its own process group, waits for ready, logs its output, and stops the whole group', async () => {
    const port = await freePort()
    const logFile = logIn('web')
    const server = await startAppServer({ name: 'web', start: startOf(serverCommand(port, 150), port), logFile }, 5000)
    started.push(server)
    assert.ok(server.status === 'started' && isRunning(server.pid), 'the shell leads a live group')
    const pid = printedPid(logFile)
    assert.equal(await probeReady(`http://127.0.0.1:${port}/`, 1000), true)
    await server.stop(1000)
    assert.equal(await isGoneWithin(pid, 1000), true, 'the server process is gone')
    assert.equal(await isGoneWithin(server.pid, 1000), true, 'its shell is gone')
    assert.equal(await probeReady(`http://127.0.0.1:${port}/`, 500), false)
    assert.match(readFileSync(logFile, 'utf8'), new RegExp(`listening on ${port}\\n`))
  })

  // A shell replaces itself with a single command at once, too fast to catch at launch; here it first waits, so the
  // launch is recorded while it is still the shell and the server later holds the shell's pid under its own command.
  test('a shell that replaces itself with the server after the launch is recorded still has its server stopped', async (t) => {
    const port = await freePort()
    const logFile = logIn('replaced')
    const server = await startAppServer({ name: 'web', start: startOf(`sleep 0.3 && exec ${serverCommand(port)}`, port), logFile }, 5000)
    const pid = printedPid(logFile)
    t.after(() => endLeftOver(pid))
    assert.ok(server.status === 'started')
    assert.equal(pid, server.pid, 'the shell became the server, keeping its pid')
    await server.stop(1000)
    assert.equal(await isGoneWithin(pid, 1000), true, 'the server is gone')
    assert.equal(await probeReady(`http://127.0.0.1:${port}/`, 500), false)
  })

  test('a shell that became the server is still stopped when the server never answers', async (t) => {
    const port = await heldPort(t)
    const logFile = logIn('replaced-slow')
    const start = startOf(`sleep 0.3 && exec ${serverCommand(port, 60_000)}`, port)
    // The server starts listening only after a minute, so it is surely the shell's replacement when the wait ends.
    const error = await startAppServer({ name: 'web', start, logFile }, 1500).then(unexpectedlyReady, (thrown: unknown) => thrown)
    const pid = printedPid(logFile)
    t.after(() => endLeftOver(pid))
    assert.ok(error instanceof AppServerError)
    assert.deepEqual(error.failure, {
      class: 'setup_failed',
      message: `The server for web did not answer at http://127.0.0.1:${port}/health within 1500 ms. Its output is in ${logFile}.`,
    })
    assert.equal(await isGoneWithin(pid, 1000), true, 'the server is gone')
  })

  test('reuses a server that already answers, and never stops it', async (t) => {
    const running = createServer((_request, response) => response.end('up'))
    t.after(() => running.close())
    const port = await listening(running)
    const logFile = logIn('reused')
    const server = await startAppServer({ name: 'web', start: startOf('exit 9', port), logFile }, 5000)
    assert.equal(server.status, 'reused')
    await server.stop(1000)
    assert.equal(await probeReady(`http://127.0.0.1:${port}/`, 1000), true, 'the server still answers')
    assert.equal(existsSync(logFile), false, 'no command ran, so there is no log')
  })

  test('a server that never becomes ready fails as setup, and its group is ended', async (t) => {
    const port = await heldPort(t)
    const logFile = logIn('slow')
    const start = startOf(serverCommand(port, 60_000), port)
    const error = await startAppServer({ name: 'web', start, logFile }, 700).then(unexpectedlyReady, (thrown: unknown) => thrown)
    assert.ok(error instanceof AppServerError)
    assert.deepEqual(error.failure, {
      class: 'setup_failed',
      message: `The server for web did not answer at http://127.0.0.1:${port}/health within 700 ms. Its output is in ${logFile}.`,
    })
    assert.equal(await isGoneWithin(printedPid(logFile), 1000), true)
  })

  test('a server that exits before it is ready says how it ended', async (t) => {
    const port = await heldPort(t)
    const error = await startAppServer({ name: 'web', start: startOf('exit 3', port), logFile: logIn('exits') }, 5000).then(
      unexpectedlyReady,
      (thrown: unknown) => thrown,
    )
    assert.ok(error instanceof AppServerError)
    assert.match(error.failure.message, /^The server for web exited with exit code 3 before http:\/\/127\.0\.0\.1:\d+\/health answered\./)
  })

  test('a server that ignores SIGTERM is killed after the grace it was given', async () => {
    const port = await freePort()
    const logFile = logIn('stubborn')
    const script = `process.on('SIGTERM', () => {}); require('node:http').createServer((q, r) => r.end()).listen(${port}, '127.0.0.1'); console.log('pid', process.pid)`
    const server = await startAppServer({ name: 'web', start: startOf(`${node} -e ${JSON.stringify(script)}`, port), logFile }, 5000)
    started.push(server)
    const pid = printedPid(logFile)
    const before = performance.now()
    await server.stop(200)
    assert.equal(hasEnded(pid), true)
    assert.ok(performance.now() - before < 2000, 'SIGKILL followed the grace')
  })

  test('hides secret values in the log', async () => {
    const port = await freePort()
    const logFile = logIn('secret')
    const redactor = new Redactor()
    redactor.learn('password', 'hunter2')
    const server = await startAppServer({ name: 'web', start: startOf(serverCommand(port, 0, 'hunter2'), port), logFile, redactor }, 5000)
    started.push(server)
    await server.stop(1000)
    const log = readFileSync(logFile, 'utf8')
    assert.match(log, /password is \{\{password\}\}\n/)
    assert.ok(!log.includes('hunter2'))
  })

  test('stops waiting, and ends the group, when the run is interrupted', async (t) => {
    const port = await heldPort(t)
    const logFile = logIn('interrupted')
    const controller = new AbortController()
    // Interrupts once the server is up and waiting to listen, however long Node takes to start on a busy machine.
    void pidPrinted(logFile).then(() => controller.abort())
    const error = await startAppServer({ name: 'web', start: startOf(serverCommand(port, 60_000), port), logFile, signal: controller.signal }, 10_000).then(
      unexpectedlyReady,
      (thrown: unknown) => thrown,
    )
    assert.ok(error instanceof AppServerError)
    assert.deepEqual(error.failure, { class: 'interrupted', message: 'Starting the server for web was interrupted.' })
    assert.equal(await isGoneWithin(printedPid(logFile), 1000), true)
  })

  test('a server still running when the process exits is ended by the exit hook', async () => {
    const port = await freePort()
    const script = fileURLToPath(new URL('../support/exit-with-server.ts', import.meta.url))
    const child = spawn(process.execPath, ['--conditions=retest-source', script, tempFolder('exit-'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] })
    let printed = ''
    child.stdout.setEncoding('utf8').on('data', (text: string) => (printed += text))
    const code = await new Promise<number | null>((resolve) => child.once('close', resolve))
    assert.equal(code, 0)
    const pid = Number(/server (\d+)/.exec(printed)?.[1])
    assert.ok(pid > 0, 'the server was started')
    assert.equal(await isGoneWithin(pid, 2000), true, 'the server did not outlive the process that started it')
  })

  test('a folder that does not exist fails before anything starts', async () => {
    const port = await freePort()
    const cwd = join(tempFolder('app-'), 'missing')
    const error = await startAppServer({ name: 'web', start: startOf('true', port, cwd), logFile: logIn('nowhere') }, 1000).catch((thrown: unknown) => thrown)
    assert.ok(error instanceof AppServerError)
    assert.equal(error.failure.message, `The folder the server for web starts in, ${cwd}, does not exist.`)
  })
})
