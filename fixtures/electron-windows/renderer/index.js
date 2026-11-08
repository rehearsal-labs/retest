// The first window: it opens the notes window itself, asks the main process for the settings window, hears the notes
// window's message, sees it close, and shows the theme the main process holds.
const status = document.querySelector('[data-testid="status"]')
const theme = document.querySelector('[data-testid="theme"]')

document.querySelector('[data-testid="open-notes"]').addEventListener('click', () => {
  const notes = window.open('notes.html', 'notes', 'width=380,height=320')
  const watching = setInterval(() => {
    if (notes === null || !notes.closed) return
    clearInterval(watching)
    status.textContent = 'Notes closed'
  }, 50)
})

window.addEventListener('message', (event) => {
  const { data } = event
  if (typeof data === 'object' && data !== null && data.kind === 'note') status.textContent = `Note: ${String(data.text)}`
})

document.querySelector('[data-testid="open-settings"]').addEventListener('click', () => {
  void window.fixture.openSettings()
})

document.querySelector('[data-testid="open-settings-later"]').addEventListener('click', () => {
  void window.fixture.openSettingsLater()
})

function show(value) {
  theme.textContent = `Theme: ${value}`
}

window.fixture.onThemeChanged(show)
void window.fixture.theme().then(show)
