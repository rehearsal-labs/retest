import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { appLogFile } from '../../src/protocol/run-folder.ts'
import { probeReady } from '../../src/runner/app-server.ts'
import { runProject, tempProject } from '../support/project.ts'
import { eventsOfType, isGoneWithin } from '../support/run-harness.ts'

const serverScript = fileURLToPath(new URL('../support/http-server.ts', import.meta.url))

async function freePort(): Promise<number> {
  const server = createTcpServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  assert.ok(address !== null && typeof address === 'object')
  return address.port
}

function project(port: number, command: string, timeoutMs = 5000): string {
  const config = `import { chromium, defineConfig } from '@rehearsal-labs/retest'
export default defineConfig({
  apps: {
    web: chromium({
      baseUrl: 'http://127.0.0.1:${port}',
      executablePath: '/fake/chromium',
      start: { command: ${JSON.stringify(command)}, ready: 'http://127.0.0.1:${port}/', timeoutMs: ${timeoutMs} },
    }),
  },
})
`
  const tests = `import { expect, test } from '@rehearsal-labs/retest'
test('opens', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('save-task')).toBeVisible()
})
test('opens again', async ({ page }) => {
  await expect(page.getByTestId('save-task')).toBeVisible()
})
`
  return tempProject({ 'retest.config.ts': config, 'tests/web.retest.ts': tests })
}

function serverCommand(port: number, delayMs = 0): string {
  return [process.execPath, serverScript, port, delayMs].map((part) => JSON.stringify(String(part))).join(' ')
}

describe('an app with a start command', () => {
  test('is started once, before the first test that needs it, logged, and stopped when the run ends', async () => {
    const port = await freePort()
    const record = await runProject(project(port, serverCommand(port, 100)), { files: ['tests/web.retest.ts'] })
    assert.equal(record.result.exitCode, 0)
    const [started, ...others] = eventsOfType(record.events, 'app.started')
    assert.deepEqual([started?.app, started?.ready, others.length], ['web', `http://127.0.0.1:${port}/`, 0])
    const types = record.events.map((event) => event.type)
    assert.ok(types.indexOf('app.started') < types.indexOf('browser.started'))
    const log = readFileSync(join(record.folder, appLogFile('web')), 'utf8')
    const pid = Number(/pid (\d+)/.exec(log)?.[1])
    assert.equal(await isGoneWithin(pid, 1000), true, 'the server is gone')
    assert.equal(await isGoneWithin(started?.pid ?? 0, 1000), true, 'its shell is gone')
    assert.equal(await probeReady(`http://127.0.0.1:${port}/`, 500), false)
  })

  test('that already answers is reused and left running', async (t) => {
    const server = createServer((_request, response) => response.end('up'))
    const port = await freePort()
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
    t.after(() => server.close())
    const record = await runProject(project(port, 'exit 1'), { files: ['tests/web.retest.ts'] })
    assert.equal(record.result.exitCode, 0)
    assert.deepEqual(eventsOfType(record.events, 'app.reused').map((event) => event.app), ['web'])
    assert.deepEqual(eventsOfType(record.events, 'app.started'), [])
    assert.equal(await probeReady(`http://127.0.0.1:${port}/`, 1000), true)
  })

  test('that never answers keeps every test that needs it from running, as setup, without launching a browser', async () => {
    const port = await freePort()
    const record = await runProject(project(port, serverCommand(port, 60_000), 600), { files: ['tests/web.retest.ts'] })
    const [failed] = eventsOfType(record.events, 'app.failed')
    assert.equal(failed?.failure.class, 'setup_failed')
    assert.match(failed?.failure.message ?? '', new RegExp(`^The server for web did not answer at http://127\\.0\\.0\\.1:${port}/ within 600 ms\\.`))
    assert.deepEqual(record.result.files[0]?.tests.map((result) => [result.status, result.failure?.message]), [
      ['not_run', failed?.failure.message],
      ['not_run', failed?.failure.message],
    ])
    assert.equal(eventsOfType(record.events, 'app.failed').length, 1, 'it is tried once')
    assert.deepEqual([record.result.exitCode, record.browsers.length], [2, 0])
    const log = readFileSync(join(record.folder, appLogFile('web')), 'utf8')
    assert.equal(await isGoneWithin(Number(/pid (\d+)/.exec(log)?.[1]), 1000), true)
  })
})
