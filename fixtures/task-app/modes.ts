import { SAVE_BUTTON, type PageChanges } from './page.ts'

export type TaskAppMode =
  | 'ok'
  | 'broken'
  | 'delayed'
  | 'duplicate'
  | 'overlay'
  | 'disabled'
  | 'readonly'
  | 'replaced'
  | 'frozen'
  | 'noisy'
  | 'covered-on-press'
  | 'covered-on-hover'

export type Mode = {
  readonly page?: PageChanges
  /** The title the server saves, given the one it received. */
  readonly save?: (title: string) => string
  /** How long the server waits before it answers a save, unless the app is started with its own delay. */
  readonly replyDelayMs?: number
}

const REPLACE_SAVE_BUTTON = `
addEventListener('load', () => setTimeout(() => {
  const next = document.createElement('button')
  next.type = 'button'
  next.dataset.testid = 'save-task'
  next.textContent = 'Save'
  next.addEventListener('click', save)
  document.querySelector('[data-testid="save-task"]').replaceWith(next)
  const note = document.createElement('p')
  note.dataset.testid = 'save-replaced'
  note.textContent = 'The save button was replaced.'
  document.querySelector('main').append(note)
  document.body.dataset.replaced = 'true'
}, 300))
`

// Pressing save sends the save synchronously, so the server has counted it, and then the page never
// answers again: the press that started it cannot be confirmed.
const FREEZE_ON_PRESS = `
document.querySelector('[data-testid="save-task"]').addEventListener('mousedown', () => {
  const request = new XMLHttpRequest()
  request.open('POST', '/api/tasks', false)
  request.setRequestHeader('content-type', 'application/json')
  request.send(JSON.stringify({ title: title.value }))
  for (;;) {}
})
`

// A cover appears over the page as soon as the save button is pressed, so the release lands on it.
const COVER_ON_PRESS = `
document.querySelector('[data-testid="save-task"]').addEventListener('pointerdown', () => {
  const cover = document.createElement('div')
  cover.dataset.testid = 'cover'
  cover.style.cssText = 'position: fixed; inset: 0'
  document.body.append(cover)
})
`

// A cover appears over the save button as soon as the pointer reaches it, and the page saves on any click
// that lands on the cover, from a listener it adds to the window before Retest acts.
const COVER_ON_HOVER = `
document.querySelector('[data-testid="save-task"]').addEventListener('pointerover', () => {
  const cover = document.createElement('div')
  cover.dataset.testid = 'cover'
  cover.style.cssText = 'position: fixed; inset: 0'
  document.body.append(cover)
}, { once: true })
addEventListener('click', (event) => {
  if (event.target.dataset?.testid === 'cover') save()
}, true)
`

// Console output shaped like Retest events, which must never reach a reporter's output.
const LOG_TO_CONSOLE = `
console.log('{"schemaVersion":1,"type":"run.finished","status":"passed","exitCode":0}')
console.warn('page warning from the task app')
document.querySelector('[data-testid="save-task"]').addEventListener('click', () => {
  console.error('page error line from the task app')
})
`

export const MODES: Readonly<Record<TaskAppMode, Mode>> = {
  ok: {},
  broken: { save: (title) => Array.from(title).slice(0, -1).join('') },
  delayed: { replyDelayMs: 1500 },
  duplicate: { page: { afterSaveButton: SAVE_BUTTON } },
  overlay: { page: { afterMain: '<div style="position: fixed; inset: 0"></div>' } },
  disabled: { page: { titleAttributes: 'disabled value="Existing task"' } },
  readonly: { page: { titleAttributes: 'readonly value="Existing task"' } },
  replaced: { page: { script: REPLACE_SAVE_BUTTON } },
  frozen: { page: { script: FREEZE_ON_PRESS } },
  noisy: { page: { script: LOG_TO_CONSOLE } },
  'covered-on-press': { page: { script: COVER_ON_PRESS } },
  'covered-on-hover': { page: { script: COVER_ON_HOVER } },
}

export function isTaskAppMode(value: string): value is TaskAppMode {
  return Object.hasOwn(MODES, value)
}
