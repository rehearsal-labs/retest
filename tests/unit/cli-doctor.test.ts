import type { LaunchOptions } from '../../src/browser/contract.ts'
import type { CliDependencies } from '../../src/cli/command.ts'
import type { LoadedConfig } from '../../src/config/loaded.ts'
import type { AppServerOptions } from '../../src/runner/app-server.ts'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import { LaunchError } from '../../src/browser/contract.ts'
import { app, chrome, chromium, env } from '../../src/config/define.ts'
import { AppServerError } from '../../src/runner/app-server.ts'
import { fakeBrowser, fakeCli, loadedConfig, type FakeOptions } from './cli-fixtures.ts'
import { temporaryFolder } from './reporters-fixtures.ts'

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const ready = 'http://localhost:3000'
const project = temporaryFolder()
writeFileSync(`${project}/retest.config.ts`, '')

const found: CliDependencies['resolveExecutable'] = () => ({ ok: true, path: chromePath })
const doctorLogs = join(project, '.retest', 'doctor')

// A browser writes its log as it starts, which makes the folder the log is in.
function writeLog(logFile: string): void {
  mkdirSync(dirname(logFile), { recursive: true })
  writeFileSync(logFile, 'browser output\n')
}

type Calls = { launches: LaunchOptions[]; starts: AppServerOptions[]; stops: number; probes: string[] }

function recorded(options: Partial<FakeOptions> & { config: LoadedConfig }) {
  const calls: Calls = { launches: [], starts: [], stops: 0, probes: [] }
  const fake = fakeCli({
    cwd: project,
    resolveExecutable: found,
    launchBrowser: async (launch) => {
      calls.launches.push(launch)
      writeLog(launch.logFile)
      return fakeBrowser(launch.executablePath)
    },
    startAppServer: async (start) => {
      calls.starts.push(start)
      return { status: 'started', pid: 5151, durationMs: 2100, stop: async () => void calls.stops++ }
    },
    probeReady: async (url) => {
      calls.probes.push(url)
      return true
    },
    ...options,
  })
  return { fake, calls }
}

async function doctor(options: Partial<FakeOptions> & { config: LoadedConfig }, args: string[] = []) {
  const { fake, calls } = recorded(options)
  const code = await fake.cli(['doctor', ...args])
  return { code, stdout: fake.stdout.text, stderr: fake.stderr.text, calls }
}

const oneApp = loadedConfig(project, { apps: { web: chrome({ baseUrl: ready, start: { command: 'npm run dev', ready } }) } })

