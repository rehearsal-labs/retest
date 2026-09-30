import { escapeHtml } from './html.ts'

/** What the device page's server saw of the request, which the page shows beside what its scripts read. */
export type RequestHeaders = { userAgent: string | undefined; clientHints: string | undefined }

// Reads the screen a page sees, and lists the touch and click events its button hears.
const SCRIPT = `
const show = (testId, value) => { document.querySelector('[data-testid="' + testId + '"]').textContent = String(value) }
show('width', innerWidth)
show('pixel-ratio', devicePixelRatio)
show('touch', 'ontouchstart' in window)
show('user-agent', navigator.userAgent)
show('client-hints', navigator.userAgentData.brands.map(({ brand }) => brand).join(', '))
const heard = []
const target = document.querySelector('[data-testid="touch-target"]')
for (const type of ['touchstart', 'touchend', 'click']) {
  target.addEventListener(type, (event) => {
    heard.push(type === 'click' ? 'click:' + (event.pointerType || 'none') : type)
    show('touch-events', heard.join(' '))
  })
}
`

/** A page that shows the screen and user agent it sees, with a button that lists the touch and click events it hears. */
export function renderDevicePage(headers: RequestHeaders): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Device</title>
<link rel="icon" href="data:,">
</head>
<body>
<main>
<h1>Device</h1>
<p>Width: <span data-testid="width"></span></p>
<p>Pixel ratio: <span data-testid="pixel-ratio"></span></p>
<p>Touch screen: <span data-testid="touch"></span></p>
<p>User agent: <span data-testid="user-agent"></span></p>
<p>Client hints: <span data-testid="client-hints"></span></p>
<p>User agent sent: <span data-testid="user-agent-header">${escapeHtml(headers.userAgent ?? '')}</span></p>
<p>Client hints sent: <span data-testid="client-hints-header">${escapeHtml(headers.clientHints ?? '')}</span></p>
<button type="button" data-testid="touch-target" style="width: 200px; height: 80px">Touch me</button>
<p data-testid="touch-events"></p>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`
}
