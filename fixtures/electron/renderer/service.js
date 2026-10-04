// The service mode's window. It asks the main process for the tasks once a second while signed in, so a change another
// client made shows up a second at most after the service passes it on. After a create, the page's address names the
// task, `/electron/tasks/<id>`, as the web front end's does.
const byTestId = (id) => document.querySelector(`[data-testid="${id}"]`)
const rows = new Map()

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text
}

function render(tasks) {
  const seen = new Set()
  for (const task of tasks) {
    seen.add(task.id)
    let row = rows.get(task.id)
    if (row === undefined) {
      row = document.createElement('li')
      row.dataset.testid = `task-row-${task.id}`
      for (const part of ['id', 'title', 'state']) {
        const cell = document.createElement('span')
        cell.dataset.testid = `task-${part}-${task.id}`
        row.append(cell)
      }
      byTestId('task-list').append(row)
      rows.set(task.id, row)
    }
    setText(byTestId(`task-id-${task.id}`), task.id)
    setText(byTestId(`task-title-${task.id}`), task.title)
    setText(byTestId(`task-state-${task.id}`), task.done ? 'Done' : 'Open')
  }
  for (const [id, row] of rows) {
    if (seen.has(id)) continue
    row.remove()
    rows.delete(id)
  }
}

async function poll() {
  try {
    render(await window.fixture.service.list())
  } finally {
    setTimeout(poll, 1000)
  }
}

byTestId('sign-in-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  setText(byTestId('sign-in-error'), '')
  const password = byTestId('password')
  const result = await window.fixture.service.signIn(byTestId('account').value.trim(), password.value)
  password.value = ''
  if (!result.ok) return setText(byTestId('sign-in-error'), result.error)
  setText(byTestId('signed-in-account'), result.account)
  byTestId('sign-in-form').hidden = true
  byTestId('signed-in').hidden = false
  void poll()
})

byTestId('create-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  setText(byTestId('create-error'), '')
  const title = byTestId('new-task-title')
  const result = await window.fixture.service.create(title.value)
  if (!result.ok) return setText(byTestId('create-error'), result.error)
  title.value = ''
  setText(byTestId('created-task-id'), result.task.id)
  byTestId('created').hidden = false
  history.pushState(null, '', `/electron/tasks/${encodeURIComponent(result.task.id)}`)
  render(await window.fixture.service.list())
})

void window.fixture.service.account().then((account) => {
  byTestId('account').value = account
})
