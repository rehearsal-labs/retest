import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomInt } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseArtifact } from '../../src/diagnostics/artifact.ts'
import { browserPath } from '../support/test-browser.ts'
import { filesHolding, hostScript, runHost, testNamed, writeProject } from './cli-harness.ts'

// The end of a run reads again what was written before a value was learned. Here the first test's page prints a code to
// its console, so the first test's diagnostics artifact holds it when it is written; only the second test reads that
// code from an inbox, and so teaches it to the run. The artifact written first must lose the code by the run's end.

const file = 'tests/late.retest.ts'

const tests = `import { expect, inbox, test } from '@rehearsal-labs/retest'

test('the page prints a code nobody has read yet', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Peek' }).click()
  await expect(page.getByTestId('peeked')).toHaveText('printed')
})

test('a later test reads the code from the inbox', async () => {
  const message = await inbox('owner').latest({ subject: 'code' })
  expect(message.text).toBe('Your code is {{code}}')
})
`

const pageText = `<!doctype html><meta charset="utf-8"><title>Peek</title><button type="button">Peek</button><p data-testid="peeked"></p>
<script>
document.querySelector('button').addEventListener('click', async () => {
  console.log('the code is ' + await (await fetch('/peek')).text())
  document.querySelector('[data-testid="peeked"]').textContent = 'printed'
})
</script>`

// The outbox gives its message as received at each look, so the test that reads it finds one sent since it started.
async function startApp(t: TestContext, code: string): Promise<string> {
  const outbox = (): string => JSON.stringify([{ subject: 'Your code', from: 'noreply@tasks.test', text: `Your code is ${code}`, codes: [code], links: [], receivedAt: Date.now() }])
  const server = createServer((request, response) => {
    const path = request.url ?? '/'
    const [type, body] = path === '/peek' ? ['text/plain', code] : path === '/outbox' ? ['application/json', outbox()] : ['text/html; charset=utf-8', pageText]
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
    response.end(body)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

test('a code learned in the last test is gone from the diagnostics the first test wrote', async (t) => {
  // Eight digits, so no number a run folder holds by chance, such as a time or a process id, reads as the code.
  const code = String(randomInt(10_000_000, 100_000_000))
  const url = await startApp(t, code)
  const config = `{
  apps: { web: chromium({ executablePath: ${JSON.stringify(browserPath())}, baseUrl: ${JSON.stringify(url)} }) },
  inboxes: { owner: async ({ signal }) => (await fetch(${JSON.stringify(`${url}/outbox`)}, { signal })).json() },
}`
  // The test browser, as the browser tests use it, so the run needs no Google Chrome of its own.
  const host = hostScript({ config, files: [file] }).replace('import { chrome, defineConfig }', 'import { chromium, defineConfig }')
  assert.ok(host.includes('import { chromium, defineConfig }'), 'the host imports the target it names')
  const root = await writeProject(t, { 'package.json': '{ "type": "module" }\n', 'host.ts': host, [file]: tests })
  const run = await runHost(t, { cwd: root, command: [process.execPath, '--conditions=retest-source', 'host.ts'] })

  assert.equal(run.exit.code, 0, run.stderr)
  const printed = testNamed(run, 'the page prints a code nobody has read yet')
  const reader = testNamed(run, 'a later test reads the code from the inbox')
  assert.deepEqual([printed.status, reader.status], ['passed', 'passed'])
  const path = printed.diagnostics?.[0]?.path
  assert.ok(path !== undefined, 'the first test wrote a diagnostics artifact')
  const reading = parseArtifact(readFileSync(join(run.output, path), 'utf8'), path)
  assert.ok(reading.ok)
  const messages = reading.lines.flatMap((line) => (line.type === 'console' ? [line.text.text] : []))
  assert.deepEqual(messages, ['the code is {{code}}'], 'the code the page printed was hidden once the run had learned it')
  assert.deepEqual(filesHolding(run.output, code), [], 'no file in the run folder holds the code')
})
