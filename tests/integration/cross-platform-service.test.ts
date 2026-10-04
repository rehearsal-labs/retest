import type { IncomingHttpHeaders } from 'node:http'
import type { TestContext } from 'node:test'
import type { RequestRecord } from '../../fixtures/cross-platform/service/request-log.ts'
import type { TaskView } from '../../fixtures/cross-platform/service/store.ts'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { SEEDED_ACCOUNTS } from '../../fixtures/cross-platform/service/accounts.ts'
import { formatRequestLine, parseRequestRecord } from '../../fixtures/cross-platform/service/request-log.ts'
import { ASSIGNED_ID_PATTERN, SEEDED_TASKS } from '../../fixtures/cross-platform/service/store.ts'
import { signalGroup } from '../../src/browser/chromium-process.ts'
import { within } from './browser-harness.ts'
import { assertStdoutIsEvents, budgets, eventsOf, filesHolding, repositoryRoot, runProgram, runRetest, scratchFolder, testNamed, textHolds } from './cli-harness.ts'

// The cross-platform fixture's local service, started the way its README starts it, as its own process: sign-in,
// tasks by id, the sync delay, broken sync for every client or one, merged changes, reset, the state file, both
// request logs and the guards against other sites. Then the Swift both native apps compile, built and run on macOS,
// and Retest on real Chrome against the service's web front end. The apps themselves are built and launched by hand;
// see docs/plans/public-beta/proofs/fixtures.md.

const serverScript = join(repositoryRoot, 'fixtures/cross-platform/service/server.ts')
const webTests = 'fixtures/cross-platform/tests/web-tasks.retest.ts'
const raceTests = 'fixtures/cross-platform/tests/web-save-race.retest.ts'
const webConfig = 'fixtures/cross-platform/tests/retest.config.ts'
const swiftFiles = ['ServiceSettings.swift', 'TaskServiceClient.swift', 'WindowFrame.swift', 'checks/main.swift'].map((file) => join(repositoryRoot, 'fixtures/cross-platform/shared', file))
const passwordVariable = 'RETEST_CROSS_PLATFORM_PASSWORD'

/** How long any one answer, start or stop may take before the test fails naming it. */
const answerMs = 10_000
const serviceTest = { timeout: 60_000 }
const browserTest = { timeout: 180_000 }

const [ada, ben] = SEEDED_ACCOUNTS
assert.ok(ada !== undefined && ben !== undefined, 'the service seeds two accounts')

const seededForAda = SEEDED_TASKS.filter((seed) => seed.account === 'ada').map(({ id, title, done }) => ({ id, title, done, revision: 1 }))

type Exit = { code: number | null; signal: NodeJS.Signals | null }

type Service = {
  url: string
  port: number
  networkLog: string
  stdout(): string
  stderr(): string
  /** Sends SIGTERM and waits for the exit, failing if there is none within `answerMs`. */
  stop(): Promise<Exit>
}

type ServiceOptions = { flags?: readonly string[]; folder?: string }

/** Starts the service on a free port in a process group of its own, killed after the test if it is still there. */
async function startService(t: TestContext, options: ServiceOptions = {}): Promise<Service> {
  const folder = options.folder ?? (await scratchFolder(t, 'retest-cross-platform-'))
  const networkLog = join(folder, `network-${Date.now()}.jsonl`)
  const args = ['--conditions=retest-source', serverScript, '--port', '0', '--network-log', networkLog, ...(options.flags ?? [])]
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const { pid } = child
  assert.ok(pid !== undefined, 'the service did not start')
  t.after(() => signalGroup(pid, 'SIGKILL'))
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (text: string) => {
    stdout += text
  })
  child.stderr.setEncoding('utf8').on('data', (text: string) => {
    stderr += text
  })
  const exited = new Promise<Exit>((resolve) => child.on('close', (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal })))
  let exit: Exit | undefined
  void exited.then((value) => {
    exit = value
  })
  const end = performance.now() + 15_000
  let url: string | undefined
  while (url === undefined) {
    url = /^(http:\/\/127\.0\.0\.1:\d+)\n/.exec(stdout)?.[1]
    if (url !== undefined) break
    if (exit !== undefined) assert.fail(`the service exited with ${JSON.stringify(exit)} before it printed its address: ${stderr}`)
    if (performance.now() > end) assert.fail(`the service printed no address within 15 s: ${stderr}`)
    await delay(10)
  }
  const address = url
  return {
    url: address,
    port: Number(new URL(address).port),
    networkLog,
    stdout: () => stdout,
    stderr: () => stderr,
    stop: () => {
      if (exit === undefined) child.kill('SIGTERM')
      return within(exited, answerMs, `the service did not exit within ${answerMs} ms of SIGTERM`)
    },
  }
}

/** Runs the service with arguments it should refuse, and gives its exit code and stderr. */
async function refusedStart(args: readonly string[]): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, ['--conditions=retest-source', serverScript, '--port', '0', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (text: string) => {
    stderr += text
  })
  const closed = new Promise<number | null>((resolve) => child.on('close', resolve))
  try {
    return { code: await within(closed, answerMs, `the service started with ${args.join(' ')} did not exit within ${answerMs} ms`), stderr }
  } finally {
    child.kill('SIGKILL')
  }
}

type Answer = { status: number; body: unknown }

/** `client: null` sends no `x-task-client` header. */
type CallOptions = { token?: string; body?: object; client?: string | null; rawBody?: string }

