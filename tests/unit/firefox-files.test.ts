import type { PageDownload } from '../../src/browser/contract.ts'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { BidiClient } from '../../src/browser/firefox/bidi-client.ts'
import { FirefoxDownloads, FirefoxFileChoosers } from '../../src/browser/firefox/files.ts'
import { ScriptedBidi } from './firefox-scripted-bidi.ts'

// The file pickers and downloads of a Firefox page, over a scripted BiDi endpoint: which picker goes to a wait and which
// fails its action, and where each download of the user context began, how its file is kept, and what Firefox leaves
// unsaid of one it stopped.

let endpoint: ScriptedBidi
let client: BidiClient

before(async () => {
  endpoint = await ScriptedBidi.start()
  client = await BidiClient.connect(endpoint.url, { timeoutMs: 2000, onDiagnostic: () => {} })
})

after(async () => {
  client.close()
  await endpoint.close()
})

// Lets the events emitted so far reach the client: a command's answer comes after every event sent before it.
async function settle(): Promise<void> {
  endpoint.accept('session.status')
  await client.send('session.status', {})
}

function folders(): { staging: string; folder: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'retest-firefox-files-'))
  const staging = join(root, 'staging')
  mkdirSync(staging)
  return { root, staging, folder: join(root, 'session', 'downloads') }
}

test('the next picker goes to the wait armed for it; any other fails the action it opened during, or the next one, before it sends anything', async () => {
  const choosers = new FirefoxFileChoosers()
  const arm = choosers.armFileChooser()
  choosers.opened('tab-1', 'input-1', true)
  assert.deepEqual(await arm.opened, { id: 'chooser-1', multiple: true })
  let ran = 0
  const run = async () => {
    ran += 1
    return { ok: true as const, kind: 'click' as const }
  }
  const during = await choosers.around(true, () => "click getByTestId('upload')", async () => {
    choosers.opened('tab-1', 'input-1', false)
    return run()
  })
  assert.equal(during.ok ? undefined : during.failure.details?.['picker'], 'file')
  choosers.opened('tab-1', 'input-1', false)
  const before = await choosers.around(true, () => "click getByTestId('next')", run)
  assert.deepEqual(before, { ok: false, failure: { class: 'not_actionable', message: "The page opened a file picker after the action before this one, and nothing was waiting for one. Retest closed the picker, and did not click getByTestId('next').", details: { picker: 'file', inputSent: false } } })
  assert.equal(ran, 1, 'the action after the picker sent nothing')
  assert.deepEqual(await choosers.around(false, () => 'read', run), { ok: true, kind: 'click' }, 'a look is run as it is')
})

test('a picker no input opened is refused by name, and a released arm leaves the next picker to fail its action', async () => {
  const choosers = new FirefoxFileChoosers()
  const arm = choosers.armFileChooser()
  choosers.opened('tab-1', undefined, false)
  await assert.rejects(arm.opened, (error: unknown) => error instanceof Error && 'failure' in error && JSON.stringify(error.failure).includes('belongs to no <input type=\\"file\\">'))
  const released = choosers.armFileChooser()
  released.release()
  choosers.opened('tab-1', 'input-2', false)
  const result = await choosers.around(true, () => 'click it', async () => ({ ok: true, kind: 'click' }))
  assert.equal(result.ok ? undefined : result.failure.class, 'not_actionable')
})

