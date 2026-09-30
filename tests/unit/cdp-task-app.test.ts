import type { TestContext } from 'node:test'
import type { TaskApp, TaskAppOptions } from '../../fixtures/task-app/server.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { LOCATORS_PAGE, ROW_COUNT } from '../../fixtures/task-app/locators-page.ts'
import { SAVE_BUTTON } from '../../fixtures/task-app/page.ts'
import { SERVICE_WORKER, SERVICE_WORKER_PAGE } from '../../fixtures/task-app/service-worker.ts'
import { startTaskApp } from '../../fixtures/task-app/server.ts'
import { REMEMBER_COOKIE, SESSION_COOKIE, TASK_APP_PASSWORD } from '../../fixtures/task-app/sign-in.ts'

const CLI = fileURLToPath(new URL('../../fixtures/task-app/cli.ts', import.meta.url))

async function start(t: TestContext, options?: TaskAppOptions): Promise<TaskApp> {
  const app = await startTaskApp(options)
  t.after(() => app.close())
  return app
}

async function page(app: TaskApp): Promise<string> {
  const response = await fetch(`${app.url}/`)
  assert.equal(response.status, 200)
  return response.text()
}

function save(app: TaskApp, body: string): Promise<Response> {
  return fetch(`${app.url}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
}

async function savedTitle(app: TaskApp, title: string): Promise<unknown> {
  const response = await save(app, JSON.stringify({ title }))
  assert.equal(response.status, 200)
  return response.json()
}

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!(await condition())) {
    if (performance.now() > deadline) assert.fail(`condition not met within ${timeoutMs} ms`)
    await delay(5)
  }
}

test('serves one page with the three controls, no external resources and no caching', async (t) => {
  const app = await start(t)
  assert.match(app.url, /^http:\/\/127\.0\.0\.1:\d+$/)
  const response = await fetch(`${app.url}/`)
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const html = await response.text()
  assert.match(html, /<input id="task-title" data-testid="task-title" autocomplete="off">/)
  assert.equal(html.split(SAVE_BUTTON).length - 1, 1)
  assert.match(html, /<p data-testid="saved-task"><\/p>/)
  assert.match(html, /'Saving…'/)
  assert.doesNotMatch(html, /https?:\/\//)
})

test('saves a task and counts one submission per save', async (t) => {
  const app = await start(t)
  assert.deepEqual(await savedTitle(app, 'Release checklist'), { title: 'Release checklist' })
  assert.equal(app.submissions(), 1)
  const count = await fetch(`${app.url}/api/submissions`)
  assert.deepEqual(await count.json(), { count: 1 })
})

test('broken mode saves the title without its last character', async (t) => {
  const app = await start(t, { mode: 'broken' })
  assert.deepEqual(await savedTitle(app, 'Release checklist'), { title: 'Release checklis' })
  assert.deepEqual(await savedTitle(app, 'Launch 🚀'), { title: 'Launch ' })
  assert.deepEqual(await savedTitle(app, ''), { title: '' })
  assert.equal(app.submissions(), 3)
})

test('delayed mode counts a save at once and answers it after the delay', async (t) => {
  const app = await start(t, { mode: 'delayed', delayMs: 200 })
  const started = performance.now()
  let answered = false
  const reply = save(app, JSON.stringify({ title: 'Later' })).then((response) => {
    answered = true
    return response.json()
  })
  await until(() => app.submissions() === 1)
  assert.equal(answered, false)
  assert.deepEqual(await reply, { title: 'Later' })
  assert.ok(performance.now() - started >= 195)
})

test('delayed mode waits 1500 ms unless told otherwise', async (t) => {
  const app = await start(t, { mode: 'delayed' })
  const started = performance.now()
  assert.deepEqual(await savedTitle(app, 'Later'), { title: 'Later' })
  assert.ok(performance.now() - started >= 1495)
})

test('each page mode adds its own change and keeps one save button unless it duplicates it', async (t) => {
  const pages = new Map<string, string>()
  for (const mode of ['duplicate', 'overlay', 'disabled', 'readonly', 'replaced', 'covered-on-press', 'covered-on-hover'] as const) {
    pages.set(mode, await page(await start(t, { mode })))
  }
  const count = (html: string | undefined, part: string) => (html ?? '').split(part).length - 1

  assert.equal(count(pages.get('duplicate'), SAVE_BUTTON), 2)
  assert.match(pages.get('overlay') ?? '', /<\/main>\n<div style="position: fixed; inset: 0"><\/div>/)
  assert.match(pages.get('disabled') ?? '', /data-testid="task-title" autocomplete="off" disabled value="Existing task">/)
  assert.match(pages.get('readonly') ?? '', /data-testid="task-title" autocomplete="off" readonly value="Existing task">/)
  assert.match(pages.get('replaced') ?? '', /replaceWith\(next\)[\s\S]*}, 300\)\)/)
  assert.match(pages.get('covered-on-press') ?? '', /addEventListener\('pointerdown', \(\) => \{\n  const cover/)
  assert.match(pages.get('covered-on-hover') ?? '', /addEventListener\('pointerover'[\s\S]*addEventListener\('click', [\s\S]*save\(\)\n}, true\)/)
  for (const [mode, html] of pages) {
    if (mode !== 'duplicate') assert.equal(count(html, SAVE_BUTTON), 1, mode)
  }
})

test('the hang route starts a page and never finishes it', async (t) => {
  const app = await startTaskApp()
  const response = await fetch(`${app.url}/hang`)
  assert.equal(response.status, 200)
  assert.ok(response.body)
  const reader = response.body.getReader()
  const first = await reader.read()
  assert.equal(first.done, false)
  const rest = reader.read().then(
    () => 'finished',
    () => 'cut off',
  )
  assert.equal(await Promise.race([rest, delay(200, 'still open')]), 'still open')

  await app.close()
  assert.equal(await rest, 'cut off')
  t.diagnostic('close() returned with a hanging response open')
})

test('refuses a save without a string title and does not count it', async (t) => {
  const app = await start(t)
  for (const body of ['not json', '[]', '{"title":5}', '{}']) {
    const response = await save(app, body)
    assert.equal(response.status, 400, body)
    await response.body?.cancel()
  }
  assert.equal(app.submissions(), 0)
})

test('answers routes it does not know with 404', async (t) => {
  const app = await start(t)
  const routes: [method: string, path: string][] = [['GET', '/nowhere'], ['GET', '/api/tasks'], ['POST', '/']]
  for (const [method, path] of routes) {
    const response = await fetch(`${app.url}${path}`, { method })
    assert.equal(response.status, 404, `${method} ${path}`)
    await response.body?.cancel()
  }
})

test('refuses a delay the mode does not use or that is not a whole number of milliseconds', async () => {
  await assert.rejects(startTaskApp({ mode: 'ok', delayMs: 10 }), TypeError)
  await assert.rejects(startTaskApp({ mode: 'delayed', delayMs: -1 }), RangeError)
  await assert.rejects(startTaskApp({ mode: 'delayed', delayMs: 1.5 }), RangeError)
})

test('closing drops a pending delayed reply at once and is safe to repeat', async () => {
  const app = await startTaskApp({ mode: 'delayed', delayMs: 60_000 })
  const reply = save(app, JSON.stringify({ title: 'Never' })).then(
    () => 'answered',
    () => 'cut off',
  )
  await until(() => app.submissions() === 1)
  const started = performance.now()
  await Promise.all([app.close(), app.close()])
  await app.close()
  assert.ok(performance.now() - started < 1000)
  assert.equal(await reply, 'cut off')
  await assert.rejects(fetch(`${app.url}/`))
})

test('each app counts its own submissions', async (t) => {
  const first = await start(t)
  const second = await start(t)
  await savedTitle(first, 'One')
  assert.deepEqual([first.submissions(), second.submissions()], [1, 0])
})

test('the command line prints the URL of a running app', async (t) => {
  const child = spawn(process.execPath, [CLI, '--mode', 'broken'], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  const [line] = await once(child.stdout, 'data')
  const url = String(line).trim()
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/)
  const response = await fetch(`${url}/api/tasks`, { method: 'POST', body: JSON.stringify({ title: 'Ship' }) })
  assert.deepEqual(await response.json(), { title: 'Shi' })
  t.diagnostic(`fixture command pid ${child.pid}`)
})

test('the command line refuses an unknown mode or delay with status 2', async () => {
  for (const args of [['--mode', 'sideways'], ['--mode', 'delayed', '--delay-ms', 'soon'], ['--colour']]) {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr += String(chunk)))
    const [code] = await once(child, 'exit')
    assert.equal(code, 2, args.join(' '))
    assert.match(stderr, /Usage: node fixtures\/task-app\/cli\.ts/)
  }
})

async function html(app: TaskApp, path: string, headers: Record<string, string> = {}): Promise<string> {
  const response = await fetch(`${app.url}${path}`, { headers })
  assert.equal(response.status, 200, path)
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8', path)
  assert.equal(response.headers.get('cache-control'), 'no-store', path)
  return response.text()
}

function signIn(app: TaskApp, body: unknown): Promise<Response> {
  return fetch(`${app.url}/api/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

test('serves the locator conformance page with its rows and nothing from outside', async (t) => {
  const app = await start(t)
  const page = await html(app, '/locators')
  assert.equal(page, LOCATORS_PAGE)
  assert.equal(page.split('<li>Row</li>').length - 1, ROW_COUNT)
  assert.doesNotMatch(page, /https?:\/\//)
})

test('the device page shows the user agent and client hints the request carried, as text', async (t) => {
  const app = await start(t)
  const page = await html(app, '/device', { 'user-agent': 'Agent <b>"one"</b>', 'sec-ch-ua': '"Brand";v="1"' })
  assert.match(page, /<span data-testid="user-agent-header">Agent &lt;b&gt;&quot;one&quot;&lt;\/b&gt;<\/span>/)
  assert.match(page, /<span data-testid="client-hints-header">&quot;Brand&quot;;v=&quot;1&quot;<\/span>/)
  assert.match(page, /<meta name="viewport" content="width=device-width, initial-scale=1">/)
  assert.match(await html(app, '/device'), /<span data-testid="client-hints-header"><\/span>/)
})

test('signing in with the password sets a session cookie and a cookie that remembers the user for a day', async (t) => {
  const app = await start(t)
  assert.match(await html(app, '/login'), /<input id="password" data-testid="password" type="password"/)
  const response = await signIn(app, { user: 'alice', password: TASK_APP_PASSWORD })
  assert.equal(response.status, 200)
  const [session, remember] = response.headers.getSetCookie()
  assert.match(session ?? '', new RegExp(`^${SESSION_COOKIE}=[0-9a-f-]{36}; Path=/; HttpOnly; SameSite=Lax$`))
  assert.equal(remember, `${REMEMBER_COOKIE}=alice; Path=/; Max-Age=86400; SameSite=Strict`)
  const cookie = (session ?? '').split(';')[0] ?? ''
  assert.match(await html(app, '/account', { cookie: `other=1; ${cookie}` }), /<p data-testid="account">Signed in as alice<\/p>/)
})

test('a wrong password, a missing user or a body that is not a sign-in starts no session', async (t) => {
  const app = await start(t)
  for (const body of [{ user: 'alice', password: 'wrong' }, { user: '', password: TASK_APP_PASSWORD }, { password: TASK_APP_PASSWORD }, 'alice', null]) {
    const response = await signIn(app, body)
    assert.equal(response.status, 401, JSON.stringify(body))
    assert.deepEqual(response.headers.getSetCookie(), [])
    await response.body?.cancel()
  }
})

test('the account page shows a request without a known session as signed out, and escapes the user name', async (t) => {
  const app = await start(t)
  assert.match(await html(app, '/account'), /<p data-testid="account">Signed out<\/p>/)
  assert.match(await html(app, '/account', { cookie: `${SESSION_COOKIE}=unknown` }), /Signed out/)
  const response = await signIn(app, { user: '<b>mallory</b>', password: TASK_APP_PASSWORD })
  const cookie = (response.headers.getSetCookie()[0] ?? '').split(';')[0] ?? ''
  assert.match(await html(app, '/account', { cookie }), /Signed in as &lt;b&gt;mallory&lt;\/b&gt;/)
})

test('serves a service worker for the whole origin, and the page that registers it', async (t) => {
  const app = await start(t)
  assert.equal(await html(app, '/service-worker'), SERVICE_WORKER_PAGE)
  const worker = await fetch(`${app.url}/service-worker.js`)
  assert.equal(worker.headers.get('content-type'), 'text/javascript; charset=utf-8')
  assert.equal(await worker.text(), SERVICE_WORKER)
  assert.doesNotThrow(() => new Function(SERVICE_WORKER))
})

test('the app counts every request it receives', async (t) => {
  const app = await start(t)
  assert.equal(app.requests(), 0)
  await html(app, '/')
  const missing = await fetch(`${app.url}/nowhere`)
  await missing.body?.cancel()
  assert.equal(app.requests(), 2)
})
