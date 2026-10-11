import { spawn } from 'node:child_process'
import { createReadStream, closeSync, writeSync } from 'node:fs'
import { access, appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const [mode, folder] = process.argv.slice(2)
if (folder === undefined) throw new Error('The inherited-stderr fixture needs its own proof folder.')
const proofFolder = folder
const entry = fileURLToPath(import.meta.url)

async function record(event: string): Promise<void> {
  await appendFile(join(proofFolder, 'fixture-events.jsonl'), `${JSON.stringify({ event, pid: process.pid, parentPid: process.ppid, atMs: Date.now() })}\n`)
}

if (mode === 'helper') {
  writeSync(2, 'helper accepted hunter2\n')
  await record('helper.started')
  await writeFile(join(proofFolder, 'helper-ready.json'), JSON.stringify({ pid: process.pid, parentPid: process.ppid }))
  const deadline = Date.now() + 12000
  let reason = 'fixture lifetime elapsed'
  while (Date.now() < deadline) {
    try { await access(join(proofFolder, 'release-helper')); reason = 'fixture released'; break }
    catch { await delay(20) }
  }
  closeSync(2)
  await record('helper.closed-own-stderr')
  await writeFile(join(proofFolder, 'helper-ended.json'), JSON.stringify({ pid: process.pid, parentPid: process.ppid, code: 0, reason }))
  process.exit(0)
} else if (mode === 'broker') {
  const helper = spawn(process.execPath, [entry, 'helper', folder], { detached: true, stdio: ['ignore', 'ignore', 'inherit'] })
  await new Promise<void>((resolve, reject) => { helper.once('spawn', resolve); helper.once('error', reject) })
  helper.unref()
  await record('broker.started-helper')
  process.send?.({ helperPid: helper.pid })
  process.disconnect()
  process.exit(0)
} else if (mode === 'root') {
  const expiry = setTimeout(() => process.exit(3), 15000)
  expiry.unref()
  const commands = createReadStream('', { fd: 3, autoClose: false })
  commands.once('end', () => process.exit(0))
  commands.once('data', () => {
    commands.destroy()
    void runRoot().catch(async () => {
      await record('root.fixture-failed')
      process.exit(2)
    })
  })
} else throw new Error('The inherited-stderr fixture mode is unsupported.')

async function runRoot(): Promise<void> {
  if (folder === undefined) throw new Error('The inherited-stderr fixture proof folder is absent.')
  writeSync(1, 'root complete hunter2\n')
  const broker = spawn(process.execPath, [entry, 'broker', folder], { detached: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  await new Promise<void>((resolve, reject) => { broker.once('exit', (code) => { if (code === 0) resolve(); else reject(new Error('The broker did not end cleanly.')) }); broker.once('error', reject) })
  const deadline = Date.now() + 4000
  while (true) {
    try { await access(join(proofFolder, 'helper-ready.json')); break }
    catch { if (Date.now() >= deadline) throw new Error('The helper did not become ready.'); await delay(20) }
  }
  writeSync(2, 'root safe partial hunt')
  await record('root.exiting')
  process.exit(0)
}
