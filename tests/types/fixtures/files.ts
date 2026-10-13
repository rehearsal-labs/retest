import type { Same } from './support/same.ts'
import { expect, test, type Download, type FileChooser, type FilePayload, type InputFiles } from '@rehearsal-labs/retest'

// A file input takes a path, a file by content, or a list of them; a picker's input takes the same; a download gives its
// file's path as a string. A number is no file, and an action that returns nothing is not one page.fileChooser() or
// page.download() can wait on.
export const payload: FilePayload = { name: 'notes.txt', mimeType: 'text/plain', content: 'hello' }
export const bytes: InputFiles = { name: 'a.png', content: new Uint8Array([1, 2, 3]) }
export const list: InputFiles = ['./a.png', payload]

test('uploads and downloads', async ({ page }) => {
  await page.getByLabel('Attachment').setInputFiles('./fixtures/report.pdf')
  await page.getByLabel('Photos').setInputFiles(['./a.png', './b.png'], { timeout: 2000 })
  await page.getByLabel('Notes').setInputFiles(payload)
  await page.getByLabel('Attachment').setInputFiles([])
  await page.getByLabel('Attachment').setInputFiles(3) // type-error TS2345 Argument of type 'number' is not assignable to parameter of type 'InputFiles'
  await page.getByLabel('Notes').setInputFiles({ name: 'notes.txt' }) // type-error TS2345 Argument of type '{ name: string; }' is not assignable to parameter of type 'InputFiles'

  const chooser: FileChooser = await page.fileChooser(() => page.getByRole('button', { name: 'Upload' }).click())
  const multiple: boolean = chooser.multiple
  await chooser.setFiles('./fixtures/report.pdf')
  await page.fileChooser(() => {}) // type-error TS2345 Argument of type '() => void' is not assignable to parameter of type '() => Promise<unknown>'

  const download: Download = await page.download(() => page.getByRole('link', { name: 'Export CSV' }).click(), { timeout: 5000 })
  const name: string = download.suggestedFilename
  const path = download.path()
  const saved: Same<typeof path, Promise<string>> = true
  await download.saveAs('./out/tasks.csv')
  await download.saveAs(7) // type-error TS2345 Argument of type 'number' is not assignable to parameter of type 'string'
  expect(multiple && saved && name !== '').toBe(true)
})
