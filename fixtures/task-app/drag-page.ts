import type { Route } from './route.ts'
import { text } from 'node:stream/consumers'
import { htmlPage } from './html.ts'
import { HTML_TYPE, JSON_TYPE, respondWith } from './route.ts'

// Drag and drop the two ways pages do it, each within one viewport of 800 by 600:
// - a board of cards with HTML drag and drop (`draggable`, `dragstart`, `dragover`, `drop`), whose drop posts the move,
//   so the server records which card went to which column;
// - a list a person sorts by its handles, which follows mousedown, mousemove and mouseup on the document itself, counts
//   the moves it hears while the button is down, and writes the new order into the page;
// - a drop zone that shows every type and value its drop's `dataTransfer` carries;
// - a slot under an overlay, which no drop can reach, and a handle a cover hides once the mouse arrives;
// - a slot the page moves aside once a drag begins, and a zone that leaves the page then, each for an HTML drag and for
//   one by the handle;
// - a zone a cover hides once a drag begins, and a zone whose dragover keeps the page busy, with a button to click after;
// - a count of the presses and the releases the page heard, anywhere.
const DRAG_STYLE = `
* { box-sizing: border-box; }
body { margin: 0; font: 13px system-ui; }
main { padding: 4px 8px; }
h1 { font-size: 15px; margin: 0 0 4px; }
p { margin: 2px 0; }
.row { display: flex; gap: 8px; margin-bottom: 8px; }
.column { width: 150px; min-height: 90px; border: 1px solid #888; padding: 4px; }
.card { border: 1px solid #555; background: #eef; padding: 4px; margin: 2px 0; cursor: grab; }
.slots { display: flex; gap: 8px; }
.slot { width: 90px; height: 40px; border: 1px dashed #888; }
.item { display: flex; gap: 6px; align-items: center; height: 28px; }
.handle { width: 40px; height: 22px; background: #cfc; border: 1px solid #484; }
.zone { width: 150px; height: 60px; border: 1px solid #a66; padding: 4px; }
.locked { position: relative; width: 150px; height: 60px; }
.overlay { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.3); }
`

