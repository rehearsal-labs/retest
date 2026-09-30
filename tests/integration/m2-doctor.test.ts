import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { appLogFile } from '../../src/protocol/run-folder.ts'
import { browserPath } from './browser-harness.ts'
import {
  answersAt,
  appServerCommand,
  appServersOn,
  configSource,
  freePort,
  runCli,
  scratchFolder,
  secondBrowserPath,
  writeProject,
} from './cli-harness.ts'

// Acceptance check 13: `retest doctor` launches each target once, checks each app, starts and stops a managed
// server, reports each problem with its fix, and exits 0 only when everything is ready. It runs no test.

test('doctor reports every browser with its version and path, starts and stops a managed server, and exits 0', async (t) => {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{
  apps: {
    web: app({
      baseUrl: ${JSON.stringify(url)},
      start: { command: ${JSON.stringify(appServerCommand(port, { delayMs: 300, child: true }))}, ready: ${JSON.stringify(url)} },
      targets: { chrome: chrome(), testing: chromium({ executablePath: ${JSON.stringify(secondBrowserPath())} }), pixel: chrome({ emulate: 'Pixel 9' }) },
    }),
  },
  secrets: { password: env('RETEST_E2E_PASSWORD') },
}`),
  })
  const doctor = await runCli(t, ['doctor'], { cwd: root, env: { RETEST_E2E_PASSWORD: 'set for the check', NO_COLOR: '1' } })

  assert.equal(doctor.exit.code, 0, `${doctor.stdout}\n${doctor.stderr}`)
  const lines = doctor.stdout.split('\n').map((line) => line.trim().replaceAll(/ {2,}/g, ' | '))
  assert.ok(lines.includes(`web | chrome() | ✓ Chrome ${versionOf(lines, 'chrome()')} | ${browserPath()}`), doctor.stdout)
  assert.ok(lines.some((line) => line.startsWith('testing: chromium() | ✓ Chrome 153.') && line.endsWith(secondBrowserPath())), doctor.stdout)
  assert.ok(lines.some((line) => line.startsWith("pixel: chrome({ emulate: 'Pixel 9' }) | ✓ Chrome 154.")), doctor.stdout)
  assert.ok(lines.some((line) => line.includes(`✓ started, ${url} answered after`) && line.endsWith(', then stopped')), doctor.stdout)
  assert.ok(lines.includes('secrets | password | ✓ RETEST_E2E_PASSWORD is set'), doctor.stdout)
  assert.ok(lines.includes('Ready. 1 app, 3 targets.'), doctor.stdout)
  assert.deepEqual(await appServersOn(port), [], 'the server doctor started, and its child, were stopped')
  assert.equal(await answersAt(url), false)
  assert.equal(existsSync(join(root, '.retest', 'doctor')), false, 'with nothing to fix, doctor keeps no logs')
})

test('doctor reports a missing browser, one that does not start, an app that does not answer and a server that never does, each with its fix', async (t) => {
  const [deadPort, silentPort] = [await freePort(), await freePort()]
  const silent = `http://127.0.0.1:${silentPort}`
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{
  apps: {
    web: chromium({ executablePath: '/nonexistent/chromium', baseUrl: 'http://127.0.0.1:${deadPort}' }),
    admin: chromium({ executablePath: ${JSON.stringify(process.execPath)} }),
    api: chrome({
      baseUrl: ${JSON.stringify(silent)},
      start: { command: ${JSON.stringify(appServerCommand(silentPort, { neverListen: true, printEnv: 'RETEST_E2E_TOKEN' }))}, ready: ${JSON.stringify(silent)}, timeoutMs: 1000 },
    }),
  },
  secrets: { password: env('RETEST_E2E_UNSET'), token: env('RETEST_E2E_TOKEN') },
}`),
  })
  const token = 'doctor-token-9f2a'
  const doctor = await runCli(t, ['doctor'], { cwd: root, env: { NO_COLOR: '1', RETEST_E2E_TOKEN: token } })

  assert.equal(doctor.exit.code, 2, doctor.stderr)
  const text = doctor.stdout
  assert.match(text, /✗ No browser at \/nonexistent\/chromium, the path executablePath gives\. Install one there, or change the path\./)
  assert.match(text, new RegExp(`http://127\\.0\\.0\\.1:${deadPort} +✗ did not answer\\n +Start the app, or add start to the config so Retest starts it\\.`))
  assert.match(text, new RegExp(`✗ The server for api did not answer at ${silent} within 1000 ms\\.`))
  assert.match(text, /Check start in the config: its command, and ready, the address that answers once the app is up\./)
  assert.match(text, /✗ The secret "password" reads RETEST_E2E_UNSET, which is not set\./)
  assert.match(text, /5 problems\. Fix them and run npx retest doctor again\./)
  assert.deepEqual(await appServersOn(silentPort), [], 'the server that never answered was stopped')

  // A browser that did not start points to its log, which doctor keeps in the project, not the temporary folder.
  const log = /The browser's log is at (\S+)\./.exec(text)?.[1]
  assert.ok(log !== undefined, text)
  assert.ok(log.startsWith(join(realpathSync(root), '.retest', 'doctor')), `the log is kept under .retest/doctor: ${log}`)
  assert.ok(existsSync(log), `${log} exists`)
  // The kept folder holds the log of the server that never answered too, and that server printed its settings.
  const serverLog = readFileSync(join(dirname(log), appLogFile('api').slice('logs/'.length)), 'utf8')
  assert.match(serverLog, /^RETEST_E2E_TOKEN=\{\{token\}\}$/m, serverLog)
  assert.ok(!serverLog.includes(token), 'the kept log never holds the value')
  assert.ok(!doctor.stdout.includes(token) && !doctor.stderr.includes(token))
})

test('doctor without a config says how to write one', async (t) => {
  const empty = await scratchFolder(t, 'retest-project-')
  const doctor = await runCli(t, ['doctor'], { cwd: empty })
  assert.equal(doctor.exit.code, 2)
  assert.match(doctor.stderr, /doctor checks the browsers and apps in a config\. No retest\.config\.ts here\. Run npx retest init to write one\./)
})

function versionOf(lines: readonly string[], target: string): string {
  const line = lines.find((each) => each.includes(`| ${target} | ✓ Chrome `)) ?? ''
  return /✓ Chrome (\S+)/.exec(line)?.[1] ?? 'unknown'
}
