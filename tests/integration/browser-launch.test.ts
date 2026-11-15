import type { TestContext } from 'node:test'
import type { Transport, TransportHandlers } from '../../src/browser/cdp/transport.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { isRecord } from '../../src/browser/cdp/message.ts'
import { PipeTransport } from '../../src/browser/cdp/transport.ts'
import { LaunchError } from '../../src/browser/contract.ts'
import { launchBrowser } from '../../src/browser/launch.ts'
import { readStartAttempt } from '../../src/browser/sandbox-system.ts'
import { commandLines, explainStartFailure } from '../../src/browser/start-failure.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { windowsStandIn } from '../support/stand-in-program.ts'
import { browserPath, closeMs, groupExists, scratchFolder, setupMs, timed, within } from './browser-harness.ts'

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

// A program that stands in for a browser: a shell script on macOS and Linux; on Windows, which runs only programs, a
// stand-in program that runs the same steps as a Node script, with the arguments it was given.
async function script(t: TestContext, name: string, body: { sh: string; node: string }): Promise<string> {
  const folder = await scratchFolder(t)
  if (process.platform === 'win32') {
    const program = join(folder, `${name}.exe`)
    windowsStandIn(program, body.node)
    return program
  }
  const path = join(folder, name)
  await writeFile(path, `#!/bin/sh\n${body.sh}\n`)
  await chmod(path, 0o755)
  return path
}

// The Node script's own arguments, as the shell's "$@" gives them.
const printArguments = "console.log(process.argv.slice(2).join(' '))"

