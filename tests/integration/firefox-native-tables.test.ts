import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { TEAM } from '../../fixtures/task-app/workflow-lists-page.ts'
import { launchFirefox } from '../../src/browser/firefox/launch.ts'
import { isPlainObject } from '../../src/protocol/schema.ts'
import { byRole, closeMs, goto, groupExists, observe, openApp, openPage, scratchFolder, setupMs } from './browser-harness.ts'
import { firefoxPath, testFirefoxRoute } from './engines.ts'

const skip = process.platform === 'darwin' && process.arch === 'arm64' ? false : 'Firefox requires macOS on Apple silicon'
let nextId = 1_000_000

async function raw(socket: WebSocket, method: string, params: object): Promise<Record<string, unknown>> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.removeEventListener('message', heard); reject(new Error(`${method} did not answer`)) }, setupMs)
    function heard(event: MessageEvent): void {
      if (typeof event.data !== 'string') return
      const reply: unknown = JSON.parse(event.data)
      if (!isPlainObject(reply) || reply['id'] !== id) return
      clearTimeout(timer)
      socket.removeEventListener('message', heard)
      if (reply['type'] !== 'success' || !isPlainObject(reply['result'])) reject(new Error(JSON.stringify(reply)))
      else resolve(reply['result'])
    }
    socket.addEventListener('message', heard)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

test('Firefox reads every team-table row and header while refusing the absent text-named cell', { skip }, async (t) => {
  const app = await openApp(t)
  const folder = await scratchFolder(t)
  let socket: WebSocket | undefined
  const browser = await launchFirefox({ executablePath: firefoxPath(), route: testFirefoxRoute(), headless: true, logFile: join(folder, 'browser.log') }, setupMs, (url) => { socket = new WebSocket(url); return socket })
  t.after(async () => { await browser.close(closeMs); assert.equal(groupExists(browser.pid), false) })
  t.diagnostic(`Firefox ${browser.version}, build ${browser.buildId}, pid ${browser.pid}, route ${testFirefoxRoute()}`)
  const page = await openPage(t, browser, app.url)
  assert.ok((await goto(page, '/workflow/team')).ok)
  assert.ok(socket !== undefined)
  const contexts = (await raw(socket, 'browsingContext.getTree', {}))['contexts']
  assert.ok(Array.isArray(contexts))
  const context: unknown = contexts.find((entry: unknown) => isPlainObject(entry) && entry['url'] === `${app.url}/workflow/team`)
  assert.ok(isPlainObject(context) && typeof context['context'] === 'string')
  const wire = socket
  const locate = async (role: string, name?: string): Promise<number> => {
    const reply = await raw(wire, 'browsingContext.locateNodes', { context: context['context'], locator: { type: 'accessibility', value: { role, ...(name === undefined ? {} : { name }) } }, serializationOptions: { maxDomDepth: 0, includeShadowTree: 'none' } })
    assert.ok(Array.isArray(reply['nodes']))
    return reply['nodes'].length
  }
  assert.equal(await locate('row'), 7)
  assert.equal(await locate('cell'), 24)
  assert.equal(await locate('columnheader', 'Role'), 1)
  assert.equal(await locate('cell', 'Grace Hopper'), 0)
  const rows = await observe(page, byRole('row'))
  assert.equal(rows.count, 7)
  assert.deepEqual(rows.items.map((item) => item.text), ['Name Email Role Open tasks', ...TEAM.map((member) => `${member.name} ${member.email} ${member.role} ${member.tasks}`)])
  assert.equal((await observe(page, byRole('cell'))).count, 24)
  assert.equal((await observe(page, byRole('columnheader', 'Role'))).count, 1)
  assert.equal((await observe(page, byRole('table', 'Team members'))).count, 1)
  const cell = await page.execute({ kind: 'observe', locator: byRole('cell', 'Grace Hopper') }, setupMs)
  assert.deepEqual(cell, { ok: false, failure: {
    class: 'unsupported',
    message: "Could not look up getByRole('cell', { name: 'Grace Hopper' }): Chrome names a cell from its text, and Firefox's accessibility tree does not, so Retest refuses the lookup rather than find less on Firefox. Find it with getByText() or getByTestId(), or by its position with nth().",
    details: { role: 'cell' },
  } })
})
