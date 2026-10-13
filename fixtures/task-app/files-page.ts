import type { IncomingMessage } from 'node:http'
import type { Route } from './route.ts'
import { createHash } from 'node:crypto'
import { buffer } from 'node:stream/consumers'
import { escapeHtml, htmlPage } from './html.ts'
import { HTML_TYPE, JSON_TYPE, respondWith } from './route.ts'

/** The CSV the export link and the script's export serve, which a test compares a saved download with. */
export const TASKS_CSV = 'title,done\nRelease checklist,false\nWrite notes,true\n'

/** A file the server received in a form, as it recorded it: the field, the file's name, its type, size and SHA-256. */
export type ReceivedFile = { field: string; name: string; type: string; size: number; sha256: string }

// Each input says what its change gave it, from the page's own listeners, so a test can tell the page heard the change.
// The upload button opens the hidden input's picker, as a styled upload button does; the late button opens it after the
// click has answered. The clearing input empties itself once its change is heard, as a page that reads an input and
// resets it does. The script export downloads a blob through a link it makes and clicks; the frame export adds a frame
// of another site, `localhost` beside `127.0.0.1`, that downloads as it loads; the opened export opens a page whose own
// frame downloads; and the key download saves whatever the key field holds.
const SCRIPT = `
const byTestId = (testId) => document.querySelector('[data-testid="' + testId + '"]')
const heard = byTestId('heard')
for (const input of document.querySelectorAll('input[type=file]')) {
  for (const type of ['input', 'change', 'cancel']) {
    input.addEventListener(type, () => {
      const files = [...input.files].map((file) => file.name + ' ' + file.size).join(', ')
      heard.textContent += input.dataset.testid + ' ' + type + (files === '' ? '' : ': ' + files) + '\\n'
    })
  }
}
byTestId('clears').addEventListener('change', (event) => { event.target.value = '' })
byTestId('clears-button').addEventListener('click', () => byTestId('clears').click())
byTestId('export-frame').addEventListener('click', () => {
  const frame = document.createElement('iframe')
  frame.src = location.origin.replace('127.0.0.1', 'localhost') + '/files/frame-export'
  document.body.append(frame)
})
byTestId('export-opened').addEventListener('click', () => open('/files/opened-frame'))
byTestId('download-key').addEventListener('click', () => {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([byTestId('key-value').value], { type: 'text/plain' }))
  link.download = 'key.txt'
  link.click()
})
byTestId('upload-button').addEventListener('click', () => byTestId('hidden-upload').click())
byTestId('add-photos').addEventListener('click', () => byTestId('photos').click())
byTestId('late-picker').addEventListener('click', () => setTimeout(() => byTestId('hidden-upload').click(), 300))
byTestId('export-script').addEventListener('click', () => {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([${JSON.stringify(TASKS_CSV)}], { type: 'text/csv' }))
  link.download = 'tasks report.csv'
  link.click()
})
`

/**
 * A page of file inputs and downloads: a visible input with a label, one that takes several files, one for notes, a
 * hidden one behind an upload button, a disabled one, a form that posts them, an export link with `download`, a button
 * that downloads a blob from script, a link whose download the server breaks off, and a button that opens a picker
 * after its click has answered. Outside the form: an input that clears itself, an unlabelled one, a link that downloads
 * in a new tab, buttons that download from a frame of another site and from a page this page opens, and a key field
 * with a button that downloads its value. `heard` lists every `input`, `change` and `cancel` the inputs fire.
 */
