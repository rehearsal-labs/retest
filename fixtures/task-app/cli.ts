import { parseArgs } from 'node:util'
import { isTaskAppMode, MODES } from './modes.ts'
import { startTaskApp } from './server.ts'

const USAGE = `Usage: node fixtures/task-app/cli.ts [--mode <mode>] [--delay-ms <milliseconds>]
Modes: ${Object.keys(MODES).join(', ')}
`

try {
  const { values } = parseArgs({
    options: { mode: { type: 'string', default: 'ok' }, 'delay-ms': { type: 'string' } },
  })
  const { mode } = values
  if (!isTaskAppMode(mode)) throw new Error(`Unknown mode: ${mode}`)
  const delay = values['delay-ms']
  const app = await startTaskApp(
    delay === undefined ? { mode } : { mode, delayMs: /^\d+$/.test(delay) ? Number(delay) : Number.NaN },
  )
  process.stdout.write(`${app.url}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
  process.exitCode = 2
}