async function call(service: Service, method: string, path: string, options: CallOptions = {}): Promise<Answer> {
  const headers: Record<string, string> = {}
  const client = options.client === undefined ? 'test' : options.client
  if (client !== null) headers['x-task-client'] = client
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`
  const body = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body))
  if (body !== undefined) headers['content-type'] = 'application/json'
  let text: string
  let status: number
  let isJson: boolean
  try {
    const response = await fetch(`${service.url}${path}`, { method, headers, signal: AbortSignal.timeout(answerMs), ...(body === undefined ? {} : { body }) })
    status = response.status
    isJson = (response.headers.get('content-type') ?? '').startsWith('application/json')
    text = await response.text()
  } catch (error) {
    assert.fail(`${method} ${path} got no answer within ${answerMs} ms: ${String(error)}`)
  }
  return { status, body: text === '' ? undefined : isJson ? JSON.parse(text) : text }
}

type RawAnswer = { status: number; headers: IncomingHttpHeaders }

/** A request with headers `fetch` will not send, such as another `Host`. */
function rawRequest(service: Service, method: string, path: string, headers: Record<string, string>): Promise<RawAnswer> {
  const answered = new Promise<RawAnswer>((resolve, reject) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port: service.port, method, path, headers }, (response) => {
      response.resume()
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers }))
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
  return within(answered, answerMs, `${method} ${path} with ${JSON.stringify(headers)} got no answer within ${answerMs} ms`)
}

async function signIn(service: Service, account: string, password: string, client = 'test'): Promise<string> {
  const answer = await call(service, 'POST', '/api/sign-in', { body: { account, password }, client })
  assert.equal(answer.status, 200, `sign-in as ${account}: ${JSON.stringify(answer.body)}`)
  const token = field(answer.body, 'token')
  assert.equal(typeof token, 'string')
  return String(token)
}

async function createTask(service: Service, token: string, title: string, client = 'test'): Promise<TaskView> {
  const answer = await call(service, 'POST', '/api/tasks', { token, body: { title }, client })
  assert.equal(answer.status, 201, JSON.stringify(answer.body))
  return taskIn(answer.body)
}

async function changeTask(service: Service, token: string, id: string, body: object, client = 'test'): Promise<TaskView> {
  const answer = await call(service, 'PATCH', `/api/tasks/${encodeURIComponent(id)}`, { token, body, client })
  assert.equal(answer.status, 200, `PATCH ${id}: ${JSON.stringify(answer.body)}`)
  return taskIn(answer.body)
}

async function readTask(service: Service, token: string, id: string): Promise<TaskView | undefined> {
  const answer = await call(service, 'GET', `/api/tasks/${encodeURIComponent(id)}`, { token })
  if (answer.status === 404) return undefined
  assert.equal(answer.status, 200, JSON.stringify(answer.body))
  return taskIn(answer.body)
}

async function listTasks(service: Service, token: string): Promise<TaskView[]> {
  const answer = await call(service, 'GET', '/api/tasks', { token })
  assert.equal(answer.status, 200, JSON.stringify(answer.body))
  const tasks = field(answer.body, 'tasks')
  assert.ok(Array.isArray(tasks), 'the list holds tasks')
  return tasks.map((task: unknown) => readView(task))
}

/** The task with this id in the session's list, or undefined when the list does not hold it. */
async function listed(service: Service, token: string, id: string): Promise<TaskView | undefined> {
  return (await listTasks(service, token)).find((task) => task.id === id)
}

function field(value: unknown, name: string): unknown {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), `expected an object, received ${JSON.stringify(value)}`)
  return new Map(Object.entries(value)).get(name)
}

function taskIn(body: unknown): TaskView {
  return readView(field(body, 'task'))
}

function readView(value: unknown): TaskView {
  const id = field(value, 'id')
  const title = field(value, 'title')
  const done = field(value, 'done')
  const revision = field(value, 'revision')
  const createdAt = field(value, 'createdAt')
  const updatedAt = field(value, 'updatedAt')
  assert.ok(typeof id === 'string' && typeof title === 'string' && typeof done === 'boolean', JSON.stringify(value))
  assert.ok(typeof revision === 'number' && typeof createdAt === 'string' && typeof updatedAt === 'string', JSON.stringify(value))
  return { id, title, done, revision, createdAt, updatedAt }
}

/** The fields a reader compares, without the times. */
function shape(task: TaskView | undefined): { id: string; title: string; done: boolean; revision: number } | undefined {
  return task === undefined ? undefined : { id: task.id, title: task.title, done: task.done, revision: task.revision }
}

/** Reads until `read` gives a value that is not undefined, and says when, in epoch milliseconds. */
async function firstSeen<T>(what: string, read: () => Promise<T | undefined>, timeoutMs: number): Promise<{ value: T; at: number }> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== undefined) return { value, at: Date.now() }
    assert.ok(Date.now() < end, `${what} did not happen within ${timeoutMs} ms`)
    await delay(25)
  }
}

/** Checks something over and over for `durationMs`, as a session that never sees a change would find. */
async function holdsFor(durationMs: number, check: () => Promise<void>): Promise<void> {
  const end = Date.now() + durationMs
  while (Date.now() < end) {
    await check()
    await delay(100)
  }
}

function readNetworkLog(service: Service): RequestRecord[] {
  const lines = readFileSync(service.networkLog, 'utf8').split('\n')
  assert.equal(lines.pop(), '', 'the network log ends with a whole line')
  return lines.map((line, index) => {
    const record = parseRequestRecord(line)
    assert.ok(record !== undefined, `network log line ${index + 1} is a request record: ${line}`)
    return record
  })
}

function hasSwiftCompiler(): boolean {
  if (process.platform !== 'darwin') return false
  try {
    execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore', timeout: answerMs })
    return true
  } catch {
    return false
  }
}

/** A server that answers every request with a 307 to the same path on `target`, counting what it answered. */
async function redirectingServer(t: TestContext, target: string): Promise<{ url: string; answered(): number }> {
  let answered = 0
  const server = createServer((request, response) => {
    answered += 1
    request.resume()
    response.writeHead(307, { location: `${target}${request.url ?? '/'}` })
    response.end()
  })
  server.listen(0, '127.0.0.1')
  await within(once(server, 'listening'), answerMs, 'the redirecting server did not listen')
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return { url: `http://127.0.0.1:${address.port}`, answered: () => answered }
}