export const FILES_PAGE: string = htmlPage(
  'Files',
  `<form method="post" action="/files/upload" enctype="multipart/form-data">
<p><label for="attachment">Attachment</label> <input id="attachment" name="attachment" type="file" data-testid="attachment"></p>
<p><label for="photos">Photos</label> <input id="photos" name="photos" type="file" multiple data-testid="photos"> <button type="button" data-testid="add-photos">Add photos</button></p>
<p><label for="notes">Notes</label> <input id="notes" name="notes" type="file" data-testid="notes"></p>
<p><input name="hidden" type="file" hidden data-testid="hidden-upload"><button type="button" data-testid="upload-button">Upload</button></p>
<p><label for="locked">Locked</label> <input id="locked" name="locked" type="file" disabled data-testid="locked"></p>
<p><button type="submit" data-testid="send">Send</button></p>
</form>
<p><a href="/files/tasks.csv" download data-testid="export">Export CSV</a></p>
<p><button type="button" data-testid="export-script">Export from script</button></p>
<p><a href="/files/broken.csv" download data-testid="export-broken">Export broken CSV</a></p>
<p><button type="button" data-testid="late-picker">Open the picker later</button></p>
<p><label for="clears">Clears</label> <input id="clears" type="file" data-testid="clears"> <button type="button" data-testid="clears-button">Choose a file to clear</button></p>
<p><input type="file" data-testid="bare"></p>
<p><a href="/files/tasks.csv" target="_blank" data-testid="export-new-tab">Export in a new tab</a></p>
<p><button type="button" data-testid="export-frame">Export from a frame</button> <button type="button" data-testid="export-opened">Export from an opened page</button></p>
<p><label for="key-value">Key</label> <input id="key-value" type="text" data-testid="key-value"> <button type="button" data-testid="download-key">Download key</button></p>
<pre data-testid="heard"></pre>`,
  SCRIPT,
)

/**
 * A sign-in form whose submit button is an input, beside an avatar input its label names and one nothing labels: the
 * page a label lookup must judge on every engine, whatever buttons stand beside its field.
 */
export const SIGN_IN_PAGE: string = htmlPage(
  'Sign in',
  `<form>
<p><label for="email">Email</label> <input id="email" type="email" data-testid="email"></p>
<p><label for="avatar">Avatar</label> <input id="avatar" type="file" data-testid="avatar"></p>
<p><input type="file" data-testid="unlabelled"></p>
<p><input type="submit" value="Sign in"></p>
</form>`,
)

// A frame's file input whose `files` the page's own scripts answer for, with an empty list whatever it holds, as a page
// could; and the page that holds that frame, with a button that opens the input's picker from outside the frame.
const FRAME_INPUT_PAGE = htmlPage('Frame input', '<input type="file" id="inner">', "Object.defineProperty(document.getElementById('inner'), 'files', { get: () => [] })")
const FRAMED_PAGE = htmlPage(
  'Framed',
  '<iframe src="/files/frame-input" data-testid="frame"></iframe> <button type="button" data-testid="framed-upload">Upload in the frame</button>',
  "document.querySelector('[data-testid=framed-upload]').addEventListener('click', () => document.querySelector('[data-testid=frame]').contentDocument.getElementById('inner').click())",
)

// A page that downloads the CSV as it loads, through a link it clicks itself.
const FRAME_EXPORT_PAGE = htmlPage('Frame export', '<a href="/files/tasks.csv" download id="export">Export</a>', "document.getElementById('export').click()")

/**
 * The page and what it posts and downloads. `GET /files` serves the page; `POST /files/upload` takes its form, records
 * every file it holds, and answers with a page that lists them; `GET /files/received` answers what the last form held as
 * JSON; `GET /files/tasks.csv` serves the CSV as an attachment; `GET /files/broken.csv` promises far more than it sends,
 * then breaks the connection, each time the browser asks. `GET /files/sign-in` serves the sign-in form,
 * `GET /files/frame-export` a page that downloads the CSV as it loads, `GET /files/opened-frame` a page whose frame is
 * that page, and `GET /files/framed` a page whose frame holds a file input it opens the picker of.
 */
