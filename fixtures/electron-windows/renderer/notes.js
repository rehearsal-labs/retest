// The notes window, which the first window opened: what it sends goes back to its opener.
document.querySelector('[data-testid="send"]').addEventListener('click', () => {
  const text = document.getElementById('note').value
  document.querySelector('[data-testid="sent"]').textContent = `Sent: ${text}`
  window.opener?.postMessage({ kind: 'note', text }, '*')
})
