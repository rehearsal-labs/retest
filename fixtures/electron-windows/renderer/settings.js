// The settings window, which the main process made: it saves the theme there, and asks before it resets it.
const dark = document.getElementById('dark')
const saved = document.querySelector('[data-testid="saved"]')

void window.fixture.theme().then((theme) => {
  dark.checked = theme === 'dark'
})

async function save(theme) {
  saved.textContent = `Saved: ${await window.fixture.saveTheme(theme)}`
}

document.querySelector('[data-testid="save"]').addEventListener('click', () => {
  void save(dark.checked ? 'dark' : 'light')
})

document.querySelector('[data-testid="reset"]').addEventListener('click', () => {
  if (!confirm('Reset settings?')) return
  dark.checked = false
  void save('light')
})
