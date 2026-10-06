import type { Session } from './accounts.ts'
import type { ClientName, KnownClient } from './clients.ts'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isClientName } from './clients.ts'

/** A task as one signed-in client sees it. */
export type TaskView = {
  /** Assigned by the service, never by a client, and never reused. */
  id: string
  title: string
  done: boolean
  /**
   * The number of the change this client sees, counting every change the service accepted for the task: 1 is the task
   * as created. A client that has not yet seen another client's change sees a lower number.
   */
  revision: number
  createdAt: string
  updatedAt: string
}

/** A change a client asks for. Only the fields present are changed; at least one is. */
export type TaskChange = { title?: string; done?: boolean }

/** A one-way break: changes made by sessions of `from` never reach sessions of `to`. */
export type SyncLink = { from: KnownClient; to: KnownClient }

/** Which clients a change never reaches: none, every other one, these whoever made it, or these from these makers. */
export type BrokenSync = { kind: 'off' } | { kind: 'every-other-client' } | { kind: 'clients'; clients: readonly KnownClient[] } | { kind: 'links'; links: readonly SyncLink[] }

/** How a change reaches the clients that did not make it. */
export type SyncPolicy = {
  /** How long after a change the other clients see it. The client that made it sees it at once. */
  delayMs: number
  /** Changes made while sync is broken are acknowledged and never reach these clients. */
  broken: BrokenSync
}

/** The tasks each account starts with, after a start without a state file and after every reset. */
export type SeededTask = { readonly id: string; readonly account: string; readonly title: string; readonly done: boolean }

/**
 * The seeded tasks. Three share the title "Release checklist", two of them in one account, so a test that finds a task
 * by its title finds the wrong one or several; only the id names one task.
 */
export const SEEDED_TASKS: readonly SeededTask[] = [
  { id: 'seed-ada-1', account: 'ada', title: 'Release checklist', done: false },
  { id: 'seed-ada-2', account: 'ada', title: 'Release checklist', done: true },
  { id: 'seed-ada-3', account: 'ada', title: 'Write the changelog', done: false },
  { id: 'seed-ben-1', account: 'ben', title: 'Release checklist', done: false },
]

/** The shape of every id the service assigns. */
export const ASSIGNED_ID_PATTERN: RegExp = /^task-[0-9a-f]{12}$/

/** The shape of every task id there is: assigned, or seeded. */
export const TASK_ID_PATTERN: RegExp = /^(?:task-[0-9a-f]{12}|seed-[a-z]+-[0-9]+)$/

/** Who made the seeded state, in place of a session id. */
const SEED_AUTHOR = 'seed'

const STATE_FORMAT = 'retest-cross-platform-tasks'
const STATE_VERSION = 1

/** Every client that never sees a change, or all but its maker. */
type HiddenFrom = 'all' | ClientName[]

/** A field a change can set. */
type TaskField = 'title' | 'done'

/** One change to a task: what the task became, which session made it, and when and to whom the others see it. */
type Version = {
  title: string
  done: boolean
  /** The fields this change itself set; absent for a whole task, as created, seeded or kept by an earlier service. */
  changed?: TaskField[]
  at: string
  madeBy: string
  /** Epoch milliseconds from which the other sessions see this change, unless it is hidden from them. */
  visibleAt: number
  hiddenFrom: HiddenFrom
}

type StoredTask = { id: string; account: string; versions: Version[] }

type StateFile = { format: typeof STATE_FORMAT; version: typeof STATE_VERSION; tasks: StoredTask[] }

export type TaskStoreOptions = {
  sync: SyncPolicy
  /** A JSON file that keeps the tasks across restarts. Without one the tasks live in memory only. */
  stateFile?: string
  /** The clock, in epoch milliseconds. */
  now?: () => number
}

/**
 * Every account's tasks, with the history of each, so that each session reads the newest change it may see: its own
 * at once, another session's once that change's sync delay has passed, and never one hidden from its client.
 *
 * A change is written to the state file before memory takes it, so a change that could not be kept did not happen.
 */
export class TaskStore {
  #tasks: StoredTask[]
  readonly #sync: SyncPolicy
  readonly #stateFile: string | undefined
  readonly #now: () => number

  constructor(options: TaskStoreOptions) {
    this.#sync = options.sync
    this.#stateFile = options.stateFile
    this.#now = options.now ?? Date.now
    const loaded = options.stateFile === undefined ? undefined : readStateFile(options.stateFile)
    this.#tasks = loaded ?? this.#commit(seededTasks(this.#now()))
  }

