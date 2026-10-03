import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Route, RouteHandler } from './route.ts'
import { defectOf, handled, numberField, PAGE_HELPERS, readJson, scriptValue, sendJson, sendPage, stringField, Visitors, workflowPage } from './workflow-page.ts'

type Priority = 'Low' | 'Normal' | 'High'

type Task = { id: number; title: string; notes: string; priority: Priority }

type Board = { tasks: Task[]; backlog: Task[]; nextId: number }

const priorities: readonly Priority[] = ['Low', 'Normal', 'High']

/** The backlog every visitor starts with, in this order. */
export const BACKLOG_SEED: readonly string[] = ['Write release notes', 'Book venue', 'Order badges']

function newBoard(): Board {
  const seededPriorities: readonly Priority[] = ['High', 'Normal', 'Low']
  const backlog = BACKLOG_SEED.map((title, index): Task => ({ id: index + 1, title, notes: '', priority: seededPriorities[index] ?? 'Normal' }))
  return { tasks: [], backlog, nextId: backlog.length + 1 }
}

function priorityOf(value: string | undefined): Priority {
  return priorities.find((priority) => priority === value) ?? 'Normal'
}

const priorityOptions = priorities.map((priority) => `<option${priority === 'Normal' ? ' selected' : ''}>${priority}</option>`).join('')

// The list is drawn from what the server answers, never from what was typed, so a save the server got wrong
// shows as wrong.
const TASKS_SCRIPT = (initial: readonly Task[]): string => `${PAGE_HELPERS}
const render = (tasks) => {
  byTestId('tasks').replaceChildren(...tasks.map((task) => {
    const item = document.createElement('li')
    item.dataset.testid = 'task'
    const part = (testId, text) => {
      const span = document.createElement('span')
      span.dataset.testid = testId
      span.textContent = text
      return span
    }
    item.append(part('task-title', task.title), ' ', part('task-priority', task.priority), ' ', part('task-notes', task.notes))
    return item
  }))
  byTestId('task-count').textContent = tasks.length === 0 ? 'No tasks yet' : tasks.length === 1 ? '1 task' : tasks.length + ' tasks'
}
render(${scriptValue(initial)})
const form = byTestId('new-task')
form.addEventListener('submit', async (event) => {
  event.preventDefault()
  byTestId('form-error').textContent = ''
  byTestId('form-status').textContent = 'Saving…'
  const response = await fetch(withDefect('/workflow/api/tasks'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: form.elements.title.value, notes: form.elements.notes.value, priority: form.elements.priority.value }),
  })
  const answer = await response.json()
  byTestId('form-status').textContent = ''
  if (!response.ok) {
    byTestId('form-error').textContent = answer.error
    return
  }
  render(answer.tasks)
  form.reset()
  byTestId('form-status').textContent = 'Task added'
})
`

function tasksPage(tasks: readonly Task[]): string {
  return workflowPage(
    'Tasks',
    `<form data-testid="new-task" novalidate>
<p><label for="title">Title</label> <input id="title" name="title" autocomplete="off"></p>
<p><label for="notes">Notes</label> <textarea id="notes" name="notes"></textarea></p>
<p><label for="priority">Priority</label> <select id="priority" name="priority">${priorityOptions}</select></p>
<p><button type="submit">Add task</button></p>
</form>
<p role="status" data-testid="form-status"></p>
<p role="alert" data-testid="form-error"></p>
<p data-testid="task-count"></p>
<ul data-testid="tasks"></ul>`,
    TASKS_SCRIPT(tasks),
  )
}

