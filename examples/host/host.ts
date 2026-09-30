import type { RetestEvent } from '@rehearsal-labs/retest/protocol'
import type { HostCheck, Reporter } from '@rehearsal-labs/retest/runner'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { chromium, defineConfig } from '@rehearsal-labs/retest'
import { defaultTimeouts, resolveSecrets, runFiles, validateConfig } from '@rehearsal-labs/retest/runner'

// A host: a program that runs Retest on its own machines, for an app someone else wrote. It builds the config in
// memory, gives every secret as a function, writes the test file itself, sends the browser through its own proxy,
// and adds checks the test cannot write. Run it from a project that has Retest installed:
//
//   node host.ts <app url> <proxy url> <outbox file> <run folder>
//
// RETEST_CHROMIUM names the browser. HOST_PASSWORD holds the test account's password, and HOST_TOKEN stands for the
// host's own credentials. The test process sees neither: it gets only the variables in testEnvironment.

const [appUrl = '', proxyUrl = '', outbox = '', outputDir = ''] = process.argv.slice(2)
const root = process.cwd()

function fromVault(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is not set.`)
  return value
}

// The label is the path relative paths start from. No file is behind it: the config lives only in this program.
const loaded = validateConfig(
  defineConfig({
    apps: { web: chromium({ baseUrl: appUrl, proxy: { server: proxyUrl, bypass: ['<-loopback>'] } }) },
    secrets: {
      password: () => fromVault('HOST_PASSWORD'),
      // Read on each fill: the one-time code the app sent last, which its outbox holds.
      code: () => readFileSync(outbox, 'utf8').trim(),
    },
  }),
  join(root, 'host.config.ts'),
)
if (!loaded.ok) throw new Error(loaded.failure.message)
const secrets = resolveSecrets(loaded.config, {})
if (!secrets.ok) throw new Error(secrets.failure.message)

// The host writes the test into a new folder inside the project, where the package resolves.
const folder = mkdtempSync(join(root, 'checkout-'))
writeFileSync(join(folder, 'checkout.retest.ts'), readFileSync(new URL('checkout.retest.ts', import.meta.url)))
const file = relative(root, join(folder, 'checkout.retest.ts')).split(sep).join('/')

// The parent runs these after the test's body, on the page the test left. The test passes only if they pass.
const hostChecks: Record<string, HostCheck[]> = {
  [file]: [
    { kind: 'address', origin: appUrl, path: '/', timeoutMs: 2000 },
    { kind: 'text', text: 'Release checklist' },
    { kind: 'text', text: 'Could not save', absent: true },
  ],
}

// Events come from the parent's memory as they happen. This host keeps them and forwards each as a JSON line.
const events: RetestEvent[] = []
const reporter: Reporter = {
  name: 'host',
  onEvent: (event) => {
    events.push(event)
    process.stdout.write(`${JSON.stringify(event)}\n`)
  },
  onRunEnd: () => undefined,
}

const stop = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort(signal))

const result = await runFiles(
  {
    files: [file],
    rootDir: root,
    apps: { kind: 'config', config: loaded.config, secrets: secrets.secrets },
    timeouts: defaultTimeouts,
    outputDir,
    headless: true,
    signal: stop.signal,
    hostChecks,
    testEnvironment: { CANARY: 'visible' },
  },
  [reporter],
)

// The result is the parent's too. The run folder holds copies, in a folder the test process can write.
const checked = events.filter((event) => event.type === 'host_check.passed').length
process.stderr.write(`${result.status}, exit ${result.exitCode}, ${checked} host checks passed\n`)
process.stderr.write(`result ${JSON.stringify(result)}\n`)
process.exitCode = result.exitCode
