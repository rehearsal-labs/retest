import type { Route } from './route.ts'
import { queryOf } from './route.ts'
import { defectOf, PAGE_HELPERS, scriptValue, sendPage, workflowPage } from './workflow-page.ts'

/** The team table's members, in the order the server sends them. */
export const TEAM = [
  { name: 'Ada Lovelace', email: 'ada@example.com', role: 'Admin', tasks: 3 },
  { name: 'Grace Hopper', email: 'grace@example.com', role: 'Editor', tasks: 12 },
  { name: 'Alan Turing', email: 'alan@example.com', role: 'Viewer', tasks: 9 },
  { name: 'Katherine Johnson', email: 'katherine@example.com', role: 'Editor', tasks: 25 },
  { name: 'Edsger Dijkstra', email: 'edsger@example.com', role: 'Viewer', tasks: 4 },
  { name: 'Barbara Liskov', email: 'barbara@example.com', role: 'Admin', tasks: 10 },
] as const

/** How many invoices the long list holds. */
export const INVOICE_COUNT = 60

// Each column header holds a sort button; pressing it again reverses the order. The `sorts-as-text` defect
// compares the open tasks as text, so 10 sorts before 9, as a column typed as text would.
const TEAM_SCRIPT = (defect: string | undefined): string => `${PAGE_HELPERS}
const members = ${scriptValue(TEAM)}
let order = { key: null, direction: 1 }
const compare = (key) => (first, second) => {
  if (key === 'tasks' && ${scriptValue(defect !== 'sorts-as-text')}) return first.tasks - second.tasks
  return String(first[key]).localeCompare(String(second[key]), 'en')
}
const cell = (testId, text) => {
  const made = document.createElement('td')
  made.dataset.testid = testId
  made.textContent = String(text)
  return made
}
const render = () => {
  const sorted = order.key === null ? members : [...members].sort((first, second) => order.direction * compare(order.key)(first, second))
  byTestId('members').replaceChildren(...sorted.map((member) => {
    const row = document.createElement('tr')
    row.dataset.testid = 'member'
    row.append(cell('member-name', member.name), ' ', cell('member-email', member.email), ' ', cell('member-role', member.role), ' ', cell('member-tasks', member.tasks))
    return row
  }))
  for (const button of document.querySelectorAll('[data-sort]')) {
    const header = button.closest('th')
    header.setAttribute('aria-sort', button.dataset.sort !== order.key ? 'none' : order.direction === 1 ? 'ascending' : 'descending')
  }
}
for (const button of document.querySelectorAll('[data-sort]')) {
  button.addEventListener('click', () => {
    order = { key: button.dataset.sort, direction: order.key === button.dataset.sort ? -order.direction : 1 }
    render()
  })
}
render()
`

function teamPage(defect: string | undefined): string {
  const header = (key: string, label: string): string => `<th scope="col" aria-sort="none"><button type="button" data-sort="${key}">${label}</button></th>`
  return workflowPage(
    'Team',
    `<table>
<caption>Team members</caption>
<thead><tr>${header('name', 'Name')} <th scope="col">Email</th> <th scope="col">Role</th> ${header('tasks', 'Open tasks')}</tr></thead>
<tbody data-testid="members"></tbody>
</table>`,
    TEAM_SCRIPT(defect),
  )
}

function invoiceNumber(index: number): string {
  return `INV-${String(index).padStart(4, '0')}`
}

/** The amount the invoice with this number shows. It follows from the number, so a test can know it beforehand. */
export function invoiceAmountOf(index: number): string {
  return `$${(index * 37) % 1000}.${String((index * 13) % 100).padStart(2, '0')}`
}

function invoicesPage(): string {
  const items = Array.from({ length: INVOICE_COUNT }, (_unused, offset) => {
    const number = invoiceNumber(offset + 1)
    return `<li data-testid="invoice"><a href="/workflow/invoices/detail?number=${number}">${number}</a></li>`
  })
  return workflowPage('Invoices', `<ul style="line-height: 2.5">\n${items.join('\n')}\n</ul>`)
}

function invoicePage(number: string): string {
  const index = Number(/^INV-(\d{4})$/.exec(number)?.[1] ?? '0')
  if (index < 1 || index > INVOICE_COUNT) return workflowPage('No such invoice', '<p><a href="/workflow/invoices">Back to invoices</a></p>')
  return workflowPage(
    `Invoice ${invoiceNumber(index)}`,
    `<p>Amount due: <span data-testid="amount">${invoiceAmountOf(index)}</span></p>
<p><a href="/workflow/invoices">Back to invoices</a></p>`,
  )
}

/**
 * Family 8, find items in lists and tables: a team table with sortable name and open-task columns, and a list of
 * sixty invoices, most of them below the fold, each linking to its own page. `?defect=sorts-as-text` on the team
 * page sorts the open tasks as text.
 */
export function listsRoutes(): Route[] {
  return [
    ['GET /workflow/team', (request, response) => sendPage(response, teamPage(defectOf(request)))],
    ['GET /workflow/invoices', (_request, response) => sendPage(response, invoicesPage())],
    ['GET /workflow/invoices/detail', (request, response) => sendPage(response, invoicePage(queryOf(request).get('number') ?? ''))],
  ]
}
