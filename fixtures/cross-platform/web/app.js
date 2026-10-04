// The web client of the cross-platform fixture. It talks to the service that serves it, names itself `web` in every
// request, and finds every task by its id. It asks for the task list once a second while signed in, because a change
// another client made reaches this one only after the service's sync delay. The open task's id is the page's address,
// `/tasks/<id>`, so a test can read it from the address and a link can open the task.

const CLIENT = 'web'
const POLL_MS = 1000
const TOKEN_KEY = 'tasks-token'

const TASK_ADDRESS = /^\/tasks\/([^/]+)$/

const byTestId = (id) => document.querySelector(`[data-testid="${id}"]`)

const signInView = document.getElementById('sign-in-view')
const tasksView = document.getElementById('tasks-view')
const editor = document.getElementById('editor')
const taskList = byTestId('task-list')

/** Rows of the task list by task id, so a refresh changes text in place and never replaces a row someone may click. */
const rows = new Map()

let token = sessionStorage.getItem(TOKEN_KEY)
let selectedId = null
let pollTimer = undefined
let polling = false
// Counts the starts and ends of writes. A refresh that overlapped a write may carry the tasks from before it, so its
// answer is dropped and the next refresh brings the list.
let writeEvents = 0

class SessionEnded extends Error {}

async function call(method, path, body) {
  const headers = { 'x-task-client': CLIENT }
  if (token !== null) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  let response
  try {
    response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch {
    setText(byTestId('service-status'), 'Cannot reach the service.')
    throw new Error('Cannot reach the service.')
  }
  setText(byTestId('service-status'), '')
  const data = await response.json().catch(() => ({}))
  if (response.status === 401 && token !== null && path !== '/api/sign-in') {
    signOutLocally('Your session ended. Sign in again.')
    throw new SessionEnded()
  }
  return { status: response.status, ok: response.ok, data }
}

// A request that changes tasks, counted at its start and its end.
async function write(method, path, body) {
  writeEvents += 1
  try {
    return await call(method, path, body)
  } finally {
    writeEvents += 1
  }
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text
}

function stateText(done) {
  return done ? 'Done' : 'Open'
}

function showSignedIn(account) {
  setText(byTestId('signed-in-account'), account.id)
  setText(byTestId('signed-in-name'), account.name)
  byTestId('session-bar').hidden = false
  signInView.hidden = true
  tasksView.hidden = false
  schedulePoll(0)
  const address = TASK_ADDRESS.exec(location.pathname)
  if (address !== null) openTask(decodeURIComponent(address[1]))
}

function showAddress(path) {
  if (location.pathname !== path) history.replaceState(null, '', path)
}

function signOutLocally(message) {
  token = null
  sessionStorage.removeItem(TOKEN_KEY)
  clearTimeout(pollTimer)
  pollTimer = undefined
  selectedId = null
  for (const entry of rows.values()) entry.row.remove()
  rows.clear()
  editor.hidden = true
  byTestId('created').hidden = true
  setText(byTestId('created-task-id'), '')
  setText(byTestId('list-status'), '')
  showAddress('/')
  byTestId('session-bar').hidden = true
  tasksView.hidden = true
  signInView.hidden = false
  setText(byTestId('sign-in-error'), message)
}

function schedulePoll(delay) {
  clearTimeout(pollTimer)
  pollTimer = setTimeout(poll, delay)
}

async function poll() {
  if (token === null || polling) return
  polling = true
  setText(byTestId('list-status'), 'Refreshing')
  const writesBefore = writeEvents
  try {
    const result = await call('GET', '/api/tasks')
    if (result.ok && writeEvents === writesBefore) renderTasks(result.data.tasks)
  } catch (error) {
    if (error instanceof SessionEnded) return
  } finally {
    polling = false
    if (token !== null) setText(byTestId('list-status'), 'Up to date')
  }
  if (token !== null) schedulePoll(POLL_MS)
}

function renderTasks(tasks) {
  const seen = new Set()
  tasks.forEach((task, index) => {
    seen.add(task.id)
    const entry = rows.get(task.id) ?? addRow(task.id, tasks.slice(index + 1))
    renderRow(entry, task)
  })
  for (const [id, entry] of rows) {
    if (seen.has(id)) continue
    entry.row.remove()
    rows.delete(id)
  }
  setText(byTestId('task-count'), tasks.length === 1 ? '1 task' : `${tasks.length} tasks`)
  if (selectedId !== null) renderSelected(tasks.find((task) => task.id === selectedId))
}

// Puts a new row before the first row of a task that comes after it, so rows already shown never move.
function addRow(id, later) {
  const row = document.createElement('tr')
  row.dataset.testid = `task-row-${id}`
  row.dataset.taskId = id
  const idCell = document.createElement('td')
  const idText = document.createElement('code')
  idText.dataset.testid = `task-id-${id}`
  idText.textContent = id
  idCell.append(idText)
  const title = document.createElement('td')
  title.dataset.testid = `task-title-${id}`
  const state = document.createElement('td')
  state.dataset.testid = `task-state-${id}`
  const actionCell = document.createElement('td')
  const open = document.createElement('button')
  open.type = 'button'
  open.textContent = 'Open'
  open.setAttribute('aria-label', `Open ${id}`)
  open.dataset.testid = `open-task-${id}`
  open.addEventListener('click', () => openTask(id))
  actionCell.append(open)
  row.append(idCell, title, state, actionCell)
  const next = later.map((task) => rows.get(task.id)).find((entry) => entry !== undefined)
  taskList.insertBefore(row, next?.row ?? null)
  const entry = { row, title, state }
  rows.set(id, entry)
  return entry
}

function renderRow(entry, task) {
  setText(entry.title, task.title)
  setText(entry.state, stateText(task.done))
}

function renderSelected(task) {
  if (task === undefined) {
    setText(byTestId('selected-task-state'), 'Not visible to you')
    return
  }
  setText(byTestId('selected-task-title'), task.title)
  setText(byTestId('selected-task-state'), stateText(task.done))
  setText(byTestId('selected-task-revision'), String(task.revision))
}

function select(task) {
  selectedId = task.id
  setText(byTestId('selected-task-id'), task.id)
  renderSelected(task)
  byTestId('edit-title').value = task.title
  byTestId('edit-done').checked = task.done
  setText(byTestId('save-status'), '')
  setText(byTestId('save-error'), '')
  editor.hidden = false
  showAddress(`/tasks/${encodeURIComponent(task.id)}`)
}

async function openTask(id) {
  setText(byTestId('open-error'), '')
  const result = await call('GET', `/api/tasks/${encodeURIComponent(id)}`)
  if (result.status === 404) {
    setText(byTestId('open-error'), `No task ${id} is visible to you yet.`)
    return
  }
  if (!result.ok) {
    setText(byTestId('open-error'), result.data.error ?? 'The task did not open.')
    return
  }
  select(result.data.task)
}

byTestId('sign-in-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  setText(byTestId('sign-in-error'), '')
  const account = byTestId('account').value.trim()
  const password = byTestId('password')
  const result = await call('POST', '/api/sign-in', { account, password: password.value })
  password.value = ''
  if (!result.ok) {
    setText(byTestId('sign-in-error'), result.data.error ?? 'Sign-in failed.')
    return
  }
  token = result.data.token
  sessionStorage.setItem(TOKEN_KEY, token)
  showSignedIn(result.data.account)
})

