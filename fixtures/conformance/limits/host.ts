import type { Reporter } from '@rehearsal-labs/retest/runner'
import { defineConfig } from '@rehearsal-labs/retest'
import { resolveSecrets, runFiles, SessionBudget, validateConfig } from '@rehearsal-labs/retest/runner'
import { conformanceBaseUrl, conformanceTarget } from '../config.ts'

// Owner and host session limits, which a host sets through `runFiles`: two workers, and a budget of one session for
// the owner and one for the host, so the two holders in their two files never hold a page at once. The runner gives
// the run folder as the last argument and reads the events this prints, one JSON line each, and the result it
// prints on stderr, as the CLI harness reads any host's.

const outputDir = process.argv.at(-1) ?? ''
const loaded = validateConfig(defineConfig({ apps: { web: { ...conformanceTarget(), baseUrl: conformanceBaseUrl() } } }), `${process.cwd()}/host.config.ts`)
if (!loaded.ok) throw new Error(loaded.failure.message)
const secrets = resolveSecrets(loaded.config, {})
if (!secrets.ok) throw new Error(secrets.failure.message)
const reporter: Reporter = {
  name: 'host',
  onEvent: (event) => void process.stdout.write(`${JSON.stringify(event)}\n`),
  onRunEnd: () => undefined,
}
const result = await runFiles(
  {
    files: ['holds-one.retest.ts', 'holds-two.retest.ts'],
    rootDir: process.cwd(),
    apps: { kind: 'config', config: loaded.config, secrets: secrets.secrets },
    timeouts: { collection: 10_000, setup: 20_000, action: 1500, navigation: 5000, assertion: 1500, test: 20_000, cleanup: 5000 },
    outputDir,
    headless: true,
    signal: new AbortController().signal,
    workers: 2,
    sessions: { owner: 'conformance', budget: new SessionBudget({ perOwner: 1, host: 1 }), waitMs: 30_000 },
    lastRunFile: false,
  },
  [reporter],
)
process.stderr.write(`result ${JSON.stringify(result)}\n`)
process.exitCode = result.exitCode
