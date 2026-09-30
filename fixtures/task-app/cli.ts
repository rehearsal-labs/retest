import { parseArgs } from 'node:util'
import { isTaskAppMode, MODES } from './modes.ts'
import { startTaskApp } from './server.ts'

const USAGE = `Usage: node fixtures/task-app/cli.ts [--mode <mode>] [--delay-ms <milliseconds>] [--require-header <name>] [--outbox <file>]
Modes: ${Object.keys(MODES).join(', ')}
--require-header refuses every request without that header, such as the one the fixture proxy adds.
--outbox writes each one-time code the app sends to that file, which then holds the last code sent.
`

try {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string', default: 'ok' },
      'delay-ms': { type: 'string' },
      'require-header': { type: 'string' },
      outbox: { type: 'string' },
    },
  })
  const { mode } = values
  if (!isTaskAppMode(mode)) throw new Error(`Unknown mode: ${mode}`)
  const delay = values['delay-ms']
  const header = values['require-header']
  const app = await startTaskApp({
    mode,
    ...(delay === undefined ? {} : { delayMs: /^\d+$/.test(delay) ? Number(delay) : Number.NaN }),
    ...(header === undefined ? {} : { requireHeader: header }),
    ...(values.outbox === undefined ? {} : { outbox: values.outbox }),
  })
  process.stdout.write(`${app.url}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
  process.exitCode = 2
}