test('signs in only the seeded accounts with their own passwords, and refuses the task routes without a session', serviceTest, async (t) => {
  const service = await startService(t)
  const answer = await call(service, 'POST', '/api/sign-in', { body: { account: ada.id, password: ada.password } })
  assert.equal(answer.status, 200)
  assert.deepEqual(field(answer.body, 'account'), { id: 'ada', name: 'Ada Example' })
  const token = String(field(answer.body, 'token'))

  for (const [account, password] of [
    [ada.id, ben.password],
    [ben.id, ada.password],
    ['carol', ada.password],
    [ada.id, ''],
  ] as const) {
    const refused = await call(service, 'POST', '/api/sign-in', { body: { account, password } })
    assert.deepEqual([refused.status, refused.body], [401, { error: 'Wrong account or password.' }], `${account} with another password`)
  }
  assert.equal((await call(service, 'POST', '/api/sign-in', { body: { account: ada.id } })).status, 400)
  assert.equal((await call(service, 'POST', '/api/sign-in', { rawBody: 'account=ada' })).status, 400)

  assert.equal((await call(service, 'GET', '/api/tasks')).status, 401)
  assert.equal((await call(service, 'GET', '/api/tasks', { token: 'not-a-token-the-service-gave' })).status, 401)
  assert.equal((await call(service, 'GET', '/api/tasks/seed-ada-1')).status, 401)
  assert.equal((await call(service, 'POST', '/api/tasks', { body: { title: 'Nobody' } })).status, 401)
  assert.equal((await call(service, 'GET', '/api/tasks', { token })).status, 200)

  assert.equal((await call(service, 'POST', '/api/sign-out', { token })).status, 200)
  assert.equal((await call(service, 'GET', '/api/tasks', { token })).status, 401, 'a signed-out token opens nothing')
  assert.deepEqual(await service.stop(), { code: 0, signal: null }, 'SIGTERM stops the service with exit 0')
})

test('assigns every new task an id of its own, reads and changes it by that id, and keeps the accounts apart', serviceTest, async (t) => {
  const service = await startService(t)
  const token = await signIn(service, ada.id, ada.password)
  const benToken = await signIn(service, ben.id, ben.password)

  assert.deepEqual((await listTasks(service, token)).map(shape), seededForAda)
  assert.deepEqual(
    (await listTasks(service, benToken)).map((task) => task.id),
    ['seed-ben-1'],
  )

  const first = await createTask(service, token, '  Release checklist  ')
  const second = await createTask(service, token, 'Release checklist')
  assert.match(first.id, ASSIGNED_ID_PATTERN)
  assert.match(second.id, ASSIGNED_ID_PATTERN)
  assert.notEqual(first.id, second.id, 'two tasks with one title get two ids')
  assert.deepEqual(shape(first), { id: first.id, title: 'Release checklist', done: false, revision: 1 })
  assert.deepEqual(shape(await readTask(service, token, first.id)), shape(first))

  const refusedId = await call(service, 'POST', '/api/tasks', { token, body: { title: 'Mine', id: 'task-000000000000' } })
  assert.equal(refusedId.status, 400, 'a client cannot choose the id')
  for (const body of [{ title: '' }, { title: '   ' }, { title: 7 }, { title: 'x'.repeat(201) }, { title: 'two\nlines' }, {}]) {
    assert.equal((await call(service, 'POST', '/api/tasks', { token, body })).status, 400, JSON.stringify(body))
  }

  assert.deepEqual(shape(await changeTask(service, token, first.id, { done: true })), { id: first.id, title: 'Release checklist', done: true, revision: 2 })
  const renamed = await changeTask(service, token, first.id, { title: 'Release checklist, signed off' })
  assert.deepEqual(shape(renamed), { id: first.id, title: 'Release checklist, signed off', done: true, revision: 3 })
  assert.deepEqual(shape(await readTask(service, token, second.id)), shape(second), 'the other task with the same title is unchanged')
  for (const body of [{}, { done: 'yes' }, { title: '' }, { id: 'task-000000000000' }, { done: true, colour: 'red' }]) {
    assert.equal((await call(service, 'PATCH', `/api/tasks/${first.id}`, { token, body })).status, 400, JSON.stringify(body))
  }

  assert.equal(await readTask(service, benToken, first.id), undefined, "ben cannot read ada's task")
  assert.equal(await listed(service, benToken, first.id), undefined, "ben's list does not hold ada's task")
  assert.equal((await call(service, 'PATCH', `/api/tasks/${first.id}`, { token: benToken, body: { done: false } })).status, 404)
  assert.equal(await readTask(service, token, 'task-000000000000'), undefined)
  assert.equal(await readTask(service, token, 'seed-ben-1'), undefined, "ada cannot read ben's task")
  assert.equal((await call(service, 'DELETE', `/api/tasks/${first.id}`, { token })).status, 405)
})

test('shows a change to another session only once the sync delay has passed, by id and in the list, and to its maker at once', serviceTest, async (t) => {
  const syncDelayMs = 800
  const service = await startService(t, { flags: ['--sync-delay-ms', String(syncDelayMs)] })
  const phone = await signIn(service, ada.id, ada.password, 'ios')
  const web = await signIn(service, ada.id, ada.password, 'web')

  const sentAt = Date.now()
  const created = await createTask(service, phone, 'Synced task', 'ios')
  assert.deepEqual(shape(await readTask(service, phone, created.id)), shape(created), 'its maker sees it at once')
  assert.deepEqual(shape(await listed(service, phone, created.id)), shape(created), 'in its list too')
  assert.equal(await readTask(service, web, created.id), undefined, 'another session does not see it yet')
  assert.equal(await listed(service, web, created.id), undefined, 'nor in its list')
  await delay(syncDelayMs / 2)
  assert.equal(await readTask(service, web, created.id), undefined, 'nor halfway through the delay')
  assert.equal(await listed(service, web, created.id), undefined, 'nor in its list halfway through')
  const seen = await firstSeen('the other session seeing the new task in its list', () => listed(service, web, created.id), syncDelayMs + 3000)
  assert.ok(seen.at - sentAt >= syncDelayMs, `the other session listed it ${seen.at - sentAt} ms after it was sent, before the ${syncDelayMs} ms delay`)
  assert.deepEqual(shape(seen.value), shape(created))
  assert.deepEqual(shape(await readTask(service, web, created.id)), shape(created), 'and reads it by id')

  const changedAt = Date.now()
  const changed = await changeTask(service, web, created.id, { done: true }, 'web')
  assert.deepEqual(shape(changed), { id: created.id, title: 'Synced task', done: true, revision: 2 })
  assert.deepEqual(shape(await readTask(service, phone, created.id)), shape(created), 'the phone still sees the task as it made it')
  assert.deepEqual(shape(await listed(service, phone, created.id)), shape(created), 'in its list too')
  const synced = await firstSeen('the change reaching the phone through its list', async () => {
    const task = await listed(service, phone, created.id)
    return task?.revision === 2 ? task : undefined
  }, syncDelayMs + 3000)
  assert.ok(synced.at - changedAt >= syncDelayMs, `the change reached the phone's list after ${synced.at - changedAt} ms`)
  assert.equal(synced.value.done, true)
  assert.deepEqual(shape(await readTask(service, phone, created.id)), shape(synced.value), 'and its read by id')
})

