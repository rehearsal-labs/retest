import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { readInputFiles } from '../../src/api/files.ts'
import { describeCommand, pageCommandSchema } from '../../src/protocol/commands.ts'
import { describeInputFiles, filesAnswerSchema, inputFilesProblem } from '../../src/protocol/files.ts'
import { childMessageSchema } from '../../src/protocol/messages.ts'
import { parse } from '../../src/protocol/schema.ts'
import { describeDownload } from '../../src/reporters/format.ts'
import { freeName } from '../../src/runner/files.ts'
import { artifactPath, downloadFileName, downloadsFolder, referenceProblem } from '../../src/store/artifacts.ts'

const identity = { testId: 'tests/a.retest.ts > a', attemptId: 'k3v9q0x2mb', app: 'web', sessionId: 'k3v9q0x2mb:web' }

test('a suggested name becomes one a reference can hold, keeping its end', () => {
  assert.equal(downloadFileName('tasks.csv'), 'tasks.csv')
  assert.equal(downloadFileName('tasks report (May).csv'), 'tasks-report-May-.csv')
  assert.equal(downloadFileName('../../etc/passwd'), 'etc-passwd')
  assert.equal(downloadFileName('.hidden'), 'hidden')
  assert.equal(downloadFileName('résumé.pdf'), 'r-sum-.pdf')
  assert.equal(downloadFileName(''), 'download')
  assert.equal(downloadFileName('...'), 'download')
  const long = `${'a'.repeat(300)}.csv`
  assert.equal(downloadFileName(long), `${'a'.repeat(116)}.csv`)
  for (const name of ['tasks report (May).csv', '../../etc/passwd', '.hidden', long, '???']) assert.equal(referenceProblem(`artifacts/x/${downloadFileName(name)}`), undefined, name)
})

test('a download goes in its session\'s downloads folder, under a name downloadFileName gives, and no other', () => {
  const folder = downloadsFolder(identity)
  assert.match(folder, /^artifacts\/k3v9q0x2mb\/web-[a-z0-9]+\/downloads$/)
  assert.equal(artifactPath({ kind: 'download', identity, name: 'tasks.csv' }), `${folder}/tasks.csv`)
  assert.throws(() => artifactPath({ kind: 'download', identity, name: 'tasks report.csv' }), RangeError)
  assert.throws(() => artifactPath({ kind: 'download', identity, name: '../tasks.csv' }), RangeError)
})