  /** The account's tasks this session can see, oldest first. */
  list(session: Session): TaskView[] {
    const now = this.#now()
    return this.#tasks.flatMap((task) => {
      const view = task.account === session.account ? viewOf(task, session, now) : undefined
      return view === undefined ? [] : [view]
    })
  }

  /** One task by id, when it is the session's account's and the session can see it. */
  read(session: Session, id: string): TaskView | undefined {
    const task = this.#find(session, id)
    return task === undefined ? undefined : viewOf(task, session, this.#now())
  }

  /** Creates a task with a new id. Its creator sees it at once; the others after the sync delay, or never. */
  create(session: Session, title: string): TaskView {
    const task: StoredTask = { id: this.#newId(), account: session.account, versions: [this.#version(session, { title, done: false })] }
    this.#tasks = this.#commit([...this.#tasks, task])
    return mustView(task, session, this.#now())
  }

  /**
   * Applies the fields the change holds to the newest state of the task, whoever made it, so a change another session
   * made and this one has not seen yet is kept. A client a change is hidden from never sees its fields, not even
   * through a later change merged onto it: see `viewOf`. Undefined when this session cannot see the task.
   */
  update(session: Session, id: string, change: TaskChange): TaskView | undefined {
    const task = this.#find(session, id)
    const newest = task?.versions.at(-1)
    if (task === undefined || newest === undefined || viewOf(task, session, this.#now()) === undefined) return undefined
    const fields = { title: change.title ?? newest.title, done: change.done ?? newest.done }
    const set: TaskField[] = [...(change.title === undefined ? [] : ['title' as const]), ...(change.done === undefined ? [] : ['done' as const])]
    const changed: StoredTask = { ...task, versions: [...task.versions, { ...this.#version(session, fields), changed: set }] }
    this.#tasks = this.#commit(this.#tasks.map((each) => (each === task ? changed : each)))
    return mustView(changed, session, this.#now())
  }

  /** Puts back the seeded tasks and nothing else. */
  reset(): void {
    this.#tasks = this.#commit(seededTasks(this.#now()))
  }

  #find(session: Session, id: string): StoredTask | undefined {
    return this.#tasks.find((task) => task.id === id && task.account === session.account)
  }

  #version(session: Session, fields: { title: string; done: boolean }): Version {
    const now = this.#now()
    return { ...fields, at: new Date(now).toISOString(), madeBy: session.id, visibleAt: now + this.#sync.delayMs, hiddenFrom: hiddenFrom(this.#sync.broken, session.client) }
  }

  #newId(): string {
    for (;;) {
      const id = `task-${randomBytes(6).toString('hex')}`
      if (!this.#tasks.some((task) => task.id === id)) return id
    }
  }

  // Writes the tasks whole to a neighbouring file and renames it over the old one, so a reader never sees half a state.
  // It throws when the file cannot be written, before anyone has the new tasks.
  #commit(tasks: StoredTask[]): StoredTask[] {
    if (this.#stateFile === undefined) return tasks
    const state: StateFile = { format: STATE_FORMAT, version: STATE_VERSION, tasks }
    const partial = `${this.#stateFile}.${process.pid}.partial`
    try {
      writeFileSync(partial, `${JSON.stringify(state, null, 2)}\n`)
      renameSync(partial, this.#stateFile)
    } catch (error) {
      rmSync(partial, { force: true })
      throw error
    }
    return tasks
  }
}

// Decided when the change is made, from the client that made it, and kept with the change.
function hiddenFrom(broken: BrokenSync, maker: KnownClient): HiddenFrom {
  if (broken.kind === 'off') return []
  if (broken.kind === 'every-other-client') return 'all'
  if (broken.kind === 'clients') return [...broken.clients]
  return [...new Set(broken.links.filter((link) => link.from === maker).map((link) => link.to))]
}

function seededTasks(now: number): StoredTask[] {
  const at = new Date(now).toISOString()
  return SEEDED_TASKS.map((seed) => ({
    id: seed.id,
    account: seed.account,
    versions: [{ title: seed.title, done: seed.done, at, madeBy: SEED_AUTHOR, visibleAt: 0, hiddenFrom: [] }],
  }))
}

// The newest change the session made itself, or may already see from another session. Each field is the one that
// change holds unless it was merged from an earlier change hidden from this session's client: then the field is taken
// from the newest change before it that set the field and is not hidden from the client. A change only waiting out
// its delay is not hidden, so a change merged onto it keeps it, as the sync delay alone allows. A task whose creation
// is hidden from the client is never seen by it, since a later change cannot tell it what was created.
function viewOf(task: StoredTask, session: Session, now: number): TaskView | undefined {
  const [first] = task.versions
  if (first === undefined || hiddenFromSession(first, session)) return undefined
  for (let index = task.versions.length - 1; index >= 0; index -= 1) {
    const version = task.versions[index]
    if (version === undefined || !reaches(version, session, now)) continue
    const title = fieldAsSeen(task.versions, index, 'title', session, first)
    const done = fieldAsSeen(task.versions, index, 'done', session, first)
    return { id: task.id, title, done, revision: index + 1, createdAt: first.at, updatedAt: version.at }
  }
  return undefined
}

function fieldAsSeen<Field extends TaskField>(versions: readonly Version[], from: number, field: Field, session: Session, created: Version): Version[Field] {
  for (let index = from; index > 0; index -= 1) {
    const version = versions[index]
    if (version === undefined || hiddenFromSession(version, session)) continue
    if (version.changed === undefined || version.changed.includes(field)) return version[field]
  }
  return created[field]
}

function reaches(version: Version, session: Session, now: number): boolean {
  if (version.madeBy === session.id) return true
  if (hiddenFromSession(version, session)) return false
  return version.visibleAt <= now
}

function hiddenFromSession(version: Version, session: Session): boolean {
  if (version.madeBy === session.id) return false
  return version.hiddenFrom === 'all' || version.hiddenFrom.includes(session.client)
}

function mustView(task: StoredTask, session: Session, now: number): TaskView {
  const view = viewOf(task, session, now)
  if (view === undefined) throw new Error(`The session that changed ${task.id} cannot see it`)
  return view
}

function readStateFile(path: string): StoredTask[] | undefined {
  if (!existsSync(path)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`The state file ${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const state = parseState(parsed)
  if (!state.ok) throw new Error(`The state file ${path} is not one this service wrote: ${state.problem}`)
  return state.value
}

type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string }

// Reads back what `#commit` writes, and says what is wrong with anything else.
function parseState(value: unknown): Parsed<StoredTask[]> {
  if (!isRecord(value)) return refuse('it is not an object')
  const { format, version, tasks } = value
  if (format !== STATE_FORMAT || version !== STATE_VERSION) return refuse(`format and version must be ${STATE_FORMAT} ${STATE_VERSION}`)
  if (!Array.isArray(tasks)) return refuse('tasks is not a list')
  const parsedTasks: StoredTask[] = []
  for (const [index, entry] of tasks.entries()) {
    const task = parseTask(entry)
    if (!task.ok) return refuse(`tasks[${index}]: ${task.problem}`)
    if (parsedTasks.some((earlier) => earlier.id === task.value.id)) return refuse(`the id ${task.value.id} appears twice`)
    parsedTasks.push(task.value)
  }
  return { ok: true, value: parsedTasks }
}

function parseTask(value: unknown): Parsed<StoredTask> {
  if (!isRecord(value)) return refuse('not an object')
  const { id, account, versions } = value
  if (typeof id !== 'string' || !TASK_ID_PATTERN.test(id) || typeof account !== 'string') return refuse('id must be a task id and account text')
  if (!Array.isArray(versions) || versions.length === 0) return refuse('versions must be a list with at least one change')
  const parsedVersions: Version[] = []
  for (const entry of versions) {
    const version = parseVersion(entry)
    if (!version.ok) return refuse(version.problem)
    parsedVersions.push(version.value)
  }
  return { ok: true, value: { id, account, versions: parsedVersions } }
}

function parseVersion(value: unknown): Parsed<Version> {
  if (!isRecord(value)) return refuse('a change is not an object')
  const { title, done, at, madeBy, visibleAt, hiddenFrom: hidden, changed } = value
  if (typeof title !== 'string' || typeof done !== 'boolean' || typeof at !== 'string' || typeof madeBy !== 'string') {
    return refuse('a change needs text title, at and madeBy, and a true or false done')
  }
  if (typeof visibleAt !== 'number') return refuse('visibleAt must be a number')
  const fields = parseChanged(changed)
  if (!fields.ok) return refuse(fields.problem)
  const set = fields.value === undefined ? {} : { changed: fields.value }
  if (hidden === 'all') return { ok: true, value: { title, done, ...set, at, madeBy, visibleAt, hiddenFrom: 'all' } }
  if (!Array.isArray(hidden)) return refuse('hiddenFrom must be "all" or a list of clients')
  const clients: ClientName[] = []
  for (const client of hidden) {
    if (typeof client !== 'string' || !isClientName(client)) return refuse(`hiddenFrom names an unknown client ${String(client)}`)
    clients.push(client)
  }
  return { ok: true, value: { title, done, ...set, at, madeBy, visibleAt, hiddenFrom: clients } }
}

function parseChanged(value: unknown): Parsed<TaskField[] | undefined> {
  if (value === undefined) return { ok: true, value: undefined }
  if (!Array.isArray(value)) return refuse('changed must be a list of fields')
  const fields: TaskField[] = []
  for (const field of value) {
    if (field !== 'title' && field !== 'done') return refuse(`changed names an unknown field ${String(field)}`)
    fields.push(field)
  }
  return { ok: true, value: fields }
}

function refuse(problem: string): { ok: false; problem: string } {
  return { ok: false, problem }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