test('acknowledges every change under broken sync and never shows one to another session, by id or in the list', serviceTest, async (t) => {
  const service = await startService(t, { flags: ['--broken-sync', '--sync-delay-ms', '100'] })
  const phone = await signIn(service, ada.id, ada.password, 'ios')
  const desk = await signIn(service, ada.id, ada.password, 'macos')

  const created = await createTask(service, phone, 'Never synced', 'ios')
  assert.match(created.id, ASSIGNED_ID_PATTERN)
  const changed = await changeTask(service, phone, 'seed-ada-1', { done: true }, 'ios')
  assert.deepEqual(shape(changed), { id: 'seed-ada-1', title: 'Release checklist', done: true, revision: 2 }, 'the change is acknowledged')

  // Fifteen times the delay: under working sync both changes would have arrived long before.
  await holdsFor(1500, async () => {
    assert.equal(await readTask(service, desk, created.id), undefined, 'the created task never reaches the other session')
    assert.equal(await listed(service, desk, created.id), undefined, 'nor its list')
    const seed = { id: 'seed-ada-1', title: 'Release checklist', done: false, revision: 1 }
    assert.deepEqual(shape(await readTask(service, desk, 'seed-ada-1')), seed)
    assert.deepEqual(shape(await listed(service, desk, 'seed-ada-1')), seed)
  })
  assert.deepEqual(shape(await readTask(service, phone, created.id)), shape(created), 'its maker still sees it')
  assert.deepEqual(shape(await listed(service, phone, created.id)), shape(created))
  assert.equal((await readTask(service, phone, 'seed-ada-1'))?.done, true)
})

test('breaks sync for one client only: the web sees the phone, and the desktop never sees a change', serviceTest, async (t) => {
  const syncDelayMs = 100
  const service = await startService(t, { flags: ['--broken-sync=macos', '--sync-delay-ms', String(syncDelayMs)] })
  const health = await call(service, 'GET', '/api/health')
  assert.deepEqual(field(health.body, 'brokenSync'), { kind: 'clients', clients: ['macos'] })
  const phone = await signIn(service, ada.id, ada.password, 'ios')
  const web = await signIn(service, ada.id, ada.password, 'web')
  const desk = await signIn(service, ada.id, ada.password, 'macos')

  const created = await createTask(service, phone, 'Made on the phone', 'ios')
  const onWeb = await firstSeen('the web seeing the phone task', () => listed(service, web, created.id), syncDelayMs + 3000)
  assert.deepEqual(shape(onWeb.value), shape(created))
  assert.deepEqual(shape(await readTask(service, web, created.id)), shape(created))

  const done = await changeTask(service, web, created.id, { done: true }, 'web')
  assert.deepEqual(shape(done), { id: created.id, title: 'Made on the phone', done: true, revision: 2 })
  const onPhone = await firstSeen('the phone seeing the web change', async () => {
    const task = await listed(service, phone, created.id)
    return task?.done === true ? task : undefined
  }, syncDelayMs + 3000)
  assert.equal(onPhone.value.revision, 2)

  await holdsFor(1500, async () => {
    assert.equal(await readTask(service, desk, created.id), undefined, 'the desktop never sees the task')
    assert.equal(await listed(service, desk, created.id), undefined, 'nor in its list')
  })
  const deskSelf = await createTask(service, desk, 'Made on the desktop', 'macos')
  assert.deepEqual(shape(await readTask(service, desk, deskSelf.id)), shape(deskSelf), 'the desktop sees its own change')
  await firstSeen('the web seeing the desktop task', () => listed(service, web, deskSelf.id), syncDelayMs + 3000)

  assert.equal((await refusedStart(['--broken-sync=nosuch'])).code, 2, 'an unknown client is refused')
  const spaced = await refusedStart(['--broken-sync', 'macos'])
  assert.equal(spaced.code, 2, 'a client name must follow an equals sign')
  assert.match(spaced.stderr, /--broken-sync=<client>/)
})