const DRAG_SCRIPT = `
const byTestId = (testId) => document.querySelector('[data-testid="' + testId + '"]')
const show = (testId, text) => { byTestId(testId).textContent = text }

// Every press and every release the page hears anywhere, so a test can tell that a drag that failed first sent nothing,
// and that an HTML drop ends with no release, as a person's does.
let presses = 0
let releases = 0
addEventListener('pointerdown', () => show('presses', String(++presses)), { capture: true })
for (const type of ['pointerup', 'mouseup']) addEventListener(type, () => show('releases', String(++releases)), { capture: true })

// The board: a card carries its id, and a column takes it and tells the server.
for (const card of document.querySelectorAll('.card')) {
  card.addEventListener('dragstart', (event) => {
    event.dataTransfer.setData('text/plain', card.dataset.card)
    event.dataTransfer.effectAllowed = 'move'
  })
  card.addEventListener('dragend', (event) => show('board-ended', 'ended ' + card.dataset.card + ' ' + event.dataTransfer.dropEffect))
}
for (const column of document.querySelectorAll('.column')) {
  column.addEventListener('dragover', (event) => event.preventDefault())
  column.addEventListener('drop', async (event) => {
    event.preventDefault()
    const id = event.dataTransfer.getData('text/plain')
    const card = document.querySelector('[data-card="' + id + '"]')
    if (card === null) return
    column.append(card)
    const response = await fetch('/drag/moves', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ card: id, column: column.dataset.column }) })
    show('board-status', 'saved ' + id + ' in ' + column.dataset.column + ' ' + response.status)
  })
}

// The sortable list: the item whose handle was pressed goes to the slot under the mouse when it is released.
let lifted = null
let moves = 0
for (const handle of document.querySelectorAll('.handle')) {
  handle.addEventListener('mousedown', (event) => {
    lifted = handle.dataset.item
    moves = 0
    event.preventDefault()
  })
}
document.addEventListener('mousemove', (event) => {
  if (lifted === null || (event.buttons & 1) === 0) return
  moves += 1
  show('pointer-moves', String(moves))
  if (lifted === 'vanish') byTestId('vanishing-slot')?.remove()
  if (lifted === 'moving') byTestId('moving-slot').style.marginLeft = '120px'
})
document.addEventListener('mouseup', (event) => {
  if (lifted === null) return
  const slot = [...document.querySelectorAll('.slot')].find((each) => {
    const box = each.getBoundingClientRect()
    return event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom
  })
  show('order', slot === undefined ? lifted + ' dropped nowhere' : lifted + ' in ' + slot.dataset.testid)
  lifted = null
})

// A zone that shows what its drop carried.
byTestId('data-source').addEventListener('dragstart', (event) => {
  event.dataTransfer.setData('text/plain', 'release notes')
  event.dataTransfer.setData('application/x-task', '{"id":7}')
})
byTestId('data-zone').addEventListener('dragover', (event) => event.preventDefault())
byTestId('data-zone').addEventListener('drop', (event) => {
  event.preventDefault()
  const carried = [...event.dataTransfer.types].map((type) => type + '=' + event.dataTransfer.getData(type))
  show('dropped-data', carried.join('; '))
})

// A locked slot under an overlay: a drop that reached it would say so.
byTestId('locked-slot').addEventListener('dragover', (event) => event.preventDefault())
byTestId('locked-slot').addEventListener('drop', () => show('locked-status', 'dropped on the locked slot'))

// A handle that hides under a cover as soon as the mouse arrives on it, and a cover that tells when it is pressed.
byTestId('shy-handle').addEventListener('mouseover', () => { byTestId('shy-cover').hidden = false })
for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) byTestId('shy-cover').addEventListener(type, () => show('cover-status', 'heard ' + type))

// A slot the page moves aside once a drag begins, by the handle or by the card.
byTestId('moving-card').addEventListener('dragstart', (event) => {
  event.dataTransfer.setData('text/plain', 'moving')
  setTimeout(() => { byTestId('moving-slot').style.marginLeft = '120px' }, 0)
})
byTestId('moving-slot').addEventListener('dragover', (event) => event.preventDefault())
byTestId('moving-slot').addEventListener('drop', (event) => show('moving-status', 'dropped ' + event.dataTransfer.getData('text/plain')))

// A zone a cover hides as soon as its card's drag begins, so the drop would reach the cover, which takes no drop.
byTestId('cover-card').addEventListener('dragstart', (event) => {
  event.dataTransfer.setData('text/plain', 'covered')
  setTimeout(() => { byTestId('drop-cover').hidden = false }, 0)
})
byTestId('covered-zone').addEventListener('dragover', (event) => event.preventDefault())
byTestId('covered-zone').addEventListener('drop', () => show('covered-status', 'dropped on the covered zone'))
byTestId('cover-card').addEventListener('dragend', (event) => show('cover-ended', 'ended ' + event.dataTransfer.dropEffect))

// A zone whose first dragover keeps the page busy for a second and a half, and a button that tells when it is clicked.
let busy = true
byTestId('busy-card').addEventListener('dragstart', (event) => event.dataTransfer.setData('text/plain', 'busy'))
byTestId('busy-zone').addEventListener('dragover', (event) => {
  event.preventDefault()
  if (!busy) return
  busy = false
  const end = Date.now() + 1500
  while (Date.now() < end) {}
})
byTestId('busy-card').addEventListener('dragend', () => show('busy-status', 'ended'))
byTestId('after').addEventListener('click', () => show('after-status', 'clicked'))

// A zone that leaves the page once its card's drag begins.
byTestId('vanish-card').addEventListener('dragstart', (event) => {
  event.dataTransfer.setData('text/plain', 'vanish')
  setTimeout(() => byTestId('vanishing-zone')?.remove(), 0)
})
byTestId('vanish-card').addEventListener('dragend', (event) => show('vanish-status', 'ended ' + event.dataTransfer.dropEffect))
`

