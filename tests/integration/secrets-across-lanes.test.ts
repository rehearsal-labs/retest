import type { TestContext } from 'node:test'
import type { EvaluationRecord } from '../../src/protocol/evaluation.ts'
import type { HostRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { appLogFile } from '../../src/protocol/run-folder.ts'
import { openApp } from './browser-harness.ts'
import { appServerCommand, childLog, eventsOf, filesHolding, freePort, runCli, runHost, scratchFolder, testNamed, textHolds, writeProject } from './cli-harness.ts'

// One run on real Chrome that carries every credential Phase 1 handles at once: a proxy password a host put into
// the config it built itself (the config reader refuses one), two judge keys read from the variables the live
// provider gate uses, with made-up values and the fake judge behind each so no provider is called, and two host
// secrets the page sends everywhere a page can while diagnostics capture it. Then every file of the run folder, the
// host's output, `inspect` and the processes Retest started are checked for each value, whole and in parts.

const fakeJudge = fileURLToPath(new URL('../support/fake-evaluator.ts', import.meta.url))
const file = 'tests/secrets.retest.ts'
const name = 'sends two secrets everywhere a page can, then asks two judges'
const refused = 'opens nothing through a proxy that refuses the connection'
const variables = ['RETEST_EVALUATION_ANTHROPIC_KEY', 'RETEST_EVALUATION_OPENAI_KEY', 'RETEST_FABLE_PASSWORD', 'RETEST_FABLE_TOKEN'] as const

const credentials = {
  proxy: 'proxy-pass-9f3e2c7b1a',
  anthropic: 'sk-ant-fable-review-4d1c9e7a2b',
  openai: 'sk-openai-fable-review-7b3e5a9c1d',
  password: 'correct horse "battery\\ staple',
  // Long enough that Chrome cuts it in an object's preview, keeping its start and its end.
  token: `long-${'k7Qm2xWp9Lr4Zt8N'.repeat(8)}-${'end'.repeat(3)}`,
} as const

const tests = `import { expect, secret, test } from '@rehearsal-labs/retest'

test(${JSON.stringify(name)}, { apps: ['web', 'aside'] }, async ({ web }) => {
  for (const variable of ${JSON.stringify(variables)}) {
    console.log(variable + ' is ' + (process.env[variable] === undefined ? 'absent' : 'present') + ' in the test process')
  }
  await web.goto('/diagnostics/secrets')
  await web.getByTestId('secret').fill(secret('password'))
  await web.getByTestId('token').fill(secret('token'))
  await web.getByTestId('send').click()
  await expect(web.getByTestId('status')).toHaveText('Sent')
  await test.evaluate({ judge: 'anthropic', mode: 'advisory', requirement: { 'blocked-secret': 'The page shows what was typed.' }, evidence: { app: 'web', capture: 'screenshot' } })
  await web.goto('/')
  await expect(web.getByTestId('task-title')).toBeVisible()
  await test.evaluate({ judge: 'anthropic', requirement: { 'echo-secret': 'The fresh safe page shows the task-title field.' }, evidence: { app: 'web', capture: 'screenshot' } })
  await test.evaluate({ judge: 'openai', requirement: { 'echo-revision': 'The reply is polite.' }, evidence: { text: 'Thank you.' } })
})

test(${JSON.stringify(refused)}, { apps: ['through'] }, async ({ through }) => {
  await through.goto('/')
})
`

// The host program reads what varies from `host-input.json` beside it, so the proxy password is in no process's
// environment but through the config the host builds, and only the four variables above reach its environment.
const host = `import type { Reporter } from '@rehearsal-labs/retest/runner'
import { readFileSync } from 'node:fs'
import { chrome, defineConfig, env } from '@rehearsal-labs/retest'
import { resolveSecrets, runFiles, validateConfig } from '@rehearsal-labs/retest/runner'

const outputDir = process.argv.at(-1) ?? ''
const input = JSON.parse(readFileSync('host-input.json', 'utf8'))
const judge = (variable: string) => ({ adapter: './judges/fake.ts', credentials: { apiKey: env(variable) }, options: { log: input.judgeLog }, accepts: ['text', 'images'] })
const loaded = validateConfig(
  defineConfig({
    apps: {
      web: chrome({ baseUrl: input.appUrl }),
      through: chrome({ baseUrl: input.appUrl }),
      aside: chrome({ baseUrl: input.asideUrl, start: { command: input.asideCommand, ready: input.asideUrl } }),
    },
    defaultApp: 'web',
    secrets: { password: env('RETEST_FABLE_PASSWORD'), token: env('RETEST_FABLE_TOKEN') },
    evaluation: { judges: { anthropic: judge('RETEST_EVALUATION_ANTHROPIC_KEY'), openai: judge('RETEST_EVALUATION_OPENAI_KEY') }, timeoutMs: 10000 },
  }),
  \`\${process.cwd()}/host.config.ts\`,
)
if (!loaded.ok) throw new Error(loaded.failure.message)
// The config reader refuses a proxy address with a password in it, so a host that wants one puts it in afterwards.
const withProxy = (app: string, server: string, bypass: string[]) => {
  const found = loaded.config.apps.get(app)
  if (found === undefined) throw new Error(\`the config has no app \${app}\`)
  const targets = new Map([...found.targets].map(([key, target]) => [key, { ...target, proxy: { server, bypass } }]))
  return [app, { ...found, targets }] as const
}
const config = { ...loaded.config, apps: new Map([...loaded.config.apps, withProxy('web', input.proxyServer, []), withProxy('through', input.closedProxyServer, ['<-loopback>'])]) }
const secrets = resolveSecrets(config, process.env)
if (!secrets.ok) throw new Error(secrets.failure.message)
const reporter: Reporter = {
  name: 'host',
  onEvent: (event) => void process.stdout.write(\`\${JSON.stringify(event)}\\n\`),
  onRunEnd: () => undefined,
}
const result = await runFiles(
  {
    files: [${JSON.stringify(file)}],
    rootDir: process.cwd(),
    apps: { kind: 'config', config, secrets: secrets.secrets },
    timeouts: { collection: 5000, setup: 15000, action: 5000, navigation: 10000, assertion: 5000, test: 30000, cleanup: 5000 },
    outputDir,
    headless: true,
    signal: new AbortController().signal,
    hostEvaluations: { ${JSON.stringify(file)}: [{ id: 'host-greeting', judge: 'openai', criteria: { 'echo-secret': 'The greeting is polite.' }, evidence: { text: 'Hello there.' } }] },
  },
  [reporter],
)
process.stderr.write(\`result \${JSON.stringify(result)}\\n\`)
process.exitCode = result.exitCode
`

/** Every run of ten characters of a value: the parts a cut could leave behind. */
function windows(value: string): string[] {
  return Array.from({ length: value.length - 9 }, (_, index) => value.slice(index, index + 10))
}

// Where a credential may not be, by name: nowhere in the run folder, as it is, as JSON escapes it or in any part of
// ten characters, and not in `text` either.
function assertNoneOf(run: HostRun, text: string, where: string): void {
  for (const [label, value] of Object.entries(credentials)) {
    assert.deepEqual(filesHolding(run.output, value), [], `no file in the run folder holds the ${label} credential`)
    assert.deepEqual(filesHolding(run.output, JSON.stringify(value).slice(1, -1)), [], `nor in the form JSON escapes the ${label} credential`)
    const left = windows(value).filter((part) => filesHolding(run.output, part).length > 0)
    assert.deepEqual(left, [], `no part of the ${label} credential is left in the run folder`)
    assert.equal(textHolds(text, value), false, `${where} holds no ${label} credential`)
  }
}

async function inspectOutput(t: TestContext, root: string, args: readonly string[]): Promise<string> {
  const shown = await runCli(t, ['inspect', ...args], { cwd: root })
  assert.equal(shown.exit.code, 0, shown.stderr)
  return `${shown.stdout}\n${shown.stderr}`
}

test('a proxy password, two judge keys and two typed secrets reach no file, no report, no inspect output and no process Retest starts', async (t) => {
  const app = await openApp(t)
  const asidePort = await freePort()
  const asideUrl = `http://127.0.0.1:${asidePort}`
  const proxyPort = await freePort()
  const closedPort = await freePort()
  const judgeLog = join(await scratchFolder(t, 'retest-judge-'), 'fake.jsonl')
  const root = await writeProject(t, {
    'package.json': '{ "type": "module" }\n',
    'host.ts': host,
    'host-input.json': `${JSON.stringify({
      appUrl: app.url,
      asideUrl,
      asideCommand: appServerCommand(asidePort, { printEnv: 'RETEST_EVALUATION_ANTHROPIC_KEY' }),
      // Chrome sends loopback addresses around a proxy unless the bypass rules hold `<-loopback>`, so the pages load
      // from the task app while the context carries the address with its password.
      proxyServer: `http://ada:${credentials.proxy}@127.0.0.1:${proxyPort}`,
      // Sent through on purpose, to a port nothing listens on, so the navigation fails and names the proxy.
      closedProxyServer: `http://ada:${credentials.proxy}@127.0.0.1:${closedPort}`,
      judgeLog,
    })}\n`,
    'judges/fake.ts': `export { default } from ${JSON.stringify(fakeJudge)}\n`,
    [file]: tests,
  })
  const run = await runHost(t, {
    cwd: root,
    command: [process.execPath, '--conditions=retest-source', 'host.ts'],
    env: {
      RETEST_EVALUATION_ANTHROPIC_KEY: credentials.anthropic,
      RETEST_EVALUATION_OPENAI_KEY: credentials.openai,
      RETEST_FABLE_PASSWORD: credentials.password,
      RETEST_FABLE_TOKEN: credentials.token,
    },
  })

  // The first test passed whole, so every path below was taken: the proxy context, the typed secrets, both judges,
  // the host's check and a complete capture. The second failed through its proxy, as the setup it is.
  assert.equal(run.exit.code, 2, run.stderr)
  const result = testNamed(run, name)
  assert.equal(result.status, 'passed', result.failure?.message)
  const through = testNamed(run, refused)
  assert.deepEqual([through.status, through.failure?.class], ['error', 'setup_failed'])
  // Chrome refuses a proxy address with a user name in it before it connects, so the error is that it has no usable
  // proxy, and the failure still names the address alone.
  assert.equal(through.failure?.message, `Could not open ${app.url}/ through the proxy http://127.0.0.1:${closedPort}/: net::ERR_NO_SUPPORTED_PROXIES. The proxy failed, not the app.`)
  assert.equal(through.failure?.details?.['proxy'], `http://127.0.0.1:${closedPort}/`)
  const evaluations: EvaluationRecord[] = result.evaluations ?? []
  assert.deepEqual(
    evaluations.map((each) => [each.checkId, each.source, each.judge, each.verdict]),
    [
      ['evaluation-1', 'test', 'anthropic', 'error'],
      ['evaluation-2', 'test', 'anthropic', 'pass'],
      ['evaluation-3', 'test', 'openai', 'pass'],
      ['host-greeting', 'host', 'openai', 'pass'],
    ],
  )
  assert.equal(evaluations[0]?.reason, 'Retest withheld this capture of web by policy: the secret "password" was typed into a field Retest could not read, and the field had not been seen to stop showing it.')
  assert.deepEqual(evaluations[0]?.evidence, [], 'the refused secret scene supplies no pixels to the judge')
  const web = result.diagnostics?.find((summary) => summary.app === 'web')
  assert.ok(web?.path !== undefined && web.console.state === 'complete' && web.network.state === 'complete', JSON.stringify(result.diagnostics))

  // Each judge was set up in the host's process with the key its variable holds, and echoed it back.
  const entries: unknown[] = readFileSync(judgeLog, 'utf8').split('\n').filter((line) => line !== '').map((line): unknown => JSON.parse(line))
  const setups = entries.flatMap((entry) => at(entry, ['setup']) ?? [])
  assert.deepEqual(setups.map((setup) => [at(setup, ['judge']), at(setup, ['credentials', 'apiKey'])]).sort(), [['anthropic', credentials.anthropic], ['openai', credentials.openai]])

  // What the judges echoed is written as the credential's name: in a justification, in a model revision the record
  // and the evaluator's identity carry, and in the host check's justification.
  assert.match(evaluations[1]?.justification ?? '', /\{\{anthropic\.apiKey\}\}/)
  assert.equal(evaluations[2]?.evaluator?.modelRevision, 'proxy-for-{{openai.apiKey}}')
  assert.match(evaluations[3]?.justification ?? '', /\{\{openai\.apiKey\}\}/)

  // The proxy is recorded without its user name or password, in the browser's start and in the execution record.
  const browsers = eventsOf(run.events, 'browser.started')
  assert.ok(browsers.length > 0)
  for (const event of browsers) {
    const server = event.target?.proxy?.server
    if (server === undefined) continue
    assert.ok(server.startsWith('http://127.0.0.1:') && !server.includes('ada'), `the browser's proxy is recorded as its address alone: ${server}`)
  }
  const started = eventsOf(run.events, 'test.started').find((event) => event.attemptId === result.attemptId)
  const recorded = started?.execution?.configuration.settings.apps['web']?.proxy?.server
  assert.ok(recorded !== undefined && recorded.startsWith('http://127.0.0.1:') && !recorded.includes('ada'), `the execution record keeps the address alone: ${recorded}`)
  assert.deepEqual(result.execution?.configuration, started?.execution?.configuration, 'result.json carries the same configuration')

  // The typed secrets are in the artifact as their names, so what follows is redaction, not absence.
  const artifact = readFileSync(join(run.output, web.path), 'utf8')
  assert.ok(artifact.includes('"the secret is {{password}}"'), 'the console message names the secret')
  assert.ok(artifact.includes('/diagnostics/echo/{{password}}'), 'the request path names the secret')
  assert.ok(artifact.includes(JSON.stringify('{token: (cut), note: (cut), quoted: "{{password}}"}')), 'a preview Chrome cut is written (cut), none of it kept')

  // No credential, whole or in part, in the run folder, nor in what the host printed: its events and its result.
  assertNoneOf(run, `${run.stdout}\n${run.stderr}`, 'the host output')

  // Nor in what `inspect` shows of the folder: the summary, the test's timeline with its checks and records, and the JSON.
  assertNoneOf(run, await inspectOutput(t, root, [run.output]), 'inspect')
  assertNoneOf(run, await inspectOutput(t, root, [run.output, '--test', result.testId]), 'inspect --test')
  assertNoneOf(run, await inspectOutput(t, root, [run.output, '--json']), 'inspect --json')

  // The variables the keys and the secrets were read from reach neither the test file's process nor the app server
  // Retest started: the server prints the judge's variable empty, not written as a name, so it was withheld, not redacted.
  const log = childLog(run, file)
  for (const variable of variables) assert.ok(log.includes(`${variable} is absent in the test process`), log)
  const aside = readFileSync(join(run.output, appLogFile('aside')), 'utf8')
  assert.match(aside, /^RETEST_EVALUATION_ANTHROPIC_KEY=$/m, aside)
})

// A value inside parsed JSON, by keys and indexes, or undefined when the path does not lead anywhere.
function at(value: unknown, path: readonly (string | number)[]): unknown {
  let current: unknown = value
  for (const step of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = Reflect.get(current, step)
  }
  return current
}