test('breaks sync from one client to another only: the desktop sees the phone task, and never the web change to it', serviceTest, async (t) => {
  const syncDelayMs = 100
  const service = await startService(t, { flags: ['--broken-sync=web:macos', '--sync-delay-ms', String(syncDelayMs)] })
  const health = await call(service, 'GET', '/api/health')
  assert.deepEqual(field(health.body, 'brokenSync'), { kind: 'links', links: [{ from: 'web', to: 'macos' }] })
  const phone = await signIn(service, ada.id, ada.password, 'ios')
  const web = await signIn(service, ada.id, ada.password, 'web')
  const desk = await signIn(service, ada.id, ada.password, 'macos')

  const created = await createTask(service, phone, 'Made on the phone', 'ios')
  const onDesk = await firstSeen('the desktop seeing the phone task', () => listed(service, desk, created.id), syncDelayMs + 3000)
  assert.deepEqual(shape(onDesk.value), shape(created), 'a change the phone made reaches the desktop')
  await firstSeen('the web seeing the phone task', () => listed(service, web, created.id), syncDelayMs + 3000)

  const done = await changeTask(service, web, created.id, { done: true }, 'web')
  assert.deepEqual(shape(done), { id: created.id, title: 'Made on the phone', done: true, revision: 2 })
  const onPhone = await firstSeen('the phone seeing the web change', async () => {
    const task = await listed(service, phone, created.id)
    return task?.done === true ? task : undefined
  }, syncDelayMs + 3000)
  assert.equal(onPhone.value.revision, 2, 'the web change reaches the phone')

  // Fifteen times the delay: under working sync the web change would have reached the desktop long before.
  await holdsFor(1500, async () => {
    assert.deepEqual(shape(await readTask(service, desk, created.id)), shape(created), 'the desktop keeps the task as the phone made it')
    assert.deepEqual(shape(await listed(service, desk, created.id)), shape(created))
  })
  // A desktop session signed in after the change is a macOS client too, and is kept from it as well.
  const laterDesk = await signIn(service, ada.id, ada.password, 'macos')
  assert.deepEqual(shape(await readTask(service, laterDesk, created.id)), shape(created))

  const renamed = await changeTask(service, phone, created.id, { title: 'Renamed on the phone' }, 'ios')
  assert.deepEqual(shape(renamed), { id: created.id, title: 'Renamed on the phone', done: true, revision: 3 })
  const renamedOnDesk = await firstSeen('the desktop seeing the phone rename', async () => {
    const task = await listed(service, desk, created.id)
    return task?.revision === 3 ? task : undefined
  }, syncDelayMs + 3000)
  // The phone's change carries the whole task as it stood after the web change, so the desktop sees done here.
  assert.deepEqual(shape(renamedOnDesk.value), { id: created.id, title: 'Renamed on the phone', done: true, revision: 3 })

  for (const [args, problem] of [
    [['--broken-sync=web:nosuch'], /--broken-sync takes one of web, ios, macos, electron, test, as in --broken-sync=web:macos, not nosuch\./],
    [['--broken-sync=web:'], /not an empty name\./],
    [['--broken-sync=web:macos:ios'], /takes two clients/],
    [['--broken-sync=web:macos', '--broken-sync=ios'], /cannot be given with --broken-sync or --broken-sync=<client>/],
    [['--broken-sync=web:macos', '--broken-sync'], /cannot be given with --broken-sync or --broken-sync=<client>/],
  ] as const) {
    const refused = await refusedStart(args)
    assert.equal(refused.code, 2, `${args.join(' ')} is refused`)
    assert.match(refused.stderr, problem)
    assert.match(refused.stderr, /--broken-sync=<from>:<to>/, 'the usage names the form')
  }
})

test('applies only the fields a change holds, to the newest state, so a change made inside the delay is kept', serviceTest, async (t) => {
  const syncDelayMs = 800
  const service = await startService(t, { flags: ['--sync-delay-ms', String(syncDelayMs)] })
  const web = await signIn(service, ada.id, ada.password, 'web')
  const phone = await signIn(service, ada.id, ada.password, 'ios')
  const created = await createTask(service, web, 'Shared task', 'web')
  await firstSeen('the phone seeing the shared task', () => readTask(service, phone, created.id), syncDelayMs + 3000)

  // Inside one delay: the web marks it done, then the phone, which still sees it open, renames it.
  const done = await changeTask(service, web, created.id, { done: true }, 'web')
  assert.deepEqual(shape(done), { id: created.id, title: 'Shared task', done: true, revision: 2 })
  assert.equal((await readTask(service, phone, created.id))?.done, false, 'the phone has not seen the web change yet')
  const renamed = await changeTask(service, phone, created.id, { title: 'Shared task, renamed' }, 'ios')
  const merged = { id: created.id, title: 'Shared task, renamed', done: true, revision: 3 }
  assert.deepEqual(shape(renamed), merged, "the phone's rename keeps the web's done, which it never sent")

  const onWeb = await firstSeen('the web seeing the rename', async () => {
    const task = await readTask(service, web, created.id)
    return task?.revision === 3 ? task : undefined
  }, syncDelayMs + 3000)
  assert.deepEqual(shape(onWeb.value), merged)
  assert.deepEqual(shape(await listed(service, web, created.id)), merged)
  assert.deepEqual(shape(await listed(service, phone, created.id)), merged)
})

test('puts back the seeded tasks on reset and signs every session out', serviceTest, async (t) => {
  const service = await startService(t, { flags: ['--sync-delay-ms', '0'] })
  const token = await signIn(service, ada.id, ada.password)
  const created = await createTask(service, token, 'Gone after reset')
  assert.deepEqual(shape(await changeTask(service, token, 'seed-ada-1', { title: 'Changed', done: true })), { id: 'seed-ada-1', title: 'Changed', done: true, revision: 2 })

  const reset = await call(service, 'POST', '/admin/reset')
  assert.deepEqual([reset.status, reset.body], [200, { reset: true }])
  assert.equal((await call(service, 'GET', '/api/tasks', { token })).status, 401, 'a session from before the reset is gone')
  assert.equal((await call(service, 'GET', '/admin/reset')).status, 405)

  const fresh = await signIn(service, ada.id, ada.password)
  assert.deepEqual((await listTasks(service, fresh)).map(shape), seededForAda)
  assert.equal(await readTask(service, fresh, created.id), undefined)
})

test('a reset reaches the state file, so a restart after it starts from the seeded tasks', serviceTest, async (t) => {
  const folder = await scratchFolder(t, 'retest-cross-platform-')
  const stateFile = join(folder, 'state.json')
  const flags = ['--state', stateFile, '--sync-delay-ms', '0']
  const first = await startService(t, { folder, flags })
  const token = await signIn(first, ada.id, ada.password)
  assert.deepEqual(shape(await changeTask(first, token, 'seed-ada-1', { title: 'Changed before the reset', done: true })), {
    id: 'seed-ada-1',
    title: 'Changed before the reset',
    done: true,
    revision: 2,
  })
  const created = await createTask(first, token, 'Made before the reset')
  assert.equal((await call(first, 'POST', '/admin/reset')).status, 200)
  assert.deepEqual(await first.stop(), { code: 0, signal: null })

  const second = await startService(t, { folder, flags })
  const again = await signIn(second, ada.id, ada.password)
  assert.deepEqual((await listTasks(second, again)).map(shape), seededForAda)
  assert.equal(await readTask(second, again, created.id), undefined)
  assert.deepEqual(await second.stop(), { code: 0, signal: null })
})