byTestId('sign-out').addEventListener('click', async () => {
  await call('POST', '/api/sign-out').catch(() => undefined)
  signOutLocally('')
})

byTestId('create-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  setText(byTestId('create-error'), '')
  const title = byTestId('new-task-title')
  const result = await write('POST', '/api/tasks', { title: title.value })
  if (!result.ok) {
    setText(byTestId('create-error'), result.data.error ?? 'The task was not created.')
    return
  }
  const { task } = result.data
  title.value = ''
  setText(byTestId('created-task-id'), task.id)
  byTestId('created').hidden = false
  const entry = rows.get(task.id) ?? addRow(task.id, [])
  renderRow(entry, task)
  select(task)
})

byTestId('open-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const id = byTestId('open-task-id').value.trim()
  if (id !== '') openTask(id)
})

byTestId('edit-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  if (selectedId === null) return
  setText(byTestId('save-status'), '')
  setText(byTestId('save-error'), '')
  const id = selectedId
  const body = { title: byTestId('edit-title').value, done: byTestId('edit-done').checked }
  const result = await write('PATCH', `/api/tasks/${encodeURIComponent(id)}`, body)
  if (result.status === 404) {
    setText(byTestId('save-error'), `Task ${id} is not visible to you.`)
    return
  }
  if (!result.ok) {
    setText(byTestId('save-error'), result.data.error ?? 'The change was not saved.')
    return
  }
  const { task } = result.data
  const entry = rows.get(task.id)
  if (entry !== undefined) renderRow(entry, task)
  if (selectedId === task.id) renderSelected(task)
  setText(byTestId('save-status'), `Saved revision ${task.revision}.`)
})

byTestId('close-task').addEventListener('click', () => {
  selectedId = null
  editor.hidden = true
  showAddress('/')
})

async function resume() {
  if (token === null) return
  try {
    const result = await call('GET', '/api/tasks')
    if (result.ok) showSignedIn(result.data.account)
  } catch {
    // A session that ended or a service that is gone leaves the sign-in form showing what happened.
  }
}

resume()
