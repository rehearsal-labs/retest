import type { Session } from '../../fixtures/cross-platform/service/accounts.ts'
import type { SyncPolicy, TaskView } from '../../fixtures/cross-platform/service/store.ts'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { TaskStore } from '../../fixtures/cross-platform/service/store.ts'

// The fixture service's task store on a clock the test moves, so what each client sees can be read at any moment.

const phone: Session = { id: 'session-phone', account: 'ada', client: 'ios' }
const web: Session = { id: 'session-web', account: 'ada', client: 'web' }
const desk: Session = { id: 'session-desk', account: 'ada', client: 'macos' }

function store(sync: SyncPolicy, stateFile?: string): { tasks: TaskStore; advance(ms: number): void } {
  let now = 1_000_000
  const tasks = new TaskStore({ sync, now: () => now, ...(stateFile === undefined ? {} : { stateFile }) })
  return { tasks, advance: (ms) => { now += ms } }
}

function shape(view: TaskView | undefined): Pick<TaskView, 'title' | 'done' | 'revision'> | undefined {
  return view === undefined ? undefined : { title: view.title, done: view.done, revision: view.revision }
}

const webToDesk: SyncPolicy = { delayMs: 100, broken: { kind: 'links', links: [{ from: 'web', to: 'macos' }] } }

describe('a change that never reaches a client', () => {
  test('stays hidden from it under a later change merged onto it', () => {
    const { tasks, advance } = store(webToDesk)
    const created = tasks.create(phone, 'Made on the phone')
    advance(200)
    tasks.update(web, created.id, { done: true })
    advance(200)
    assert.deepEqual(shape(tasks.update(phone, created.id, { title: 'Renamed on the phone' })), { title: 'Renamed on the phone', done: true, revision: 3 }, 'the phone saw the web change')
    advance(200)
    assert.deepEqual(shape(tasks.read(desk, created.id)), { title: 'Renamed on the phone', done: false, revision: 3 }, "the web's done never reaches the desktop, not even through the phone's rename")
    assert.deepEqual(shape(tasks.list(desk).find((task) => task.id === created.id)), { title: 'Renamed on the phone', done: false, revision: 3 })
    assert.deepEqual(shape(tasks.read(web, created.id)), { title: 'Renamed on the phone', done: true, revision: 3 })
  })

  test('keeps a task it created away from that client whatever later changes the others make', () => {
    const { tasks, advance } = store(webToDesk)
    const created = tasks.create(web, 'Made on the web')
    advance(200)
    tasks.update(phone, created.id, { done: true })
    advance(200)
    assert.equal(tasks.read(desk, created.id), undefined)
    assert.equal(tasks.list(desk).some((task) => task.id === created.id), false)
    assert.equal(tasks.update(desk, created.id, { title: 'From the desk' }), undefined, 'the desktop cannot change a task it cannot see')
  })

  test('is kept so after a restart from the state file', async (t) => {
    const folder = await mkdtemp(join(tmpdir(), 'retest-store-'))
    t.after(() => rm(folder, { recursive: true, force: true }))
    const stateFile = join(folder, 'state.json')
    const first = store(webToDesk, stateFile)
    const created = first.tasks.create(phone, 'Made on the phone')
    first.advance(200)
    first.tasks.update(web, created.id, { done: true })
    first.tasks.update(phone, created.id, { title: 'Renamed on the phone' })
    const restarted = store(webToDesk, stateFile)
    restarted.advance(10_000)
    assert.deepEqual(shape(restarted.tasks.read(desk, created.id)), { title: 'Renamed on the phone', done: false, revision: 3 })
  })
})

describe('a change only waiting out its delay', () => {
  test('is kept under a change merged onto it, which its maker sees at once', () => {
    const { tasks, advance } = store({ delayMs: 800, broken: { kind: 'off' } })
    const created = tasks.create(web, 'Shared task')
    advance(1000)
    tasks.update(web, created.id, { done: true })
    assert.equal(tasks.read(phone, created.id)?.done, false, 'the phone has not seen the web change yet')
    assert.deepEqual(shape(tasks.update(phone, created.id, { title: 'Shared task, renamed' })), { title: 'Shared task, renamed', done: true, revision: 3 })
    advance(1000)
    for (const session of [web, phone, desk]) assert.deepEqual(shape(tasks.read(session, created.id)), { title: 'Shared task, renamed', done: true, revision: 3 })
  })
})
