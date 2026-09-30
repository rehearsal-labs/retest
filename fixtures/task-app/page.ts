/** Markup and script a mode adds to the page. Each value is inserted as written. */
export type PageChanges = {
  titleAttributes?: string
  afterSaveButton?: string
  afterMain?: string
  script?: string
}

export const SAVE_BUTTON: string = '<button type="button" data-testid="save-task">Save</button>'

// The last saved title lives in localStorage and the load count in sessionStorage, so a test can see
// whether it shares storage or a tab with an earlier one.
const SCRIPT = `
const title = document.querySelector('[data-testid="task-title"]')
const saved = document.querySelector('[data-testid="saved-task"]')
const loads = Number(sessionStorage.getItem('page-loads') ?? '0') + 1
sessionStorage.setItem('page-loads', String(loads))
document.querySelector('[data-testid="page-loads"]').textContent = String(loads)
document.querySelector('[data-testid="last-saved"]').textContent = localStorage.getItem('last-saved') ?? ''

async function save() {
  saved.textContent = 'Saving…'
  try {
    const response = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: title.value }),
    })
    if (!response.ok) {
      saved.textContent = 'Could not save'
      return
    }
    const task = await response.json()
    saved.textContent = task.title
    localStorage.setItem('last-saved', task.title)
  } catch {
    saved.textContent = 'Could not save'
  }
}

for (const button of document.querySelectorAll('[data-testid="save-task"]')) {
  button.addEventListener('click', save)
}
`

export function renderPage(changes: PageChanges): string {
  const titleAttributes = changes.titleAttributes === undefined ? '' : ` ${changes.titleAttributes}`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Tasks</title>
<link rel="icon" href="data:,">
<style>
body { font: 16px/1.5 system-ui, sans-serif; margin: 40px; }
main { display: grid; gap: 12px; max-width: 320px; }
</style>
</head>
<body>
<main>
<h1>Tasks</h1>
<label for="task-title">Title</label>
<input id="task-title" data-testid="task-title" autocomplete="off"${titleAttributes}>
${SAVE_BUTTON}${changes.afterSaveButton ?? ''}
<p data-testid="saved-task"></p>
<p>Saved on an earlier visit: <span data-testid="last-saved"></span></p>
<p>Page loads in this tab: <span data-testid="page-loads"></span></p>
</main>
${changes.afterMain ?? ''}
<script>${SCRIPT}${changes.script ?? ''}</script>
</body>
</html>
`
}
