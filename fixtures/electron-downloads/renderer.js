// Points each link at the test's file server, and passes the window's choices to the main process.
const files = new URLSearchParams(location.search).get('files') ?? ''

for (const link of document.querySelectorAll('a[data-path]')) link.href = `${files}${link.dataset.path}`

for (const button of document.querySelectorAll('button[data-handling]')) {
  button.addEventListener('click', async () => {
    document.querySelector('[data-testid="handling"]').textContent = await window.fixture.handle(button.dataset.handling)
  })
}

document.querySelector('[data-testid="download-for-window"]').addEventListener('click', () => void window.fixture.downloadForWindow('/files/tasks.csv'))
document.querySelector('[data-testid="download-for-session"]').addEventListener('click', () => void window.fixture.downloadForSession('/files/session.csv'))