test('a name a folder already holds takes a number before its extension', () => {
  const folder = mkdtempSync(join(tmpdir(), 'retest-files-unit-'))
  try {
    assert.equal(freeName(folder, 'tasks.csv'), 'tasks.csv')
    writeFileSync(join(folder, 'tasks.csv'), '')
    assert.equal(freeName(folder, 'tasks.csv'), 'tasks-2.csv')
    writeFileSync(join(folder, 'tasks-2.csv'), '')
    assert.equal(freeName(folder, 'tasks.csv'), 'tasks-3.csv')
    writeFileSync(join(folder, 'download'), '')
    assert.equal(freeName(folder, 'download'), 'download-2')
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test('files are written as the test wrote them: a path, a file by its name, and a list when it gave one', () => {
  const path = { path: './fixtures/report.pdf', folder: '/work/tests' }
  const content = { name: 'notes.txt', base64: 'aGVsbG8=' }
  assert.equal(describeInputFiles([path], false), "'./fixtures/report.pdf'")
  assert.equal(describeInputFiles([path], true), "['./fixtures/report.pdf']")
  assert.equal(describeInputFiles([path, content], true), "['./fixtures/report.pdf', { name: 'notes.txt' }]")
  assert.equal(describeInputFiles([], true), '[]')
  assert.equal(describeCommand({ kind: 'setInputFiles', locator: { by: 'label', text: 'Notes' }, files: [content] }), "getByLabel('Notes').setInputFiles({ name: 'notes.txt' })")
  assert.equal(describeCommand({ kind: 'setChooserFiles', chooser: 'chooser-1', files: [], list: true }), 'fileChooser.setFiles([])')
})

test('a file the parent cannot give is refused as usage, and a good one passes', () => {
  assert.equal(inputFilesProblem([{ path: './a.png', folder: '/work' }, { name: 'a.txt', mimeType: 'text/plain', base64: 'aGk=' }], 'setInputFiles', 'darwin'), undefined)
  const refused = (file: Parameters<typeof inputFilesProblem>[0][number], platform: NodeJS.Platform = 'darwin') => inputFilesProblem([file], 'setInputFiles', platform)?.message
  const cannotResolve = 'setInputFiles() received the path "./a.png" with a folder Retest cannot resolve it against.'
  assert.equal(refused({ path: '', folder: '/work' }), 'setInputFiles() takes a path to a file, received an empty path.')
  assert.equal(refused({ path: './a.png', folder: 'tests' }), cannotResolve)
  // The folder is the calling file's, as the test file's process writes it: from the root on macOS and Linux, where a
  // Windows drive or share is a name in the working folder; a drive or a share on Windows, where a root with no drive and
  // a drive with no separator are read against the working folder.
  for (const folder of ['C:\\work\\tests', '\\\\server\\share\\tests', 'tests']) assert.equal(refused({ path: './a.png', folder }, 'linux'), cannotResolve, folder)
  for (const folder of ['C:\\work\\tests', 'D:/work/tests', '\\\\server\\share\\tests']) assert.equal(refused({ path: '../fixtures/report.pdf', folder }, 'win32'), undefined, folder)
  for (const folder of ['C:tests', '\\tests', '/tests', '\\\\\\tests', 'tests']) assert.equal(refused({ path: './a.png', folder }, 'win32'), cannotResolve, folder)
  // A folder as this machine writes one is one the test file's process gives.
  const folder = join(tmpdir(), 'tests')
  assert.deepEqual(readInputFiles('../fixtures/report.pdf', folder, 'setInputFiles'), { files: [{ path: '../fixtures/report.pdf', folder }], list: false })
  assert.equal(refused({ name: 'a/b.txt', base64: '' }), `setInputFiles() takes a file's name without a folder, such as 'notes.txt', received "a/b.txt".`)
  assert.equal(refused({ name: '..', base64: '' }), `setInputFiles() takes a file's name without a folder, such as 'notes.txt', received "..".`)
  assert.equal(refused({ name: 'a.txt', mimeType: 'plain', base64: '' }), `setInputFiles() takes mimeType as a type such as 'text/plain', received "plain".`)
  assert.equal(refused({ name: 'a.txt', base64: 'not base64!' }), 'setInputFiles() received the content of "a.txt" in a form Retest cannot read.')
})

test('the files argument is read whatever a JavaScript caller passed, and what is wrong is said', () => {
  const tests = resolve('/work/tests')
  assert.deepEqual(readInputFiles('./a.png', tests, 'setInputFiles'), { files: [{ path: './a.png', folder: tests }], list: false })
  assert.deepEqual(readInputFiles([], '/work/tests', 'setInputFiles'), { files: [], list: true })
  assert.deepEqual(readInputFiles({ name: 'a.bin', content: new Uint8Array([1, 2, 3]) }, '/work', 'setFiles'), { files: [{ name: 'a.bin', base64: 'AQID' }], list: false })
  assert.deepEqual(readInputFiles([{ name: 'n.txt', mimeType: 'text/plain', content: 'hello', extra: undefined }], '/work', 'setFiles'), { files: [{ name: 'n.txt', mimeType: 'text/plain', base64: 'aGVsbG8=' }], list: true })
  assert.equal(readInputFiles(3, '/work', 'setInputFiles'), "setInputFiles() takes a path, a file such as { name: 'notes.txt', content: 'hello' }, or a list of them, received 3.")
  assert.equal(readInputFiles(['./a.png', 7], '/work', 'setInputFiles'), "setInputFiles() takes a path, a file such as { name: 'notes.txt', content: 'hello' }, or a list of them, received a list holding 7.")
  assert.equal(readInputFiles({ name: 'a.txt', content: 'x', path: './b' }, '/work', 'setFiles'), 'setFiles() has no file option "path". A file by content takes name, mimeType and content.')
  assert.equal(readInputFiles({ name: 'a.txt' }, '/work', 'setFiles'), 'setFiles() takes a file\'s content as text or bytes, received undefined.')
  assert.equal(readInputFiles({ name: 'a/b.txt', content: '' }, '/work', 'setFiles'), `setFiles() takes a file's name without a folder, such as 'notes.txt', received "a/b.txt".`)
})

test('the commands and messages about files cross the wire, and nothing else in their place', () => {
  assert.ok(parse(pageCommandSchema, { kind: 'setInputFiles', locator: { by: 'testId', value: 'a' }, files: [{ path: './a', folder: '/w' }], list: true }).ok)
  assert.ok(!parse(pageCommandSchema, { kind: 'setInputFiles', locator: { by: 'testId', value: 'a' }, files: [{ path: './a' }] }).ok)
  assert.ok(parse(childMessageSchema, { type: 'files', testId: 't', attemptId: 'a', id: 3, request: { kind: 'download', app: 'web' }, timeoutMs: 5000 }).ok)
  assert.ok(parse(childMessageSchema, { type: 'files', testId: 't', attemptId: 'a', id: 4, request: { kind: 'release', request: 3 }, timeoutMs: 1 }).ok)
  assert.ok(!parse(childMessageSchema, { type: 'files', testId: 't', attemptId: 'a', id: 4, request: { kind: 'download' }, timeoutMs: 1 }).ok)
  assert.ok(parse(filesAnswerSchema, { ok: true, kind: 'saved', path: '/run/a.csv', size: 3 }).ok)
  assert.ok(!parse(filesAnswerSchema, { ok: true, kind: 'saved', path: '/run/a.csv' }).ok)
})

test('a download reads as its name and how it ended', () => {
  assert.equal(describeDownload({ suggestedFilename: 'tasks.csv', state: 'completed', size: 35 }), 'download tasks.csv, 35 bytes')
  assert.equal(describeDownload({ suggestedFilename: 'one.txt', state: 'completed', size: 1 }), 'download one.txt, 1 byte')
  assert.equal(describeDownload({ suggestedFilename: 'broken.csv', state: 'canceled', receivedBytes: 11, totalBytes: 100000 }), 'download broken.csv stopped after 11 of 100000 bytes')
  assert.equal(describeDownload({ suggestedFilename: 'big.zip', state: 'unfinished', receivedBytes: 0, totalBytes: 0 }), 'download big.zip unfinished when the test ended, 0 bytes')
})