// A program that prints its arguments and exits 0: /bin/echo on macOS and Linux, a stand-in on Windows.
async function echoProgram(t: TestContext): Promise<string> {
  return process.platform === 'win32' ? script(t, 'echo', { sh: '', node: printArguments }) : '/bin/echo'
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

// A file this user may not run: by its mode on macOS and Linux; on Windows a program whose access list denies this user
// execute, which makes starting it fail with EPERM.
async function notRunnable(folder: string): Promise<string> {
  if (process.platform !== 'win32') {
    const path = join(folder, 'chrome')
    await writeFile(path, '#!/bin/sh\n')
    await chmod(path, 0o644)
    return path
  }
  const path = join(folder, 'chrome.exe')
  windowsStandIn(path, printArguments)
  const system32 = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')
  const user = /"(S-1-[0-9-]+)"\s*$/.exec(execFileSync(join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).trim())?.[1]
  assert.ok(user !== undefined, 'whoami named this user')
  execFileSync(join(system32, 'icacls.exe'), [path, '/deny', `*${user}:(X)`], { stdio: 'ignore' })
  return path
}

test('a file without permission to run fails and says so', async (t) => {
  const folder = await scratchFolder(t)
  const path = await notRunnable(folder)
  const { error } = await launchFailure(path, join(folder, 'browser.log'))
  assert.equal(error.message, `${path} is not executable. Allow it to run, or pass another browser.`)
})

test('a program that is not a browser fails quickly, keeps its output and leaves no profile', async (t) => {
  const log = join(await scratchFolder(t), 'logs', 'browser.log')
  const echo = await echoProgram(t)
  const { error, ms } = await launchFailure(echo, log)
  assert.equal(error.message, `${echo} exited with exit code 0 before it answered as a browser. ${advice} Its output is in ${log}.`)
  assert.ok(ms < 5000, `took ${ms} ms`)
  const output = await readFile(log, 'utf8')
  assert.match(output, /--remote-debugging-pipe --user-data-dir=/)
  assert.equal(existsSync(profileIn(output)), false)
})

test('a program that fails is named with its exit code', async (t) => {
  const program = await script(t, 'failing-browser', { sh: 'echo "$@"\nexit 3', node: `${printArguments}; process.exit(3)` })
  const log = join(await scratchFolder(t), 'browser.log')
  const { error } = await launchFailure(program, log)
  assert.match(error.message, /exited with exit code 3 before it answered as a browser/)
  assert.equal(existsSync(profileIn(await readFile(log, 'utf8'))), false)
})

const noSandboxLine = 'No usable sandbox! If this is a Debian system, please install the chromium-sandbox package to solve this problem.'
const sandboxCause =
  "Chrome's sandbox could not start, because this system does not let the browser create user namespaces. Retest keeps the sandbox on, so allow them: in Docker, with a seccomp profile that permits them; on Ubuntu 23.10 or later, with an AppArmor profile for the browser."

test('a browser whose sandbox cannot start is told why and how to allow it, not to pass another browser', async (t) => {
  const program = await script(t, 'sandboxless-browser', { sh: `echo "$@"\necho '${noSandboxLine}' >&2\nexit 1`, node: `${printArguments}; console.error(${JSON.stringify(noSandboxLine)}); process.exit(1)` })
  const log = join(await scratchFolder(t), 'browser.log')
  const { error } = await launchFailure(program, log)
  const attempt = await readStartAttempt(program)
  const explained = explainStartFailure(noSandboxLine, attempt)
  if (explained?.commands.length === 0) {
    // In a container, on macOS and on Windows, and wherever AppArmor does not decide, the cause names both ways.
    assert.equal(error.message, `${program} exited with exit code 1 before it answered as a browser. ${sandboxCause} Its output is in ${log}.`)
    return
  }
  // On Ubuntu outside a container the commands for this file's profile end the message, the loading one last.
  assert.equal(error.message, `${program} exited with exit code 1 before it answered as a browser. ${explained?.text} Its output is in ${log}.${commandLines(explained)}`)
  assert.ok(error.message.endsWith(`\nsudo apparmor_parser -r /etc/apparmor.d/${attempt.file.slice(1).replaceAll('/', '.')}`), error.message)
})

test('what an earlier launch left in the same log explains nothing about this one', async (t) => {
  const log = join(await scratchFolder(t), 'browser.log')
  await writeFile(log, `${noSandboxLine}\n`)
  const echo = await echoProgram(t)
  const { error } = await launchFailure(echo, log)
  assert.equal(error.message, `${echo} exited with exit code 0 before it answered as a browser. ${advice} Its output is in ${log}.`)
})

test('a program that never answers fails within the launch time, and its process group is killed', async (t) => {
  const program = await script(t, 'silent-browser', { sh: 'echo "pid $$ $@"\nsleep 30', node: "console.log(`pid ${process.pid} ${process.argv.slice(2).join(' ')}`); setTimeout(() => {}, 30_000)" })
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

test('a browser starts with no page of its own, and keeps running once its last page closes', async (t) => {
  const log = join(await scratchFolder(t), 'browser.log')
  // The test's own `Target.getTargets` goes down the browser's pipe under ids Retest never uses, and its answer comes
  // back to the test alone.
  const waiting = new Map<number, (result: unknown) => void>()
  let next = 1_000_000_000
  let pipe: Transport | undefined
  const browser = await launchBrowser({ executablePath: browserPath(), logFile: log, headless: true }, undefined, (streams) => {
    const inner = new PipeTransport(streams)
    pipe = inner
    return {
      listen(handlers: TransportHandlers) {
        inner.listen({
          ...handlers,
          message(text) {
            const message: unknown = JSON.parse(text)
            const id = isRecord(message) ? message['id'] : undefined
            const answer = typeof id === 'number' ? waiting.get(id) : undefined
            if (answer === undefined || typeof id !== 'number' || !isRecord(message)) return handlers.message(text)
            waiting.delete(id)
            answer(message['result'])
          },
        })
      },
      send: (text) => inner.send(text),
      close: () => inner.close(),
    }
  })
  t.after(async () => {
    await browser.close(closeMs)
    assert.equal(groupExists(browser.pid), false, `process group ${browser.pid} should be gone`)
  })
  const pages = async (): Promise<number> => {
    const id = next++
    const { promise, resolve } = Promise.withResolvers<unknown>()
    waiting.set(id, resolve)
    pipe?.send(JSON.stringify({ id, method: 'Target.getTargets' }))
    const result = await within(promise, defaultTimeouts.action, 'Target.getTargets did not answer')
    const infos = isRecord(result) && Array.isArray(result['targetInfos']) ? result['targetInfos'] : []
    return infos.filter((info: unknown) => isRecord(info) && info['type'] === 'page').length
  }
  assert.equal(await pages(), 0, 'no start page')
  for (const round of [1, 2]) {
    const page = await browser.newPage({}, setupMs)
    assert.equal(await pages(), 1, `round ${round}: the test's page`)
    await page.dispose(closeMs)
    assert.equal(await pages(), 0, `round ${round}: no page is left`)
    assert.equal(browser.connected, true, `round ${round}: the browser is still there`)
  }
})