// One row at a time is edited or asked about. Every row's buttons are named after the task, as a screen reader
// would read them, so a test finds the one it means without scoping. A row being deleted keeps its title until the
// server answers, so the list never shows a delete the server has not made.
const BACKLOG_SCRIPT = (initial: readonly Task[]): string => `${PAGE_HELPERS}
let items = ${scriptValue(initial)}
let editing = null
let confirming = null
const element = (tag, properties, ...children) => {
  const made = Object.assign(document.createElement(tag), properties)
  made.append(...children)
  return made
}
const button = (text, label, onClick) => {
  const made = element('button', { type: 'button', textContent: text })
  if (label !== null) made.setAttribute('aria-label', label)
  made.addEventListener('click', onClick)
  return made
}
const send = async (path, body) => {
  const response = await fetch(withDefect(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  items = (await response.json()).tasks
  editing = null
  confirming = null
  render()
}
const row = (task) => {
  const item = element('li')
  item.dataset.testid = 'backlog-item'
  if (editing === task.id) {
    const title = element('input', { id: 'edit-title', value: task.title, autocomplete: 'off' })
    const priority = element('select', { id: 'edit-priority' }, ...${scriptValue(priorities)}.map((name) => element('option', { textContent: name, selected: name === task.priority })))
    item.append(
      element('label', { htmlFor: 'edit-title', textContent: 'Title' }), ' ', title, ' ',
      element('label', { htmlFor: 'edit-priority', textContent: 'Priority' }), ' ', priority, ' ',
      button('Save', null, () => send('/workflow/api/backlog/update', { id: task.id, title: title.value, priority: priority.value })), ' ',
      button('Cancel', null, () => { editing = null; render() }),
    )
    return item
  }
  const title = element('span', { textContent: task.title })
  title.dataset.testid = 'item-title'
  if (confirming === task.id) {
    const question = element('span', { textContent: 'Delete "' + task.title + '"?' })
    question.dataset.testid = 'delete-question'
    const confirm = button('Yes, delete', null, () => {
      question.textContent = 'Deleting…'
      confirm.disabled = true
      send('/workflow/api/backlog/delete', { id: task.id })
    })
    item.append(title, ' ', question, ' ', confirm, ' ', button('Cancel', null, () => { confirming = null; render() }))
    return item
  }
  const priority = element('span', { textContent: task.priority })
  priority.dataset.testid = 'item-priority'
  item.append(
    title, ' ', priority, ' ',
    button('Edit', 'Edit ' + task.title, () => { editing = task.id; confirming = null; render() }), ' ',
    button('Delete', 'Delete ' + task.title, () => { confirming = task.id; editing = null; render() }),
  )
  return item
}
const render = () => {
  byTestId('backlog').replaceChildren(...items.map(row))
  byTestId('backlog-count').textContent = items.length === 1 ? '1 task' : items.length + ' tasks'
}
render()
`

function backlogPage(tasks: readonly Task[]): string {
  return workflowPage('Backlog', '<p data-testid="backlog-count"></p>\n<ul data-testid="backlog"></ul>', BACKLOG_SCRIPT(tasks))
}

// The defects a real regression would cause: a save that drops the last character of the title, an edit the
// server answers as saved but never keeps, and a delete that removes the row after the one asked for.
async function addTask(board: Board, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJson(request)
  const title = (stringField(body, 'title') ?? '').trim()
  if (title === '') {
    sendJson(response, 400, { error: 'Give the task a title.' })
    return
  }
  if (board.tasks.some((task) => task.title.toLowerCase() === title.toLowerCase())) {
    sendJson(response, 409, { error: `A task named "${title}" already exists.` })
    return
  }
  const saved = defectOf(request) === 'drops-last-character' ? title.slice(0, -1) : title
  board.tasks.push({ id: board.nextId, title: saved, notes: (stringField(body, 'notes') ?? '').trim(), priority: priorityOf(stringField(body, 'priority')) })
  board.nextId += 1
  sendJson(response, 201, { tasks: board.tasks })
}

async function updateTask(board: Board, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJson(request)
  const id = numberField(body, 'id')
  const title = (stringField(body, 'title') ?? '').trim()
  const changed = board.backlog.map((task) => (task.id === id && title !== '' ? { ...task, title, priority: priorityOf(stringField(body, 'priority')) } : task))
  if (defectOf(request) !== 'edit-not-saved') board.backlog = changed
  sendJson(response, 200, { tasks: changed })
}

async function deleteTask(board: Board, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const id = numberField(await readJson(request), 'id')
  const index = board.backlog.findIndex((task) => task.id === id)
  const removed = defectOf(request) === 'deletes-wrong-row' && index >= 0 ? (index + 1) % board.backlog.length : index
  if (removed >= 0) board.backlog.splice(removed, 1)
  sendJson(response, 200, { tasks: board.backlog })
}

/**
 * Families 4 and 5, create, edit and delete an object: a task board that starts empty for each visitor, with a
 * form that adds tasks and refuses a duplicate title, and a backlog that starts with three tasks to edit and
 * delete. The server keeps both, so a reload shows what it saved. Defects: `drops-last-character` on the board,
 * `edit-not-saved` and `deletes-wrong-row` on the backlog.
 */
export function tasksRoutes(): Route[] {
  const boards = new Visitors(newBoard)
  const withBoard =
    (work: (board: Board, request: IncomingMessage, response: ServerResponse) => Promise<void>): RouteHandler =>
    (request, response) =>
      handled(work(boards.of(request, response), request, response), response)
  return [
    ['GET /workflow/tasks', (request, response) => sendPage(response, tasksPage(boards.of(request, response).tasks))],
    ['POST /workflow/api/tasks', withBoard(addTask)],
    ['GET /workflow/backlog', (request, response) => sendPage(response, backlogPage(boards.of(request, response).backlog))],
    ['POST /workflow/api/backlog/update', withBoard(updateTask)],
    ['POST /workflow/api/backlog/delete', withBoard(deleteTask)],
  ]
}