describe('doctor', () => {
  beforeEach(() => rmSync(doctorLogs, { recursive: true, force: true }))

  test('all ready: launches the browser once and closes it, starts the server and stops it', async () => {
    const { code, stdout, stderr, calls } = await doctor({ config: oneApp })
    assert.equal(code, 0, stderr)
    assert.equal(
      stdout,
      [
        '',
        `  web   chrome()                 ✓ Chrome 154.0.7195.41   ${chromePath}`,
        '        npm run dev              ✓ started, http://localhost:3000 answered after 2.1s, then stopped',
        '',
        '  Ready. 1 app, 1 target.',
        '',
      ].join('\n'),
    )
    assert.equal(calls.launches.length, 1)
    assert.deepEqual({ ...calls.launches[0], logFile: '' }, { executablePath: chromePath, headless: true, logFile: '' })
    assert.equal(calls.stops, 1)
    assert.deepEqual(calls.starts.map((start) => [start.name, start.start.command]), [['web', 'npm run dev']])
    const logFile = calls.launches[0]?.logFile ?? ''
    assert.ok(logFile.startsWith(`${doctorLogs}/`), `the logs are in the project's .retest/doctor, not the temporary folder: ${logFile}`)
    assert.equal(existsSync(doctorLogs), false, 'the logs of a clean check are removed, with the folder they were in')
  })

  test('a server that already answers is used and left running', async () => {
    const startAppServer: FakeOptions['startAppServer'] = async () => ({ status: 'reused', durationMs: 3, stop: async () => assert.fail('never stopped') })
    const { code, stdout } = await doctor({ config: oneApp, startAppServer })
    assert.equal(code, 0)
    assert.match(stdout, /\n {8}npm run dev {14}✓ already running, http:\/\/localhost:3000 answered\n/)
  })

  test('a missing browser is reported with its fix, and nothing is launched for it', async () => {
    const resolveExecutable: FakeOptions['resolveExecutable'] = () => ({
      ok: false,
      failure: { class: 'setup_failed', message: 'Google Chrome Beta is not installed. Retest looked in /Applications/Google Chrome Beta.app. Install it, or choose another target.' },
      tried: ['/Applications/Google Chrome Beta.app'],
    })
    const config = loadedConfig(project, { apps: { web: chrome({ channel: 'beta' }) } })
    const { code, stdout, calls } = await doctor({ config, resolveExecutable })
    assert.equal(code, 2)
    assert.equal(
      stdout,
      [
        '',
        "  web   chrome({ channel: 'beta' })   ✗ Google Chrome Beta is not installed. Retest looked in /Applications/Google Chrome Beta.app. Install it, or choose another target.",
        '',
        '  1 problem. Fix it and run npx retest doctor again.',
        '',
      ].join('\n'),
    )
    assert.equal(calls.launches.length, 0)
  })

  test('a browser that does not start points to its log, which is kept', async () => {
    const launchBrowser: FakeOptions['launchBrowser'] = async (launch) => {
      writeLog(launch.logFile)
      throw new LaunchError('The browser exited with code 1 before it answered.')
    }
    const { code, stdout } = await doctor({ config: oneApp, launchBrowser })
    assert.equal(code, 2)
    const fix = /\n {35}The browser's log is at (\S+)\.\n/.exec(stdout)
    assert.ok(fix !== null, stdout)
    assert.match(stdout, /✗ The browser exited with code 1 before it answered\.\n/)
    const logFile = fix[1] ?? ''
    assert.match(logFile, new RegExp(`^${doctorLogs}/\\d{4}-\\d\\d-\\d\\dT\\d\\d-\\d\\d-\\d\\d\\.\\d{3}Z/logs/browser-`))
    assert.equal(existsSync(logFile), true, 'the logs a fix points to are kept')
  })

  test('a problem whose fix names no log removes the logs all the same', async () => {
    const startAppServer: FakeOptions['startAppServer'] = async () => {
      throw new AppServerError({ class: 'setup_failed', message: 'The command npm run dev could not start.' })
    }
    const { code, calls } = await doctor({ config: oneApp, startAppServer })
    assert.equal(code, 2)
    assert.equal(calls.launches.length, 1, 'the browser wrote its log')
    assert.equal(existsSync(doctorLogs), false)
  })

  test('an app that never answers is reported with its fix', async () => {
    const startAppServer: FakeOptions['startAppServer'] = async (start) => {
      throw new AppServerError({ class: 'setup_failed', message: `The server for web did not answer at ${ready} within 60000 ms. Its output is in ${start.logFile}.` })
    }
    const { code, stdout } = await doctor({ config: oneApp, startAppServer })
    assert.equal(code, 2)
    assert.match(stdout, /\n {8}npm run dev {14}✗ The server for web did not answer at http:\/\/localhost:3000 within 60000 ms\. Its output is in \S+app-web-\w+\.log\.\n/)
    assert.match(stdout, /\n {35}Check start in the config: its command, and ready, the address that answers once the app is up\.\n/)
    assert.match(stdout, /\n {2}1 problem\. Fix it and run npx retest doctor again\.\n$/)
  })

  test('an app without start is asked at its base URL', async () => {
    const config = loadedConfig(project, { apps: { web: chromium({ baseUrl: 'https://staging.example.com' }) } })
    const answered = await doctor({ config })
    assert.match(answered.stdout, /\n {8}https:\/\/staging\.example\.com {3}✓ answered\n/)
    assert.deepEqual(answered.calls.probes, ['https://staging.example.com'])
    const silent = await doctor({ config, probeReady: async () => false })
    assert.equal(silent.code, 2)
    assert.match(silent.stdout, /✗ did not answer\n {40}Start the app, or add start to the config so Retest starts it\.\n/)
  })

  test('targets that share a browser launch it once, and each is listed with its call', async () => {
    const config = loadedConfig(project, {
      apps: {
        web: app({ targets: { chromium: chromium(), pixel: chromium({ emulate: 'Pixel 9' }), headed: chromium({ headless: false }) } }),
      },
    })
    const { code, stdout, calls } = await doctor({ config })
    assert.equal(code, 0)
    assert.equal(calls.launches.length, 2, 'once headless, once headed')
    assert.match(stdout, /\n {2}web {3}chromium\(\) {32}✓ Chrome/)
    assert.match(stdout, /\n {8}pixel: chromium\(\{ emulate: 'Pixel 9' \}\) {3}✓ Chrome/)
    assert.match(stdout, /\n {8}headed: chromium\(\{ headless: false \}\) {5}✓ Chrome/)
    assert.match(stdout, /\n {2}Ready\. 1 app, 3 targets\.\n$/)
  })

  test("names each target's proxy, which only a page's context uses, so the launch never checks it", async () => {
    const config = loadedConfig(project, {
      apps: {
        web: app({
          targets: {
            chrome: chrome({ proxy: { server: 'http://127.0.0.1:8080', bypass: ['<-loopback>', '*.internal'] } }),
            direct: chrome(),
          },
        }),
      },
    })
    const { code, stdout, calls } = await doctor({ config })
    assert.equal(code, 0)
    assert.equal(calls.launches.length, 1, 'the proxy is not a launch setting')
    assert.match(stdout, new RegExp(`\\n {2}web {3}chrome\\(\\) {17}✓ Chrome 154\\.0\\.7195\\.41 · proxy http://127\\.0\\.0\\.1:8080 · bypass <-loopback>, \\*\\.internal {3}${chromePath}\\n`))
    const direct = stdout.split('\n').find((line) => line.includes('direct: chrome()')) ?? ''
    assert.match(direct, /✓ Chrome 154\.0\.7195\.41 +\/Applications\//)
    assert.doesNotMatch(direct, /proxy/)
    const help = fakeCli({ cwd: project })
    await help.cli(['help', 'doctor'])
    assert.match(help.stdout.text, /A target with a proxy shows its address; the proxy itself is not checked\./)
  })

  test('checks each secret the environment supplies, and never calls a function source', async () => {
    const config = loadedConfig(project, {
      apps: { web: chromium() },
      secrets: { password: env('TEST_PASSWORD'), token: env('API_TOKEN'), code: () => assert.fail('never called') },
    })
    const { code, stdout } = await doctor({ config, env: { TEST_PASSWORD: 'hunter2' } })
    assert.equal(code, 2)
    assert.match(stdout, /\n {2}secrets {3}password {17}✓ TEST_PASSWORD is set\n/)
    assert.match(stdout, /\n {12}token {20}✗ The secret "token" reads API_TOKEN, which is not set\./)
    assert.doesNotMatch(stdout, /hunter2|code/)
  })

  // A server that prints its settings as it starts would otherwise write a secret into a log doctor keeps.
  test('gives each server it starts a redactor that already knows the environment secrets', async () => {
    const config = loadedConfig(project, {
      apps: { web: chrome({ baseUrl: ready, start: { command: 'npm run dev', ready } }) },
      secrets: { password: env('TEST_PASSWORD'), token: env('API_TOKEN'), code: () => assert.fail('never called') },
    })
    const { code, calls } = await doctor({ config, env: { TEST_PASSWORD: 'hunter2', API_TOKEN: 'abcd-1234' } })
    assert.equal(code, 0)
    const [start] = calls.starts
    assert.ok(start?.redactor !== undefined, 'the server writes its log through a redactor')
    assert.equal(start.redactor.redact('PASSWORD=hunter2 TOKEN=abcd-1234 CODE=code'), 'PASSWORD={{password}} TOKEN={{token}} CODE=code')
  })

  test('an interrupt stops the checks, removes their logs and exits 130', async () => {
    const controller = new AbortController()
    const launchBrowser: FakeOptions['launchBrowser'] = async (launch) => {
      writeLog(launch.logFile)
      controller.abort('SIGINT')
      return fakeBrowser(launch.executablePath)
    }
    const { code, stdout, calls } = await doctor({ config: oneApp, launchBrowser, signal: controller.signal })
    assert.equal(code, 130)
    assert.equal(stdout, '')
    assert.deepEqual(calls.starts, [], 'no server is started once interrupted')
    assert.equal(existsSync(doctorLogs), false)
  })

  test('without a config it says how to get one', async () => {
    const empty = temporaryFolder()
    const fake = fakeCli({ cwd: empty })
    assert.equal(await fake.cli(['doctor']), 2)
    assert.equal(
      fake.stderr.text,
      'error: doctor checks the browsers and apps in a config. No retest.config.ts here. Run npx retest init to write one.\nSee retest help doctor.\n',
    )
  })

  test('takes no files', async () => {
    const { code, stderr } = await doctor({ config: oneApp }, ['tests/a.retest.ts'])
    assert.equal(code, 2)
    assert.match(stderr, /doctor takes no files, received tests\/a\.retest\.ts\./)
  })
})