test('keeps the tasks in a state file across a restart, without a credential in it, and refuses a file it did not write', serviceTest, async (t) => {
  const folder = await scratchFolder(t, 'retest-cross-platform-')
  const stateFile = join(folder, 'state.json')
  const first = await startService(t, { folder, flags: ['--state', stateFile, '--sync-delay-ms', '0'] })
  const token = await signIn(first, ada.id, ada.password)
  const created = await createTask(first, token, 'Kept across a restart')
  await changeTask(first, token, created.id, { done: true })
  assert.deepEqual(await first.stop(), { code: 0, signal: null })

  const state = readFileSync(stateFile, 'utf8')
  for (const value of [token, ada.password, ben.password]) assert.ok(!state.includes(value), 'the state file holds no token or password')

  const second = await startService(t, { folder, flags: ['--state', stateFile, '--sync-delay-ms', '0'] })
  assert.equal((await call(second, 'GET', '/api/tasks', { token })).status, 401, 'sessions do not survive a restart')
  const again = await signIn(second, ada.id, ada.password)
  assert.deepEqual(shape(await readTask(second, again, created.id)), { id: created.id, title: 'Kept across a restart', done: true, revision: 2 })
  assert.deepEqual(await second.stop(), { code: 0, signal: null })

  const memory = await startService(t, { folder, flags: ['--sync-delay-ms', '0'] })
  const memoryToken = await signIn(memory, ada.id, ada.password)
  assert.equal(await readTask(memory, memoryToken, created.id), undefined, 'without --state the tasks live in memory only')
  await memory.stop()

  const broken = join(folder, 'broken.json')
  writeFileSync(broken, '{"format":"something-else","version":1,"tasks":[]}')
  const refused = await refusedStart(['--state', broken])
  assert.equal(refused.code, 2)
  assert.match(refused.stderr, /^The state file .*broken\.json is not one this service wrote: format and version must be/)
})

test('a change the state file cannot keep is answered 500, did not happen, and is reported on stderr', serviceTest, async (t) => {
  const folder = await scratchFolder(t, 'retest-cross-platform-state-')
  const stateFolder = join(folder, 'state')
  mkdirSync(stateFolder)
  const service = await startService(t, { folder, flags: ['--state', join(stateFolder, 'state.json'), '--sync-delay-ms', '0'] })
  const token = await signIn(service, ada.id, ada.password)
  // Put back in the body, never in a cleanup hook: a folder left read-only would stop the scratch folder's removal,
  // and the hooks after it, the service's kill among them.
  chmodSync(stateFolder, 0o500)
  try {
    const change = await call(service, 'PATCH', '/api/tasks/seed-ada-1', { token, body: { done: true } })
    assert.equal(change.status, 500)
    assert.deepEqual(shape(await readTask(service, token, 'seed-ada-1')), { id: 'seed-ada-1', title: 'Release checklist', done: false, revision: 1 }, 'the change did not happen')
    assert.equal((await call(service, 'POST', '/api/tasks', { token, body: { title: 'Not kept' } })).status, 500)
    assert.deepEqual((await listTasks(service, token)).map(shape), seededForAda, 'the task was not created')
    assert.equal((await call(service, 'POST', '/admin/reset')).status, 500)
    assert.equal((await call(service, 'GET', '/api/tasks', { token })).status, 200, 'the failed reset signed nobody out')
    assert.match(service.stderr(), /PATCH \/api\/tasks\/seed-ada-1 failed, and nothing it asked for was kept: EACCES/)
    assert.match(service.stderr(), /POST \/api\/tasks failed, and nothing it asked for was kept: EACCES/)
  } finally {
    chmodSync(stateFolder, 0o700)
  }
  assert.equal((await changeTask(service, token, 'seed-ada-1', { done: true })).done, true, 'it keeps working once the folder is writable again')
  assert.deepEqual(await service.stop(), { code: 0, signal: null })
})

test('writes one plain line and one typed JSON line per request, with no header, body, query or credential', serviceTest, async (t) => {
  const service = await startService(t, { flags: ['--sync-delay-ms', '0'] })
  const title = 'Title that stays out of the logs 4af1'
  const strangeClient = 'Bearer header-value-that-stays-out'
  const webToken = await signIn(service, ada.id, ada.password, 'web')
  const phoneToken = await signIn(service, ben.id, ben.password, 'ios')
  const created = await createTask(service, phoneToken, title, 'ios')
  await call(service, 'GET', '/api/tasks', { token: webToken, client: 'macos' })
  await call(service, 'PATCH', `/api/tasks/${created.id}`, { token: phoneToken, body: { done: true }, client: 'electron' })
  await call(service, 'POST', '/api/sign-in', { body: { account: ada.id, password: 'a wrong password 9c2e' }, client: strangeClient })
  await call(service, 'GET', '/api/tasks?token=query-value-that-stays-out', { token: webToken, client: 'web' })
  await call(service, 'GET', '/no/such/page', { client: 'test' })
  await call(service, 'GET', `/api/sign-in/${encodeURIComponent(ada.password)}`, { client: 'test' })
  await call(service, 'GET', `/api/tasks/${encodeURIComponent(ben.password)}`, { token: webToken, client: 'test' })
  await call(service, 'GET', `/tasks/${encodeURIComponent(ada.password)}`, { client: 'test' })
  await call(service, 'GET', '/tasks/seed-ada-2', { client: 'test' })
  await call(service, 'POST', '/admin/reset', { client: 'test' })
  assert.deepEqual(await service.stop(), { code: 0, signal: null })

  const expected = [
    ['POST', '/api/sign-in', 200, 'web'],
    ['POST', '/api/sign-in', 200, 'ios'],
    ['POST', '/api/tasks', 201, 'ios'],
    ['GET', '/api/tasks', 200, 'macos'],
    ['PATCH', `/api/tasks/${created.id}`, 200, 'electron'],
    ['POST', '/api/sign-in', 403, 'unknown'],
    ['GET', '/api/tasks', 200, 'web'],
    ['GET', 'unknown', 404, 'test'],
    ['GET', 'unknown', 404, 'test'],
    ['GET', '/api/tasks/unknown', 404, 'test'],
    ['GET', '/tasks/unknown', 200, 'test'],
    ['GET', '/tasks/seed-ada-2', 200, 'test'],
    ['POST', '/admin/reset', 200, 'test'],
  ]
  const records = readNetworkLog(service)
  assert.deepEqual(
    records.map((record) => [record.method, record.path, record.status, record.client]),
    expected,
  )
  assert.deepEqual(
    records.map((record) => record.sequence),
    expected.map((_entry, index) => index + 1),
  )
  for (const record of records) {
    assert.equal(record.completed, true)
    assert.ok(record.durationMs >= 0 && record.durationMs < 5000)
    assert.ok(Math.abs(Date.parse(record.startedAt) - Date.now()) < 60_000)
  }

  const [address, ...lines] = service.stdout().trimEnd().split('\n')
  assert.equal(address, service.url, 'the first line is the address')
  assert.deepEqual(lines, records.map(formatRequestLine), 'stdout has one plain line per request, saying what the network log says')
  for (const line of lines) assert.match(line, /^\S+Z (GET|POST|PATCH) (\/\S*|unknown) \d{3} \d+(\.\d)?ms client=(web|ios|macos|electron|test|unknown)$/)

  const logs = { stdout: service.stdout(), stderr: service.stderr(), 'network log': readFileSync(service.networkLog, 'utf8') }
  const kept = [ada.password, ben.password, 'a wrong password 9c2e', webToken, phoneToken, title, strangeClient, 'header-value-that-stays-out', 'query-value-that-stays-out', 'Bearer', 'authorization']
  for (const [name, text] of Object.entries(logs)) {
    for (const value of kept) assert.ok(!textHolds(text, value), `the ${name} does not hold ${JSON.stringify(value.slice(0, 12))}…`)
  }
})

