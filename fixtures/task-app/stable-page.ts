// A page whose pixels are the same on every load, for screenshot comparisons: no text and no font, only boxes of flat
// colour and a canvas of bars drawn on whole pixels, no scrollbars and nothing that blinks. Its query changes it:
// `colour=changed` paints the swatch another colour, `size=wide` makes the swatch 40 pixels wider, `motion=forever` adds
// a box that slides back and forth for as long as the page is open, `settle=<ms>` shows a bar that travels for that
// long and then goes, leaving the page as it is without it, and `tall=1` lets the page scroll down to a box 900 pixels
// from its top. Neither moving box comes back to a place it was in within a second, so two pictures taken while one
// moves are never the same. `late=<ms>` paints the swatch grey, as a loading state, and gives it its colour that long
// after the page starts. `opener=1` adds a box that opens the stable page as a popup. A box that is never displayed is
// there for a look that finds an element it cannot picture.

const STYLE = `
html, body { margin: 0; overflow: hidden; background: #f4f1ea; }
.bar { height: 40px; background: #2b5d8a; }
.swatch { position: absolute; left: 24px; top: 64px; width: 120px; height: 80px; background: #d94f30; }
.swatch.changed { background: #2f9e44; }
.swatch.wide { width: 160px; }
.swatch.loading { background: #999999; }
.opener { position: absolute; left: 24px; top: 240px; width: 40px; height: 24px; background: #2b8a5d; }
html.tall, html.tall body { overflow: auto; }
html.tall body { height: 1400px; }
.far { display: none; position: absolute; left: 40px; top: 900px; width: 100px; height: 60px; background: #4a2b8a; }
html.tall .far { display: block; }
.never { display: none; }
.chart { position: absolute; left: 192px; top: 64px; }
.mover { position: absolute; left: 24px; top: 168px; width: 40px; height: 40px; background: #8a2b5d; animation: slide 4000ms linear infinite alternate; }
.spinner { position: absolute; left: 192px; top: 200px; width: 32px; height: 16px; background: #e0a526; animation: travel 1000ms linear infinite; }
@keyframes slide { from { transform: translateX(0) } to { transform: translateX(320px) } }
@keyframes travel { from { transform: translateX(0) } to { transform: translateX(128px) } }
`

const SCRIPT = `
const query = new URLSearchParams(location.search)
const swatch = document.querySelector('[data-testid="swatch"]')
if (query.get('colour') === 'changed') swatch.classList.add('changed')
if (query.get('size') === 'wide') swatch.classList.add('wide')
if (query.get('tall') === '1') document.documentElement.classList.add('tall')
const late = Number(query.get('late') ?? '0')
if (late > 0) {
  swatch.classList.add('loading')
  setTimeout(() => swatch.classList.remove('loading'), late)
}
if (query.get('opener') === '1') {
  const opener = document.createElement('div')
  opener.className = 'opener'
  opener.dataset.testid = 'opener'
  opener.addEventListener('click', () => window.open('/stable'))
  document.body.append(opener)
}
const chart = document.querySelector('[data-testid="chart"]').getContext('2d')
chart.fillStyle = '#ffffff'
chart.fillRect(0, 0, 160, 120)
const bars = [40, 90, 60, 110, 30]
bars.forEach((height, index) => {
  chart.fillStyle = index % 2 === 0 ? '#2b5d8a' : '#5d8a2b'
  chart.fillRect(8 + index * 30, 120 - height, 20, height)
})
if (query.get('motion') === 'forever') {
  const mover = document.createElement('div')
  mover.className = 'mover'
  mover.dataset.testid = 'mover'
  document.body.append(mover)
}
const settle = Number(query.get('settle') ?? '0')
if (settle > 0) {
  const spinner = document.createElement('div')
  spinner.className = 'spinner'
  spinner.dataset.testid = 'spinner'
  document.body.append(spinner)
  setTimeout(() => spinner.remove(), settle)
}
`

/** The stable page, served at `/stable`. */
export const STABLE_PAGE: string = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Stable page</title>
<link rel="icon" href="data:,">
<style>${STYLE}</style>
</head>
<body>
<div class="bar" data-testid="bar"></div>
<div class="swatch" data-testid="swatch"></div>
<canvas class="chart" data-testid="chart" width="160" height="120"></canvas>
<div class="far" data-testid="far"></div>
<div class="never" data-testid="never"></div>
<script>${SCRIPT}</script>
</body>
</html>
`
