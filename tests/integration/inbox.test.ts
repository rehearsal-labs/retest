import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomInt } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { childLog, eventsOf, filesHolding, hostScript, runHost, testNamed, textHolds, writeProject } from './cli-harness.ts'

// Release 1, test inboxes on Chrome: a host gives each inbox as a function in its config in memory, which reads the
// app's outbox over HTTP. A test signs up, reads the code the app sent, types it into a page that asks for it, and
// opens a page that only the emailed link reaches. Neither the code nor the link's tokens reach the test file's
// process, the run folder or the output; and a code or a link meant for another origin goes nowhere.

const file = 'tests/inbox.retest.ts'

/** One message as the app's outbox holds it, in the shape an inbox's function gives. */
type Sent = { subject: string; from: string; text: string; codes: string[]; links: { url: string; text: string }[]; receivedAt: number }

type App = { url: string; requests: string[]; outbox: Sent[] }

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>${body}`
}

// The sign-up page sends a code, then asks for it; the server says whether the code typed is the one it sent.
const signUp = page(
  'Sign up',
  `<label for="email">Email</label><input id="email">
<button type="button" id="send">Send code</button>
<div id="ask" hidden><label for="code">Code</label><input id="code"><button type="button" id="verify">Verify</button></div>
<p data-testid="result"></p>
<script>
document.getElementById('send').addEventListener('click', async () => {
  await fetch('/send', { method: 'POST', body: document.getElementById('email').value })
  document.getElementById('ask').hidden = false
})
document.getElementById('verify').addEventListener('click', async () => {
  const answer = await fetch('/verify', { method: 'POST', body: document.getElementById('code').value })
  document.querySelector('[data-testid="result"]').textContent = await answer.text()
})
</script>`,
)

const elsewherePage = page('Elsewhere', '<label for="code">Code</label><input id="code">')

async function serve(t: TestContext, handle: (request: IncomingMessage, body: string, response: ServerResponse, url: string) => void): Promise<string> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(String(chunk)))
    const address = server.address()
    const url = address !== null && typeof address === 'object' ? `http://127.0.0.1:${address.port}` : ''
    handle(request, Buffer.concat(chunks).toString('utf8'), response, url)
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

function answer(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  response.end(body)
}

// The app sends the code and a sign-in link whose path and query each carry a token. Only that exact address shows the
// signed-in page. Its outbox is what the inbox's function reads.
async function startApp(t: TestContext, secrets: { code: string; token: string; key: string }): Promise<App> {
  const app: App = { url: '', requests: [], outbox: [] }
  app.url = await serve(t, (request, body, response, origin) => {
    const path = request.url ?? '/'
    app.requests.push(`${request.method ?? 'GET'} ${path}`)
    const magic = `/magic/${secrets.token}?key=${secrets.key}`
    if (request.method === 'POST' && path === '/send') {
      const link = `${origin}${magic}`
      app.outbox.unshift({ subject: 'Your sign-in code', from: 'noreply@tasks.test', text: `Your code is ${secrets.code}. Or sign in at ${link}`, codes: [secrets.code], links: [{ url: link, text: 'Sign in' }, { url: `${origin}/help`, text: 'Help' }], receivedAt: Date.now() })
      return answer(response, 200, 'text/plain', `sent to ${body === '' ? 'nobody' : 'the address'}`)
    }
    if (request.method === 'POST' && path === '/verify') return answer(response, 200, 'text/plain', body === secrets.code ? 'Verified' : 'Wrong code')
    if (path === '/outbox') return answer(response, 200, 'application/json', JSON.stringify(app.outbox))
    if (path === '/') return answer(response, 200, 'text/html; charset=utf-8', signUp)
    if (path === magic) return answer(response, 200, 'text/html; charset=utf-8', page('Signed in', '<h1>Signed in by link</h1>'))
    return answer(response, 404, 'text/plain', 'Not found')
  })
  return app
}

const tests = `import { expect, inbox, test } from '@rehearsal-labs/retest'

test('signs up with the code from the email, and signs in by its link', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Email').fill('owner@tasks.test')
  await page.getByRole('button', { name: 'Send code' }).click()
  await expect(page.getByLabel('Code')).toBeVisible()
  const message = await inbox('owner').latest({ subject: 'sign-in code' })
  console.log('the test was given', message.text, String(message.code), String(message.link()), JSON.stringify(message.links))
  expect(message.text).toBe('Your code is {{code}}. Or sign in at {{link:1}}')
  await page.getByLabel('Code').fill(message.code)
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByTestId('result')).toHaveText('Verified')
  await page.goto(message.link())
  await expect(page.getByRole('heading')).toHaveText('Signed in by link')
  await expect(page).toHaveURL(/\\/magic\\/\\{\\{link:1\\}\\}\\?key=\\{\\{link:1\\}\\}$/)
})

test('a code is never typed on an origin the inbox does not allow', async ({ page }) => {
  const message = await inbox('stranger').latest()
  await page.goto(process.env['ELSEWHERE_URL'] ?? '')
  await page.getByLabel('Code').fill(message.code)
})

test('a link to an origin the inbox does not allow never opens', async ({ page }) => {
  const message = await inbox('stranger').latest()
  await page.goto(message.link())
})
`

