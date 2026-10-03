import type { LaunchOptions } from '../../src/browser/contract.ts'
import type { AppServerOptions } from '../../src/runner/app-server.ts'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { chromium, env } from '../../src/config/define.ts'
import { appLogFile } from '../../src/protocol/run-folder.ts'
import { startAppServer } from '../../src/runner/app-server.ts'
import { collectFiles } from '../../src/runner/run.ts'
import { tempProject } from '../support/project.ts'
import { fakeBrowser, fakeCli, loadedConfig } from './cli-fixtures.ts'

// The judge's variable is set in this process, so a process that is given this environment unfiltered would see it.
const variable = 'RETEST_UNIT_COMMANDS_JUDGE_KEY'
const key = 'judge-key-for-commands-5531'

before(() => {
  process.env[variable] = key
})

after(() => {
  delete process.env[variable]
})

const evaluation = { judges: { visual: { adapter: () => ({}), credentials: { apiKey: env(variable) }, accepts: ['text'] } } }

// A secret's variable, set in this process the same way.
const secretVariable = 'RETEST_UNIT_COMMANDS_SECRET'

before(() => {
  process.env[secretVariable] = 'secret-for-commands-7731'
})

after(() => {
  delete process.env[secretVariable]
})

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  assert.ok(address !== null && typeof address === 'object')
  return address.port
}

function filesUnder(folder: string): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true }).flatMap((entry) => (entry.isFile() ? [join(entry.parentPath, entry.name)] : []))
}

describe('doctor, with a judge whose credential is read from the environment', () => {
  // The server says whether it sees the variable, then prints the key as an app that read it elsewhere would, and fails,
  // so doctor keeps its log.
  const server = `process.stdout.write('the judge variable is ' + (process.env.${variable} === undefined ? 'absent' : 'present') + '\\n')
process.stdout.write('a key the server read elsewhere: ${key}\\n')
process.exit(1)
`

  async function doctor(withJudge: boolean): Promise<{ code: number; stdout: string; root: string; launches: LaunchOptions[]; starts: AppServerOptions[] }> {
    const root = tempProject({ 'retest.config.ts': '', 'server.mjs': server })
    const port = await freePort()
    const ready = `http://127.0.0.1:${port}/`
    const apps = { web: chromium({ baseUrl: ready, start: { command: 'node server.mjs', ready, timeoutMs: 5000 } }) }
    const config = loadedConfig(root, withJudge ? { apps, evaluation } : { apps })
    const launches: LaunchOptions[] = []
    const starts: AppServerOptions[] = []
    const fake = fakeCli({
      cwd: root,
      config,
      env: { [variable]: key },
      resolveExecutable: () => ({ ok: true, path: '/fake/chromium' }),
      launchBrowser: async (launch) => {
        launches.push(launch)
        return fakeBrowser(launch.executablePath)
      },
      startAppServer: async (options, timeoutMs) => {
        starts.push(options)
        return startAppServer(options, timeoutMs)
      },
    })
    const code = await fake.cli(['doctor'])
    return { code, stdout: fake.stdout.text, root, launches, starts }
  }

  function serverLog(root: string): string {
    const log = filesUnder(join(root, '.retest')).find((file) => file.endsWith(appLogFile('web')))
    assert.ok(log !== undefined, 'doctor kept the log of the server that failed')
    return readFileSync(log, 'utf8')
  }

  test('starts the server and the browser without the variable, and keeps a log with the key redacted', async () => {
    const checked = await doctor(true)
    assert.equal(checked.code, 2)
    const log = serverLog(checked.root)
    assert.match(log, /the judge variable is absent/)
    assert.match(log, /a key the server read elsewhere: \{\{visual\.apiKey\}\}/)
    assert.ok(!log.includes(key) && !checked.stdout.includes(key))
    assert.deepEqual(checked.starts.map((start) => start.hiddenVariables), [[variable]])
    assert.deepEqual(checked.launches.map((launch) => launch.hiddenVariables), [[variable]])
    for (const file of filesUnder(join(checked.root, '.retest'))) assert.ok(!readFileSync(file, 'utf8').includes(key), `${file} holds the key`)
  })

  test('without a judge the server sees the variable, so the check above can tell', async () => {
    const checked = await doctor(false)
    assert.match(serverLog(checked.root), /the judge variable is present/)
    assert.deepEqual(checked.starts.map((start) => start.hiddenVariables), [undefined])
  })
})

describe('list, with a judge whose credential is read from the environment', () => {
  async function seenByTestFile(withJudge: boolean): Promise<string> {
    const root = tempProject({})
    const seen = join(root, 'seen.txt')
    const file = `import { writeFileSync } from 'node:fs'
import { expect, test } from '@rehearsal-labs/retest'

writeFileSync(${JSON.stringify(seen)}, process.env.${variable} === undefined ? 'absent' : 'present')

test('a test', async () => {
  expect(1).toBe(1)
})
`
    const project = tempProject({ 'tests/a.retest.ts': file })
    const apps = { web: chromium({ baseUrl: 'http://127.0.0.1:4173' }) }
    const config = loadedConfig(project, withJudge ? { apps, evaluation } : { apps })
    const collected = await collectFiles({ files: ['tests/a.retest.ts'], rootDir: project, timeouts: { collection: 10000 }, config })
    assert.deepEqual(collected.files.map((each) => [each.collection, each.tests.length]), [['ok', 1]])
    return readFileSync(seen, 'utf8')
  }

  test("loads each test file in a process that never sees the judge's variable", async () => {
    assert.equal(await seenByTestFile(true), 'absent')
  })

  test('without a judge the test file sees the variable, so the check above can tell', async () => {
    assert.equal(await seenByTestFile(false), 'present')
  })
})

describe('list, with a secret whose value is read from the environment', () => {
  async function seenByTestFile(withSecret: boolean): Promise<string> {
    const root = tempProject({})
    const seen = join(root, 'seen.txt')
    const file = `import { writeFileSync } from 'node:fs'
import { expect, test } from '@rehearsal-labs/retest'

writeFileSync(${JSON.stringify(seen)}, process.env.${secretVariable} === undefined ? 'absent' : 'present')

test('a test', async () => {
  expect(1).toBe(1)
})
`
    const project = tempProject({ 'tests/a.retest.ts': file })
    const apps = { web: chromium({ baseUrl: 'http://127.0.0.1:4173' }) }
    const config = loadedConfig(project, withSecret ? { apps, secrets: { password: env(secretVariable) } } : { apps })
    const collected = await collectFiles({ files: ['tests/a.retest.ts'], rootDir: project, timeouts: { collection: 10000 }, config })
    assert.deepEqual(collected.files.map((each) => [each.collection, each.tests.length]), [['ok', 1]])
    return readFileSync(seen, 'utf8')
  }

  test("loads each test file in a process that never sees the secret's variable, as a run does", async () => {
    assert.equal(await seenByTestFile(true), 'absent')
  })

  test('without the secret the test file sees the variable, so the check above can tell', async () => {
    assert.equal(await seenByTestFile(false), 'present')
  })
})