test('keeps answering when the network log cannot be written, and says so once on stderr', serviceTest, async (t) => {
  const service = await startService(t, { flags: ['--sync-delay-ms', '0'] })
  assert.equal((await call(service, 'GET', '/api/health')).status, 200)
  // A request is logged once its answer has gone out, which can be after the client has read it.
  await firstSeen('the first request reaching the network log', async () => (readFileSync(service.networkLog, 'utf8').endsWith('\n') ? true : undefined), answerMs)
  chmodSync(service.networkLog, 0o400)
  try {
    for (let index = 0; index < 3; index += 1) assert.equal((await call(service, 'GET', '/api/health')).status, 200, `request ${index + 1} after the log broke`)
    const token = await signIn(service, ada.id, ada.password)
    assert.equal((await listTasks(service, token)).length, 3)
  } finally {
    chmodSync(service.networkLog, 0o600)
  }
  assert.deepEqual(await service.stop(), { code: 0, signal: null })
  assert.equal(service.stderr().match(/could not be written/g)?.length, 1, `stderr says it once: ${service.stderr()}`)
  assert.match(service.stderr(), /The network log .* could not be written \(EACCES/)
  assert.equal(readNetworkLog(service).length, 1, 'the log keeps what it had')
  assert.equal(service.stdout().trimEnd().split('\n').length, 1 + 6, 'stdout still has a line for every request')
})

test('takes a write only from a named client and a request only to a loopback name, and sends no CORS headers', serviceTest, async (t) => {
  const service = await startService(t, { flags: ['--sync-delay-ms', '0'] })
  const token = await signIn(service, ada.id, ada.password)
  await changeTask(service, token, 'seed-ada-1', { done: true })

  for (const [method, path, body] of [
    ['POST', '/admin/reset', undefined],
    ['POST', '/api/sign-in', { account: ada.id, password: ada.password }],
    ['POST', '/api/tasks', { title: 'From another site' }],
    ['PATCH', '/api/tasks/seed-ada-2', { done: false }],
    ['POST', '/api/sign-out', undefined],
  ] as const) {
    for (const client of [null, 'evil']) {
      const answer = await call(service, method, path, { token, client, ...(body === undefined ? {} : { body }) })
      assert.equal(answer.status, 403, `${method} ${path} with ${client ?? 'no'} client header`)
    }
  }
  assert.equal((await readTask(service, token, 'seed-ada-1'))?.done, true, 'the refused reset changed nothing')
  assert.equal((await readTask(service, token, 'seed-ada-2'))?.done, true, 'the refused change changed nothing')
  assert.equal((await call(service, 'GET', '/api/tasks', { token, client: null })).status, 200, 'a read needs no client header')

  for (const host of ['evil.example', 'evil.example:80', '192.168.1.10:4310']) {
    assert.equal((await rawRequest(service, 'GET', '/', { host })).status, 403, `the page for Host ${host}`)
    assert.equal((await rawRequest(service, 'POST', '/admin/reset', { host, 'x-task-client': 'test' })).status, 403, `reset for Host ${host}`)
  }
  assert.equal((await readTask(service, token, 'seed-ada-1'))?.done, true, 'no reset went through')
  for (const host of [`127.0.0.1:${service.port}`, `localhost:${service.port}`, `[::1]:${service.port}`]) {
    assert.equal((await rawRequest(service, 'GET', '/', { host })).status, 200, `the page for Host ${host}`)
  }

  const preflight = await rawRequest(service, 'OPTIONS', '/admin/reset', {
    origin: 'https://evil.example',
    'access-control-request-method': 'POST',
    'access-control-request-headers': 'x-task-client',
  })
  assert.ok(preflight.status >= 400, `a preflight is refused, received ${preflight.status}`)
  assert.deepEqual(
    Object.keys(preflight.headers).filter((name) => name.startsWith('access-control-')),
    [],
    'no CORS header is sent',
  )
})

test('the Swift the apps compile takes only a loopback address, follows no redirect, reads a window frame and writes one line per request', { timeout: 300_000 }, async (t) => {
  if (!hasSwiftCompiler()) {
    t.skip('unverified: needs macOS with Xcode, for xcrun swiftc')
    return
  }
  const folder = await scratchFolder(t, 'retest-swift-checks-')
  const binary = join(folder, 'checks')
  const compiled = await within(runProgram('xcrun', ['swiftc', '-swift-version', '6', '-o', binary, ...swiftFiles], repositoryRoot), 240_000, 'swiftc did not finish within 240 s')
  assert.equal(compiled.code, 0, compiled.stderr)
  const service = await startService(t, { flags: ['--sync-delay-ms', '0'] })
  const redirecting = await redirectingServer(t, service.url)
  const run = await within(
    runProgram(binary, [redirecting.url, service.url], repositoryRoot, { ...process.env, CHECK_PASSWORD: ada.password }),
    60_000,
    'the Swift checks did not finish within 60 s',
  )
  const lines = run.stdout.trimEnd().split('\n')
  assert.deepEqual(
    lines.filter((line) => line.startsWith('fail')),
    [],
    run.stdout,
  )
  assert.equal(run.code, 0, run.stdout)
  assert.equal(lines.filter((line) => line.startsWith('ok ')).length, 38, run.stdout)
  const requests = lines.filter((line) => !line.startsWith('ok '))
  assert.deepEqual(
    requests.map((line) => line.replace(/ \d+ms$/, '')),
    [
      'GET /api/health 307',
      'POST /api/sign-in 307',
      'GET /api/health 200',
      'POST /api/sign-in 200',
      'POST /api/tasks 201',
      'GET /api/tasks/{id} 200',
      'GET /api/tasks 200',
      'GET /api/tasks/{id} 404',
    ],
    'one line per request: method, route, status, duration',
  )
  for (const line of requests) assert.match(line, / \d+ms$/)
  assert.equal(redirecting.answered(), 2, 'the redirecting address was asked twice')
  await service.stop()
  const signIns = readNetworkLog(service).filter((record) => record.path === '/api/sign-in')
  assert.equal(signIns.length, 1, 'the redirected sign-in never reached the service')
  assert.ok(!textHolds(run.stdout, ada.password) && !textHolds(run.stderr, ada.password), 'the output does not hold the password')
})

test('Retest signs in to the web front end on real Chrome, creates a task, sees its id and changes it by id', browserTest, async (t) => {
  const syncDelayMs = 200
  const service = await startService(t, { flags: ['--sync-delay-ms', String(syncDelayMs)] })
  const run = await runRetest(t, {
    files: [webTests],
    browser: false,
    args: ['--config', webConfig, '--base-url', service.url],
    env: { [passwordVariable]: ada.password },
  })
  assert.equal(run.exit.code, 0, `${run.stdout}\n${run.stderr}`)
  assertStdoutIsEvents(run)
  const creates = testNamed(run, 'creates a task, shows the id the service gave it, and marks that task done')
  const changesById = testNamed(run, 'changes one of two tasks that share a title, by its id, and leaves the other as it was')
  assert.equal(creates.status, 'passed')
  assert.equal(changesById.status, 'passed')

  // The id the page showed, from the parent's own looks at it: the same in both places, and in the page's address.
  const lastLook = (testId: string): string | undefined =>
    eventsOf(run.events, 'observation')
      .filter((event) => event.testId === creates.testId && event.locator.by === 'testId' && event.locator.value === testId)
      .at(-1)?.observed.text?.text
  const shownId = lastLook('created-task-id')
  assert.ok(shownId !== undefined, 'Retest looked at the created task id')
  assert.match(shownId, ASSIGNED_ID_PATTERN)
  assert.equal(lastLook('selected-task-id'), shownId, 'the editor showed the same id')
  const addresses = eventsOf(run.events, 'navigation').filter((event) => event.testId === creates.testId).map((event) => new URL(event.url).pathname)
  assert.ok(addresses.includes(`/tasks/${shownId}`), `the page's address named the task: ${addresses.join(', ')}`)

  const fills = eventsOf(run.events, 'action.completed').filter((event) => event.command === 'fill' && event.secret !== undefined)
  assert.deepEqual(
    fills.map((event) => event.secret),
    ['password', 'password'],
    'each test typed the password as the secret',
  )

  // The service holds what the page said: that id, done, and the seeded task changed by id beside its namesake.
  await delay(syncDelayMs)
  const token = await signIn(service, ada.id, ada.password)
  assert.deepEqual(shape(await readTask(service, token, shownId)), { id: shownId, title: 'Release checklist', done: true, revision: 2 })
  assert.deepEqual(shape(await readTask(service, token, 'seed-ada-1')), { id: 'seed-ada-1', title: 'Release checklist, signed off', done: true, revision: 2 })
  assert.deepEqual(shape(await readTask(service, token, 'seed-ada-2')), { id: 'seed-ada-2', title: 'Release checklist', done: true, revision: 1 })
  assert.deepEqual(shape(await readTask(service, token, 'seed-ada-3')), { id: 'seed-ada-3', title: 'Write the changelog', done: false, revision: 1 })

  await service.stop()
  const records = readNetworkLog(service)
  const fromWeb = records.filter((record) => record.client === 'web' && record.method !== 'GET').map((record) => [record.method, record.path, record.status])
  assert.deepEqual(fromWeb, [
    ['POST', '/api/sign-in', 200],
    ['POST', '/api/tasks', 201],
    ['PATCH', `/api/tasks/${shownId}`, 200],
    ['POST', '/api/sign-in', 200],
    ['PATCH', '/api/tasks/seed-ada-1', 200],
  ])

  assert.deepEqual(filesHolding(run.output, ada.password), [], 'no file of the run holds the password')
  assert.ok(!textHolds(run.stdout, ada.password) && !textHolds(run.stderr, ada.password), "Retest's output does not hold the password")
  assert.ok(!textHolds(service.stdout(), ada.password) && !textHolds(readFileSync(service.networkLog, 'utf8'), ada.password), "the service's logs do not hold it")
})

test('Retest on real Chrome: a save made while the list refreshes is not undone by the older list', browserTest, async (t) => {
  const service = await startService(t, { flags: ['--sync-delay-ms', '0', '--read-delay-ms', '1500'] })
  const run = await runRetest(t, {
    files: [raceTests],
    browser: false,
    args: ['--config', webConfig, '--base-url', service.url],
    env: { [passwordVariable]: ada.password },
    timeouts: budgets({ assertion: 5000, action: 4000, test: 40_000 }),
  })
  assert.equal(run.exit.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(testNamed(run, 'a save made while the list is refreshing stays on the page when the older list arrives').status, 'passed')
  const token = await signIn(service, ada.id, ada.password)
  assert.equal((await readTask(service, token, 'seed-ada-3'))?.done, true)
})