test("a download of the page, of a frame inside it, of a page it opened and of that page's frame is told where it began", async () => {
  const { root, staging, folder } = folders()
  const downloads = new FirefoxDownloads({ client, userContext: 'user-1', context: 'tab-1', staging, folder, onListenerError: (error) => assert.fail(String(error)) })
  try {
    const told: PageDownload[] = []
    downloads.onDownload((download) => told.push(download))
    endpoint.emit('browsingContext.contextCreated', { context: 'frame-1', parent: 'tab-1', originalOpener: null, userContext: 'user-1', url: 'about:blank', children: null })
    endpoint.emit('browsingContext.contextCreated', { context: 'popup-1', parent: null, originalOpener: 'tab-1', userContext: 'user-1', url: 'about:blank', children: null })
    endpoint.emit('browsingContext.contextCreated', { context: 'popup-frame', parent: 'popup-1', originalOpener: null, userContext: 'user-1', url: 'about:blank', children: null })
    endpoint.emit('browsingContext.contextCreated', { context: 'stranger', parent: null, originalOpener: null, userContext: 'user-1', url: 'about:blank', children: null })
    for (const [context, download] of [['tab-1', 'd1'], ['frame-1', 'd2'], ['popup-1', 'd3'], ['popup-frame', 'd4'], ['stranger', 'd5'], ['unknown', 'd6']]) {
      endpoint.emit('browsingContext.downloadWillBegin', { context, download, navigation: 'n', suggestedFilename: 'tasks.csv', url: 'http://127.0.0.1/tasks.csv', userContext: 'user-1', timestamp: 0 })
    }
    endpoint.emit('browsingContext.downloadWillBegin', { context: 'tab-9', download: 'd7', navigation: 'n', suggestedFilename: 'theirs.csv', url: 'http://127.0.0.1/theirs.csv', userContext: 'user-2', timestamp: 0 })
    await settle()
    assert.deepEqual(told.map((download) => [download.guid, download.startedIn]), [['d1', undefined], ['d2', undefined], ['d3', 'popup'], ['d4', 'popup'], ['d5', 'other'], ['d6', 'other']])
    assert.equal(told[0]?.progress(), undefined, 'Firefox tells no progress')
  } finally {
    await downloads.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a completed download is moved into the session folder under its id with its size; a stopped one, or one Firefox names no file for, says no bytes; close removes the staging folder', async () => {
  const { root, staging, folder } = folders()
  const downloads = new FirefoxDownloads({ client, userContext: 'user-1', context: 'tab-1', staging, folder, onListenerError: (error) => assert.fail(String(error)) })
  try {
    const told: PageDownload[] = []
    downloads.onDownload((download) => told.push(download))
    for (const download of ['done', 'stopped', 'nameless']) endpoint.emit('browsingContext.downloadWillBegin', { context: 'tab-1', download, navigation: 'n', suggestedFilename: 'tasks.csv', url: 'http://127.0.0.1/tasks.csv', userContext: 'user-1', timestamp: 0 })
    writeFileSync(join(staging, 'tasks.csv'), 'title,done\n')
    endpoint.emit('browsingContext.downloadEnd', { context: 'tab-1', download: 'done', navigation: 'n', status: 'complete', filepath: join(staging, 'tasks.csv'), url: 'http://127.0.0.1/tasks.csv', userContext: 'user-1', timestamp: 0 })
    endpoint.emit('browsingContext.downloadEnd', { context: 'tab-1', download: 'stopped', navigation: 'n', status: 'canceled', url: 'http://127.0.0.1/tasks.csv', userContext: 'user-1', timestamp: 0 })
    endpoint.emit('browsingContext.downloadEnd', { context: 'tab-1', download: 'nameless', navigation: 'n', status: 'complete', filepath: null, url: 'http://127.0.0.1/tasks.csv', userContext: 'user-1', timestamp: 0 })
    await settle()
    const [done, stopped, nameless] = await Promise.all(told.map((download) => download.ended))
    assert.deepEqual(done, { state: 'completed', filePath: join(folder, 'done'), receivedBytes: 11, totalBytes: 11 })
    assert.equal(readFileSync(join(folder, 'done'), 'utf8'), 'title,done\n')
    assert.deepEqual(readdirSync(staging), [], 'the file left the folder Firefox saved it in')
    assert.deepEqual([stopped, nameless], [{ state: 'canceled' }, { state: 'canceled' }])
    await downloads.close()
    assert.equal(existsSync(staging), false)
  } finally {
    await downloads.close()
    rmSync(root, { recursive: true, force: true })
  }
})
