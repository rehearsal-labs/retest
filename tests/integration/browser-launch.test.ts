import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { LaunchError } from '../../src/browser/contract.ts'
import { launchBrowser } from '../../src/browser/launch.ts'
import { browserPath, closeMs, groupExists, scratchFolder, timed } from './browser-harness.ts'

const advice = 'Pass the path to a Chromium or Chrome executable.'

async function launchFailure(executablePath: string, logFile: string, timeoutMs?: number) {
  const { value: error, ms } = await timed(
    launchBrowser({ executablePath, logFile, headless: true }, timeoutMs).then(
      async (browser) => {
        await browser.close(closeMs)
        assert.fail(`${executablePath} launched`)
      },
      (error: unknown) => error,
    ),
  )
  assert.ok(error instanceof LaunchError, String(error))
  assert.equal(error.failure.class, 'setup_failed', error.message)
  assert.equal(error.failure.message, error.message)
  return { error, ms }
}

async function script(t: TestContext, name: string, body: string): Promise<string> {
  const path = join(await scratchFolder(t), name)
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
  return path
}

/** The profile Retest passed, which these stand-in programs print with their arguments. */
function profileIn(log: string): string {
  const match = /--user-data-dir=(\S+)/.exec(log)
  assert.ok(match?.[1] !== undefined, `the log should show the arguments: ${log}`)
  return match[1]
}

test('a path with no file fails at once and names the absolute path', async (t) => {
  const folder = await scratchFolder(t)
  const { error, ms } = await launchFailure('missing-chrome', join(folder, 'browser.log'))
  assert.equal(error.message, `No browser at ${resolve('missing-chrome')}. ${advice}`)
  assert.ok(ms < 1000, `took ${ms} ms`)
  assert.equal(existsSync(join(folder, 'browser.log')), false, 'nothing is created before the path is checked')
})

test('a folder fails and says it is a folder', async (t) => {
  const folder = await scratchFolder(t)
  const { error } = await launchFailure(folder, join(folder, 'browser.log'))
  assert.equal(error.message, `${folder} is a folder. ${advice}`)
})

test('a macOS app bundle fails and names the executable inside it', async (t) => {
  const folder = await scratchFolder(t)
  const bundle = join(folder, 'Browser.app')
  await mkdir(join(bundle, 'Contents', 'MacOS'), { recursive: true })
  await writeFile(join(bundle, 'Contents', 'MacOS', 'Browser'), '')
  const { error } = await launchFailure(bundle, join(folder, 'browser.log'))
  assert.equal(error.message, `${bundle} is a macOS app bundle. Pass the executable inside it: ${join(bundle, 'Contents', 'MacOS', 'Browser')}`)
})

test('a file without permission to run fails and says so', async (t) => {
  const folder = await scratchFolder(t)
  const path = join(folder, 'chrome')
  await writeFile(path, '#!/bin/sh\n')
  await chmod(path, 0o644)
  const { error } = await launchFailure(path, join(folder, 'browser.log'))
  assert.equal(error.message, `${path} is not executable. Allow it to run, or pass another browser.`)
})

test('a program that is not a browser fails quickly, keeps its output and leaves no profile', async (t) => {
  const log = join(await scratchFolder(t), 'logs', 'browser.log')
  const { error, ms } = await launchFailure('/bin/echo', log)
  assert.equal(error.message, `/bin/echo exited with exit code 0 before it answered as a browser. ${advice} Its output is in ${log}.`)
  assert.ok(ms < 5000, `took ${ms} ms`)
  const output = await readFile(log, 'utf8')
  assert.match(output, /--remote-debugging-pipe --user-data-dir=/)
  assert.equal(existsSync(profileIn(output)), false)
})

test('a program that fails is named with its exit code', async (t) => {
  const program = await script(t, 'failing-browser', 'echo "$@"\nexit 3')
  const log = join(await scratchFolder(t), 'browser.log')
  const { error } = await launchFailure(program, log)
  assert.match(error.message, /exited with exit code 3 before it answered as a browser/)
  assert.equal(existsSync(profileIn(await readFile(log, 'utf8'))), false)
})

const noSandboxLine = 'No usable sandbox! If this is a Debian system, please install the chromium-sandbox package to solve this problem.'
const sandboxCause =
  "Chrome's sandbox could not start, because this system does not let the browser create user namespaces. Retest keeps the sandbox on, so allow them: in Docker, with a seccomp profile that permits them; on Ubuntu 23.10 or later, with an AppArmor profile for the browser."

test('a browser whose sandbox cannot start is told why and how to allow it, not to pass another browser', async (t) => {
  const program = await script(t, 'sandboxless-browser', `echo "$@"\necho '${noSandboxLine}' >&2\nexit 1`)
  const log = join(await scratchFolder(t), 'browser.log')
  const { error } = await launchFailure(program, log)
  assert.equal(error.message, `${program} exited with exit code 1 before it answered as a browser. ${sandboxCause} Its output is in ${log}.`)
})

test('what an earlier launch left in the same log explains nothing about this one', async (t) => {
  const log = join(await scratchFolder(t), 'browser.log')
  await writeFile(log, `${noSandboxLine}\n`)
  const { error } = await launchFailure('/bin/echo', log)
  assert.equal(error.message, `/bin/echo exited with exit code 0 before it answered as a browser. ${advice} Its output is in ${log}.`)
})

test('a program that never answers fails within the launch time, and its process group is killed', async (t) => {
  const program = await script(t, 'silent-browser', 'echo "pid $$ $@"\nsleep 30')
  const log = join(await scratchFolder(t), 'browser.log')
  const { error, ms } = await launchFailure(program, log, 1000)
  assert.equal(error.message, `${program} did not answer as a browser within 1000 ms. ${advice} Its output is in ${log}.`)
  assert.ok(ms >= 990 && ms < 4000, `took ${ms} ms`)
  const output = await readFile(log, 'utf8')
  const pid = Number(/^pid (\d+)/.exec(output)?.[1])
  assert.ok(pid > 0)
  assert.equal(groupExists(pid), false, 'the program should have been killed')
  assert.equal(existsSync(profileIn(output)), false)
})

test('the browser log goes to the given file, in a folder created for it', async (t) => {
  const log = join(await scratchFolder(t), 'run', 'logs', 'browser.log')
  const browser = await launchBrowser({ executablePath: browserPath(), logFile: log, headless: true })
  await browser.close(closeMs)
  assert.equal(existsSync(log), true)
})
