import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, constants, existsSync, openSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { unixOnly } from '../support/platform-skip.ts'
import { tempFolder } from '../support/temp-folder.ts'

const program = fileURLToPath(new URL('./profile-quit-program.ts', import.meta.url))
const ownerFile = '.retest-profile-owner.json'

// The program runs with `folder` as its temporary folder, where its profiles go: Node's tmpdir() reads TMPDIR on macOS
// and Linux and TEMP and TMP on Windows.
function startProgram(folder: string, args: readonly string[]): ChildProcessWithoutNullStreams {
  const env = { ...process.env, TMPDIR: folder, TEMP: folder, TMP: folder }
  return spawn(process.execPath, ['--conditions=retest-source', program, ...args], { env, stdio: 'pipe' })
}

function profilesIn(folder: string): string[] {
  return readdirSync(folder).filter((name) => name.startsWith('retest-profile-'))
}

// Reads the program's output as it comes, without ending it: the program writes a line from its exit hooks too.
function linesOf(child: ChildProcessWithoutNullStreams): (wanted: string) => Promise<void> {
  let stdout = ''
  let stderr = ''
  const waiting = new Set<() => void>()
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
    for (const wake of [...waiting]) wake()
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  child.on('exit', () => { for (const wake of [...waiting]) wake() })
  return (wanted) => new Promise((resolve, reject) => {
    const look = (): void => {
      if (stdout.split('\n').some((line) => line === wanted || line.startsWith(`${wanted} `))) {
        waiting.delete(look)
        resolve()
      } else if (child.exitCode !== null || child.signalCode !== null) {
        waiting.delete(look)
        reject(new Error(`the program ended before it printed ${wanted}: ${stdout}${stderr}`))
      }
    }
    waiting.add(look)
    look()
  })
}

// The profile exists once its owner record does, which is written last as the profile is made.
async function profileMade(folder: string): Promise<string> {
  for (;;) {
    const made = profilesIn(folder).find((name) => existsSync(join(folder, name, ownerFile)))
    if (made !== undefined) return made
    await delay(10)
  }
}

test('a quit after a browser profile is made and before its browser starts leaves no profile', async () => {
  const folder = tempFolder('retest-profile-quit-')
  const child = startProgram(folder, ['profile'])
  const exited = once(child, 'exit')
  const printed = linesOf(child)
  await printed('profile')
  assert.equal(profilesIn(folder).length, 1, 'the profile is there while its launch goes on')
  child.stdin.write('quit\n')
  assert.deepEqual(await exited, [130, null])
  assert.deepEqual(profilesIn(folder), [], 'the exit hooks removed the profile no browser had been started on')
})

test('a quit while a browser launch waits between making its profile and starting the browser leaves no profile', { skip: unixOnly('the launch is held on a FIFO for its log, which Windows does not have') }, async () => {
  const folder = tempFolder('retest-launch-quit-')
  // Opening a FIFO to write waits until something opens it to read, so the launch holds where it opens its log: after
  // its profile is made, and before the browser is started.
  const log = join(folder, 'browser.log')
  assert.equal(spawnSync('mkfifo', [log]).status, 0, 'mkfifo made the log a FIFO')
  const child = startProgram(folder, ['launch', log])
  const exited = once(child, 'exit')
  const printed = linesOf(child)
  await profileMade(folder)
  child.stdin.write('quit\n')
  await printed('exiting')
  // The process is in its exit hooks, so the launch cannot go on; the log's opening is let go so the process can end.
  closeSync(openSync(log, constants.O_RDONLY | constants.O_NONBLOCK))
  assert.deepEqual(await exited, [130, null])
  assert.deepEqual(profilesIn(folder), [], 'the exit hooks removed the profile of the launch the quit cut short')
})