/** The drag page: a board, a sortable list, a zone that reads its drop's data, a covered slot and zones that go. */
export const DRAG_PAGE: string = htmlPage(
  'Drag',
  `<style>${DRAG_STYLE}</style>
<div class="row">
  <div class="column" data-testid="todo-column" data-column="todo">To do
    <div class="card" draggable="true" data-card="notes" data-testid="card-notes">Write release notes</div>
    <div class="card" draggable="true" data-card="login" data-testid="card-login">Fix login bug</div>
  </div>
  <div class="column" data-testid="done-column" data-column="done">Done</div>
  <div>
    <p data-testid="board-status">Nothing moved</p>
    <p data-testid="board-ended">Not ended</p>
  </div>
</div>
<div class="row">
  <div>
    <div class="item"><span class="handle" data-testid="handle" data-item="alpha"></span>Alpha</div>
    <div class="item"><span class="handle" data-testid="vanish-handle" data-item="vanish"></span>Vanish</div>
  </div>
  <div class="slots">
    <div class="slot" data-testid="slot-1"></div>
    <div class="slot" data-testid="slot-2"></div>
    <div class="slot" data-testid="slot-3"></div>
    <div class="slot" data-testid="vanishing-slot"></div>
  </div>
  <div><p data-testid="order">Unsorted</p><p data-testid="pointer-moves">0</p><p data-testid="presses">0</p><p data-testid="releases">0</p></div>
</div>
<div class="row">
  <div class="card" draggable="true" data-testid="data-source">Release notes</div>
  <div class="zone" data-testid="data-zone">Drop data here</div>
  <p data-testid="dropped-data">Nothing dropped</p>
</div>
<div class="row">
  <div class="locked"><div class="zone" data-testid="locked-slot">Locked</div><div class="overlay" data-testid="overlay"></div></div>
  <p data-testid="locked-status">Untouched</p>
  <div class="locked"><span class="handle" data-testid="shy-handle" data-item="shy"></span><div class="overlay" data-testid="shy-cover" hidden></div></div>
  <p data-testid="cover-status">Untouched</p>
</div>
<div class="row">
  <span class="handle" data-testid="moving-handle" data-item="moving"></span>
  <div class="card" draggable="true" data-testid="moving-card">Moving card</div>
  <div class="slot" data-testid="moving-slot"></div>
  <p data-testid="moving-status">Not dropped</p>
</div>
<div class="row">
  <div class="card" draggable="true" data-testid="cover-card">Covered card</div>
  <div class="locked"><div class="zone" data-testid="covered-zone">Covered zone</div><div class="overlay" data-testid="drop-cover" hidden></div></div>
  <p data-testid="covered-status">Untouched</p>
  <p data-testid="cover-ended">Not ended</p>
</div>
<div class="row">
  <div class="card" draggable="true" data-testid="busy-card">Busy card</div>
  <div class="zone" data-testid="busy-zone">Busy zone</div>
  <p data-testid="busy-status">Not ended</p>
  <button type="button" data-testid="after">After</button>
  <p data-testid="after-status">Not clicked</p>
</div>
<div class="row">
  <div class="card" draggable="true" data-testid="vanish-card">Vanishing card</div>
  <div class="zone" data-testid="vanishing-zone">Gone soon</div>
  <p data-testid="vanish-status">Not ended</p>
</div>`,
  DRAG_SCRIPT,
)

// A page that stops every dragstart from going further as it loads, before any listener of an element hears it, as some
// drag libraries do, with a zone that takes the drop and a button to click after.
const STOPPED_SCRIPT = `
addEventListener('dragstart', (event) => event.stopImmediatePropagation(), { capture: true })
const byTestId = (testId) => document.querySelector('[data-testid="' + testId + '"]')
byTestId('stopped-zone').addEventListener('dragover', (event) => event.preventDefault())
byTestId('stopped-zone').addEventListener('drop', (event) => {
  event.preventDefault()
  byTestId('stopped-status').textContent = 'dropped'
})
byTestId('after').addEventListener('click', () => { byTestId('after-status').textContent = 'clicked' })
`

/** The page that stops every dragstart's propagation as it loads. */
export const STOPPED_DRAG_PAGE: string = htmlPage(
  'Stopped drag',
  `<style>${DRAG_STYLE}</style>
<div class="row">
  <div class="card" draggable="true" data-testid="stopped-card">Stopped card</div>
  <div class="zone" data-testid="stopped-zone">Zone</div>
  <p data-testid="stopped-status">Nothing dropped</p>
  <button type="button" data-testid="after">After</button>
  <p data-testid="after-status">Not clicked</p>
</div>`,
  STOPPED_SCRIPT,
)

/** A card's move, as the board's drop posted it. */
export type DragMove = { card: string; column: string }

/** The routes of the drag page, and the moves its board posted, in order, each test app its own. */
export function dragRoutes(): Route[] {
  const moves: DragMove[] = []
  return [
    ['GET /drag', (_request, response) => respondWith(response, 200, HTML_TYPE, DRAG_PAGE)],
    ['GET /drag/stopped', (_request, response) => respondWith(response, 200, HTML_TYPE, STOPPED_DRAG_PAGE)],
    [
      'POST /drag/moves',
      async (request, response) => {
        const move: unknown = JSON.parse(await text(request))
        if (typeof move === 'object' && move !== null && 'card' in move && 'column' in move && typeof move.card === 'string' && typeof move.column === 'string') moves.push({ card: move.card, column: move.column })
        respondWith(response, 201, JSON_TYPE, JSON.stringify({ saved: true }))
      },
    ],
    ['GET /drag/moves', (_request, response) => respondWith(response, 200, JSON_TYPE, JSON.stringify(moves))],
  ]
}