export function filesRoutes(): Route[] {
  let received: ReceivedFile[] = []
  return [
    ['GET /files', (_request, response) => respondWith(response, 200, HTML_TYPE, FILES_PAGE)],
    [
      'POST /files/upload',
      (request, response) => {
        readForm(request)
          .then((files) => {
            received = files
            const items = files.map((file) => `<li data-testid="received">${escapeHtml(`${file.field}: ${file.name}, ${file.type}, ${file.size} bytes`)}</li>`).join('\n')
            respondWith(response, 200, HTML_TYPE, htmlPage('Uploaded', `<ul>${items}</ul><p data-testid="received-count">${files.length}</p>`))
          })
          .catch(() => response.destroy())
      },
    ],
    ['GET /files/received', (_request, response) => respondWith(response, 200, JSON_TYPE, JSON.stringify(received))],
    ['GET /files/sign-in', (_request, response) => respondWith(response, 200, HTML_TYPE, SIGN_IN_PAGE)],
    ['GET /files/frame-export', (_request, response) => respondWith(response, 200, HTML_TYPE, FRAME_EXPORT_PAGE)],
    ['GET /files/opened-frame', (_request, response) => respondWith(response, 200, HTML_TYPE, htmlPage('Opened', '<iframe src="/files/frame-export"></iframe>'))],
    ['GET /files/framed', (_request, response) => respondWith(response, 200, HTML_TYPE, FRAMED_PAGE)],
    ['GET /files/frame-input', (_request, response) => respondWith(response, 200, HTML_TYPE, FRAME_INPUT_PAGE)],
    [
      'GET /files/tasks.csv',
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="tasks.csv"', 'cache-control': 'no-store' })
        response.end(TASKS_CSV)
      },
    ],
    [
      'GET /files/broken.csv',
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="broken.csv"', 'content-length': '100000', 'cache-control': 'no-store' })
        response.write('title,done\n')
        setTimeout(() => response.destroy(), 50)
      },
    ],
  ]
}

// A multipart form's files: every part with a file name, read whole. Fields without a file are left out.
async function readForm(request: IncomingMessage): Promise<ReceivedFile[]> {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(request.headers['content-type'] ?? '')
  const marker = boundary?.[1] ?? boundary?.[2]
  if (marker === undefined) return []
  const body = await buffer(request)
  const files: ReceivedFile[] = []
  const separator = Buffer.from(`--${marker}`)
  let start = body.indexOf(separator)
  while (start !== -1) {
    const next = body.indexOf(separator, start + separator.length)
    if (next === -1) break
    const part = body.subarray(start + separator.length + 2, next - 2)
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd !== -1) {
      const headers = part.subarray(0, headerEnd).toString('utf8')
      const content = part.subarray(headerEnd + 4)
      const field = /name="([^"]*)"/.exec(headers)?.[1] ?? ''
      const name = /filename="([^"]*)"/.exec(headers)?.[1]
      const type = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1] ?? ''
      if (name !== undefined && name !== '') files.push({ field, name, type, size: content.length, sha256: createHash('sha256').update(content).digest('hex') })
    }
    start = next
  }
  return files
}

/**
 * The main script of a small Electron app whose one window shows `ELECTRON_FILES_PAGE`, written beside it by the test
 * that launches it, which also writes a package.json naming this file as its main.
 */
export const ELECTRON_FILES_MAIN = `import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 480, height: 360, x: 40, y: 40, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
  void window.loadFile(fileURLToPath(new URL('./index.html', import.meta.url)))
})
app.on('window-all-closed', () => app.quit())
`

/**
 * The Electron app's window: a labelled file input, and a hidden one behind an upload button. `heard` lists every
 * `change` and `cancel` the inputs fire, one line each, with the files they hold.
 */
export const ELECTRON_FILES_PAGE = `<!doctype html><meta charset="utf-8"><title>Files</title>
<p><label for="attachment">Attachment</label> <input id="attachment" type="file" data-testid="attachment"></p>
<p><input type="file" hidden data-testid="hidden-upload"><button type="button" data-testid="upload-button">Upload</button></p>
<pre data-testid="heard"></pre>
<script>
const heard = document.querySelector('[data-testid=heard]')
for (const input of document.querySelectorAll('input[type=file]')) {
  for (const type of ['change', 'cancel']) input.addEventListener(type, () => { heard.textContent += input.dataset.testid + ' ' + type + [...input.files].map((file) => ' ' + file.name + ' ' + file.size).join('') + '\\n' })
}
document.querySelector('[data-testid=upload-button]').addEventListener('click', () => document.querySelector('[data-testid=hidden-upload]').click())
</script>`
