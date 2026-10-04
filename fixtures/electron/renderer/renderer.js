// Draws the tasks the main process holds. Nothing is kept in the window, so a reload draws the same list.
const list = document.querySelector('[data-testid="task-list"]')
const total = document.querySelector('[data-testid="task-total"]')
const wrongTotal = document.querySelector('[data-testid="wrong-total"]')
const title = document.querySelector('[data-testid="task-title"]')

function plural(count) {
  return `${count} ${count === 1 ? 'task' : 'tasks'}`
}

function draw(tasks) {
  list.replaceChildren(
    ...tasks.map((task) => {
      const item = document.createElement('li')
      item.dataset.testid = 'task-item'
      item.className = task.done ? 'done' : ''
      const id = document.createElement('span')
      id.dataset.testid = 'task-id'
      id.textContent = task.id
      const name = document.createElement('span')
      name.dataset.testid = 'task-name'
      name.textContent = task.title
      const done = document.createElement('input')
      done.type = 'checkbox'
      done.checked = task.done
      done.dataset.testid = 'task-done'
      done.setAttribute('aria-label', `Done: ${task.title}`)
      done.addEventListener('change', async () => draw(await window.fixture.toggle(task.id, done.checked)))
      item.append(id, name, done)
      return item
    }),
  )
  total.textContent = plural(tasks.length)
  // The deliberate defect: one more than there are.
  wrongTotal.textContent = plural(tasks.length + 1)
}

document.querySelector('[data-testid="task-form"]').addEventListener('submit', async (event) => {
  event.preventDefault()
  const tasks = await window.fixture.add(title.value)
  title.value = ''
  draw(tasks)
  // A console line the page writes after it opened, for the diagnostics Retest collects from the window.
  console.info(`The list holds ${plural(tasks.length)}.`)
})

document.querySelector('[data-testid="open-second-window"]').addEventListener('click', () => {
  void window.fixture.openSecondWindow()
})

// Closed a moment later, so the click that asked for it has its answer first.
document.querySelector('[data-testid="close-window"]').addEventListener('click', () => {
  setTimeout(() => window.close(), 300)
})

async function drawVariables() {
  const variables = await window.fixture.variables()
  document.querySelector('[data-testid="variables"]').replaceChildren(
    ...variables.map(({ name, present }) => {
      const item = document.createElement('li')
      const value = document.createElement('span')
      value.dataset.testid = `variable-${name}`
      value.textContent = present ? 'present' : 'absent'
      item.append(`${name}: `, value)
      return item
    }),
  )
}

void window.fixture.list().then(draw)
void drawVariables()
