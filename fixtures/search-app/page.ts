/**
 * The search page: a box, a status line and the list of matching titles. The page loads the full list when it
 * opens, and after typing it waits `debounceMs` before it asks the server, as a search box in a real app does.
 */
export function renderSearchPage(debounceMs: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Search</title>
<link rel="icon" href="data:,">
<style>
body { font: 16px/1.5 system-ui, sans-serif; margin: 40px; }
main { display: grid; gap: 12px; max-width: 480px; }
</style>
</head>
<body>
<main>
<h1>Search</h1>
<label for="search">Search</label>
<input id="search" data-testid="search" autocomplete="off">
<p data-testid="status">Loading…</p>
<ul data-testid="results"></ul>
</main>
<script>
const DEBOUNCE_MS = ${debounceMs}
const search = document.querySelector('[data-testid="search"]')
const status = document.querySelector('[data-testid="status"]')
const results = document.querySelector('[data-testid="results"]')
let timer
let latest = 0

function render(items) {
  results.replaceChildren(...items.map((title) => {
    const item = document.createElement('li')
    item.dataset.testid = 'result'
    item.textContent = title
    return item
  }))
}

// Only the latest request may draw, so a slow answer never overwrites a newer one.
async function show(path, describe) {
  const request = ++latest
  const response = await fetch(path)
  const { items } = await response.json()
  if (request !== latest) return
  render(items)
  status.textContent = describe(items)
}

search.addEventListener('input', () => {
  clearTimeout(timer)
  const query = search.value.trim()
  timer = setTimeout(() => {
    if (query === '') show('/api/items', (items) => items.length + ' items')
    else show('/api/search?q=' + encodeURIComponent(query), (items) => items.length + ' results for ' + query)
  }, DEBOUNCE_MS)
})

show('/api/items', (items) => items.length + ' items')
</script>
</body>
</html>
`
}