test('a test reads a code and a sign-in link from an inbox the host reads, and holds neither', async (t) => {
  // Eight digits, so no number a run folder holds by chance, such as a time or a process id, reads as the code.
  const secrets = { code: String(randomInt(10_000_000, 100_000_000)), token: randomBytes(12).toString('hex'), key: `k${randomBytes(6).toString('hex')}` }
  const strangerCode = String(randomInt(10_000_000, 100_000_000))
  const strangerToken = randomBytes(12).toString('hex')
  const app = await startApp(t, secrets)
  const elsewhere: string[] = []
  const elsewhereUrl = await serve(t, (request, _body, response) => {
    elsewhere.push(`${request.method ?? 'GET'} ${request.url ?? '/'}`)
    answer(response, 200, 'text/html; charset=utf-8', elsewherePage)
  })
  // The stranger inbox gives a fresh message on every look, whose link goes to the other origin.
  const stranger = `{ messages: async () => [{ subject: 'Verify elsewhere', from: 'noreply@elsewhere.test', text: 'Code ${strangerCode}', codes: ['${strangerCode}'], links: [{ url: '${elsewhereUrl}/verify/${strangerToken}', text: 'Verify' }], receivedAt: Date.now() }] }`
  const config = `{
  apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) },
  inboxes: {
    owner: async ({ signal }) => (await fetch(${JSON.stringify(`${app.url}/outbox`)}, { signal })).json(),
    stranger: ${stranger},
  },
}`
  const root = await writeProject(t, { 'package.json': '{ "type": "module" }\n', 'host.ts': hostScript({ config, files: [file], options: `testEnvironment: { ELSEWHERE_URL: ${JSON.stringify(elsewhereUrl)} },` }), [file]: tests })
  const run = await runHost(t, { cwd: root, command: [process.execPath, '--conditions=retest-source', 'host.ts'] })

  // Two tests fail on purpose, refused before anything reached the other origin: exit 1, nothing else.
  assert.equal(run.exit.code, 1, run.stderr)
  const signedIn = testNamed(run, 'signs up with the code from the email, and signs in by its link')
  assert.equal(signedIn.status, 'passed', JSON.stringify(signedIn.failure))
  assert.equal(app.requests.filter((request) => request === `GET /magic/${secrets.token}?key=${secrets.key}`).length, 1, 'Chrome opened the page only the link reaches, with its query')
  assert.ok(app.requests.includes('POST /verify'), 'the page sent the code it was given')

  const codeRefused = testNamed(run, 'a code is never typed on an origin the inbox does not allow')
  assert.deepEqual([codeRefused.status, codeRefused.failure?.class], ['failed', 'not_actionable'])
  assert.equal(
    codeRefused.failure?.message,
    `Retest did not type the code from the inbox "stranger": the page is on ${elsewhereUrl}, and it may be typed only on ${app.url}. Add the origin to the inbox's origins if it belongs there.`,
  )
  const linkRefused = testNamed(run, 'a link to an origin the inbox does not allow never opens')
  assert.deepEqual([linkRefused.status, linkRefused.failure?.class], ['failed', 'not_actionable'])
  assert.equal(
    linkRefused.failure?.message,
    `Retest did not open {{link}} from the inbox "stranger": it goes to ${elsewhereUrl}, and a link from this inbox may open only on ${app.url}. Add the origin to the inbox's origins if it belongs there.`,
  )
  assert.ok(elsewhere.includes('GET /'), 'the test opened the other origin itself')
  assert.deepEqual(elsewhere.filter((request) => request.includes('/verify')), [], 'the link to the other origin never opened')

  // The parent wrote down each read, each code typed and each link opened, by placeholder and inbox.
  assert.deepEqual(
    eventsOf(run.events, 'inbox.read').map((event) => [event.inbox, event.subject, event.wanted, event.codes, event.links, event.failure, event.origin]),
    [
      ['owner', 'Your sign-in code', 'sign-in code', 1, 2, undefined, 'parent'],
      ['stranger', 'Verify elsewhere', undefined, 1, 1, undefined, 'parent'],
      ['stranger', 'Verify elsewhere', undefined, 1, 1, undefined, 'parent'],
    ],
  )
  const actions = [...eventsOf(run.events, 'action.completed'), ...eventsOf(run.events, 'action.failed')].filter((event) => event.secret !== undefined)
  assert.deepEqual(
    actions.map((event) => [event.type, event.command, event.secret, event.inbox, event.valueLength]).toSorted(),
    [
      ['action.completed', 'fill', 'code', 'owner', undefined],
      ['action.completed', 'goto', 'link', 'owner', undefined],
      ['action.failed', 'fill', 'code', 'stranger', undefined],
      ['action.failed', 'goto', 'link', 'stranger', undefined],
    ].toSorted(),
  )
  const opened = eventsOf(run.events, 'navigation').filter((event) => event.attemptId === signedIn.attemptId).map((event) => event.url)
  assert.ok(opened.includes(`${app.url}/magic/{{link:1}}`), `the navigation records the link's origin and path, its token hidden: ${opened.join(', ')}`)

  // The test file's process was given placeholders only, and no file, event or output holds a value.
  assert.match(childLog(run, file), /the test was given Your code is \{\{code\}\}\. Or sign in at \{\{link:1\}\} \{\{code\}\} \{\{link\}\}/)
  for (const value of [secrets.code, secrets.token, secrets.key, strangerCode, strangerToken]) {
    assert.deepEqual(filesHolding(run.output, value), [], `no file in the run folder holds ${value}`)
    assert.ok(!textHolds(run.stdout, value) && !textHolds(run.stderr, value), `the output does not show ${value}`)
  }
})
